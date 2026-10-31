import { adminPage } from "./admin";

interface Env {
  DB: D1Database;
  ADMIN_TOKEN: string;
  /** Secret upstream paid-panel URLs; never returned to clients or stored in D1. */
  V2RAY_SOURCE_URL?: string;
  AETHER_SOURCE_URL?: string;
  EMERGENCY_SOURCE_URL?: string;
}

type SubscriptionRow = {
  id: string;
  key_prefix: string;
  customer_label: string;
  status: "active" | "revoked";
  created_at: number;
  updated_at: number;
  expires_at: number;
};

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "Content-Type, Authorization");
  headers.set("access-control-max-age", "86400");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function isAdmin(request: Request, env: Env): boolean {
  const auth = request.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") && auth.slice(7) === env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 32;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function cleanLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  if (!label || label.length > 120) return null;
  return label;
}

function durationDays(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 3650) return null;
  return value;
}

function expiryFromBody(body: Record<string, unknown>, now: number): number | null {
  const days = durationDays(body.durationDays);
  if (days !== null) return now + days * 24 * 60 * 60 * 1000;
  if (typeof body.expiresAt === "string") {
    const parsed = Date.parse(body.expiresAt);
    if (Number.isFinite(parsed) && parsed > now) return parsed;
  }
  return null;
}

function publicStatus(row: SubscriptionRow, now: number) {
  if (row.status === "revoked") return "revoked";
  if (row.expires_at <= now) return "expired";
  return "active";
}



async function requireActiveSubscription(
  request: Request,
  env: Env,
): Promise<{ authorized: true } | { authorized: false; response: Response }> {
  const authorization = request.headers.get("authorization") ?? "";
  const key = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!/^pc_[a-f0-9]{64}$/.test(key)) {
    return {
      authorized: false,
      response: json({ valid: false, status: "invalid" }, 401),
    };
  }

  const keyHash = await sha256Hex(key);
  const row = await env.DB.prepare(
    "SELECT id, key_prefix, customer_label, status, created_at, updated_at, expires_at FROM subscriptions WHERE key_hash = ? LIMIT 1"
  ).bind(keyHash).first<SubscriptionRow>();

  if (!row) {
    return {
      authorized: false,
      response: json({ valid: false, status: "invalid" }, 403),
    };
  }

  const status = publicStatus(row, Date.now());
  if (status !== "active") {
    return {
      authorized: false,
      response: json({
        valid: false,
        status,
        expiresAt: new Date(row.expires_at).toISOString(),
      }, 403),
    };
  }

  return { authorized: true };
}

async function proxyPrivateFeed(
  configuredSource: string | undefined,
  label: string,
  allowEmpty: boolean,
): Promise<Response> {
  const source = configuredSource?.trim();
  if (!source) return json({ error: `${label} source is not configured` }, 503);

  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(source);
  } catch {
    return json({ error: `${label} source configuration is invalid` }, 503);
  }
  if (upstreamUrl.protocol !== "https:") {
    return json({ error: `${label} source must use HTTPS` }, 503);
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl.toString(), {
      headers: { Accept: "text/plain, application/octet-stream;q=0.9, */*;q=0.1" },
      redirect: "follow",
    });
  } catch {
    return json({ error: `${label} source is temporarily unavailable` }, 502);
  }

  if (!upstream.ok) {
    return json({ error: `${label} source is temporarily unavailable` }, 502);
  }
  if (upstream.url) {
    try {
      if (new URL(upstream.url).protocol !== "https:") {
        return json({ error: `${label} source redirect is not HTTPS` }, 502);
      }
    } catch {
      return json({ error: `${label} source redirect is invalid` }, 502);
    }
  }

  let body: string;
  try {
    body = await upstream.text();
  } catch {
    return json({ error: `${label} source response could not be read` }, 502);
  }
  if (body.length > 1_000_000) {
    return json({ error: `${label} source response is too large` }, 502);
  }
  if (!allowEmpty && !body.trim()) {
    return json({ error: `${label} source returned an empty feed` }, 502);
  }

  // For primary feeds, HTTP success with an empty body is deliberately preserved as
  // HTTP 200 + empty text so the app can clear only that source's own group.
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method === "GET" && path === "/health") {
    return json({ ok: true, service: "parscloud-subscription-server", time: Date.now() });
  }

  const primaryFeedMatch = path.match(/^\/v1\/primary-feed\/(v2ray|aether)$/);
  if (request.method === "GET" && primaryFeedMatch) {
    const authorization = await requireActiveSubscription(request, env);
    if (!authorization.authorized) return authorization.response;

    const sourceUrl = primaryFeedMatch[1] === "v2ray"
      ? env.V2RAY_SOURCE_URL
      : env.AETHER_SOURCE_URL;
    return proxyPrivateFeed(sourceUrl, primaryFeedMatch[1], true);
  }

  // The emergency source is authenticated too. The app should request it only after
  // both primary sources have independently failed their freshness/usability checks.
  if (request.method === "GET" && path === "/v1/fallback-config") {
    const authorization = await requireActiveSubscription(request, env);
    if (!authorization.authorized) return authorization.response;
    return proxyPrivateFeed(env.EMERGENCY_SOURCE_URL, "Emergency", false);
  }

  if (request.method === "GET" && path === "/admin") {
    return new Response(adminPage, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
  }

  if (request.method === "POST" && path === "/v1/validate") {
    const body = await readJson(request);
    const key = body?.subscriptionKey;
    if (typeof key !== "string" || !/^pc_[a-f0-9]{64}$/.test(key)) {
      return json({ valid: false, status: "invalid", message: "Invalid subscription key format" }, 400);
    }
    const keyHash = await sha256Hex(key);
    const row = await env.DB.prepare(
      "SELECT id, key_prefix, customer_label, status, created_at, updated_at, expires_at FROM subscriptions WHERE key_hash = ? LIMIT 1"
    ).bind(keyHash).first<SubscriptionRow>();

    if (!row) return json({ valid: false, status: "invalid" }, 200);
    const status = publicStatus(row, Date.now());
    return json({
      valid: status === "active",
      status,
      subscriptionId: row.id,
      expiresAt: new Date(row.expires_at).toISOString(),
      serverTime: new Date().toISOString(),
    });
  }

  if (!path.startsWith("/admin/")) return json({ error: "Not found" }, 404);
  if (!isAdmin(request, env)) return json({ error: "Unauthorized" }, 401);

  if (request.method === "POST" && path === "/admin/subscriptions") {
    const body = await readJson(request);
    if (!body) return json({ error: "Expected a JSON object" }, 400);
    const customerLabel = cleanLabel(body.customerLabel);
    const expiresAt = expiryFromBody(body, Date.now());
    if (!customerLabel || expiresAt === null) {
      return json({ error: "Provide customerLabel and either durationDays (1-3650) or a future expiresAt date" }, 400);
    }

    const rawKey = `pc_${randomHex(32)}`;
    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO subscriptions (id, key_hash, key_prefix, customer_label, status, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)"
    ).bind(id, await sha256Hex(rawKey), rawKey.slice(0, 11), customerLabel, now, now, expiresAt).run();

    return json({
      created: true,
      subscription: {
        id,
        customerLabel,
        status: "active",
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        subscriptionKey: rawKey,
      },
      warning: "Save this subscription key now. It cannot be retrieved later.",
    }, 201);
  }

  if (request.method === "GET" && path === "/admin/subscriptions") {
    const requestedLimit = Number(url.searchParams.get("limit") ?? "50");
    const limit = Number.isInteger(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 50;
    const result = await env.DB.prepare(
      "SELECT id, key_prefix, customer_label, status, created_at, updated_at, expires_at FROM subscriptions ORDER BY created_at DESC LIMIT ?"
    ).bind(limit).all<SubscriptionRow>();
    return json({
      subscriptions: (result.results ?? []).map((row) => ({
        id: row.id,
        keyPrefix: row.key_prefix,
        customerLabel: row.customer_label,
        status: publicStatus(row, Date.now()),
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
        expiresAt: new Date(row.expires_at).toISOString(),
      })),
    });
  }

  const renewMatch = path.match(/^\/admin\/subscriptions\/([0-9a-f-]{36})\/renew$/i);
  if (request.method === "POST" && renewMatch) {
    const body = await readJson(request);
    const days = durationDays(body?.durationDays);
    if (days === null) return json({ error: "durationDays must be an integer from 1 to 3650" }, 400);
    const id = renewMatch[1];
    const row = await env.DB.prepare(
      "SELECT id, expires_at, status FROM subscriptions WHERE id = ? LIMIT 1"
    ).bind(id).first<{ id: string; expires_at: number; status: string }>();
    if (!row) return json({ error: "Subscription not found" }, 404);
    if (row.status === "revoked") return json({ error: "Revoked subscriptions must be recreated, not renewed" }, 409);
    const now = Date.now();
    const expiresAt = Math.max(now, row.expires_at) + days * 24 * 60 * 60 * 1000;
    await env.DB.prepare("UPDATE subscriptions SET expires_at = ?, updated_at = ? WHERE id = ?")
      .bind(expiresAt, now, id).run();
    return json({ renewed: true, id, expiresAt: new Date(expiresAt).toISOString() });
  }

  const revokeMatch = path.match(/^\/admin\/subscriptions\/([0-9a-f-]{36})\/revoke$/i);
  if (request.method === "POST" && revokeMatch) {
    const id = revokeMatch[1];
    const now = Date.now();
    const result = await env.DB.prepare(
      "UPDATE subscriptions SET status = 'revoked', updated_at = ? WHERE id = ?"
    ).bind(now, id).run();
    if (!result.meta.changes) return json({ error: "Subscription not found" }, 404);
    return json({ revoked: true, id });
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return withCors(await handle(request, env));
    } catch {
      return withCors(json({ error: "Internal server error" }, 500));
    }
  },
};
