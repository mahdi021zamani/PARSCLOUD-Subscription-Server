import { adminPage } from "./admin";

interface Env {
  DB: D1Database;
  ADMIN_TOKEN: string;
  /** Secret upstream paid-panel URLs; never returned to clients or stored in D1. */
  V2RAY_SOURCE_URL?: string;
  AETHER_SOURCE_URL?: string;
  /** Fine-grained GitHub token with Contents: read on parscloud-sub only. */
  AETHER_GITHUB_TOKEN?: string;
  DEVICE_LIMITS_ENFORCED?: string;
}

type SubscriptionRow = {
  id: string;
  key_prefix: string;
  customer_label: string;
  status: "active" | "revoked";
  created_at: number;
  updated_at: number;
  expires_at: number;
  max_devices: number;
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

function maxDevices(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100 ? value : null;
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

  // Reject partial-content and unusual success statuses: a truncated feed must never
  // be interpreted as a complete replacement. 200 and 204 are the only accepted outcomes.
  if (upstream.status !== 200 && upstream.status !== 204) {
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


/**
 * Reads the private Aether feed through GitHub's Contents API.
 * The configured URL is pinned to the expected repository/file; credentials are
 * sent only to api.github.com and redirects are not followed.
 */
async function proxyAetherGithubFeed(
  configuredSource: string | undefined,
  githubToken: string | undefined,
): Promise<Response> {
  const source = configuredSource?.trim();
  const token = githubToken?.trim();
  if (!source || !token) {
    return json({ error: "Aether GitHub source is not configured" }, 503);
  }

  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(source);
  } catch {
    return json({ error: "Aether GitHub source configuration is invalid" }, 503);
  }

  if (
    upstreamUrl.protocol !== "https:" ||
    upstreamUrl.hostname !== "api.github.com" ||
    upstreamUrl.pathname !== "/repos/mahdi021zamani/parscloud-sub/contents/Aether" ||
    upstreamUrl.searchParams.get("ref") !== "main" ||
    [...upstreamUrl.searchParams.keys()].some((key) => key !== "ref")
  ) {
    return json({ error: "Aether GitHub source must target the approved private feed" }, 503);
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "manual",
    });
  } catch {
    return json({ error: "Aether GitHub source is temporarily unavailable" }, 502);
  }

  // Never follow a redirect with the private-repository credential.
  if (upstream.status !== 200) {
    return json({ error: "Aether GitHub source is temporarily unavailable" }, 502);
  }

  let payload: unknown;
  try {
    const responseText = await upstream.text();
    if (responseText.length > 1_500_000) {
      return json({ error: "Aether GitHub response is too large" }, 502);
    }
    payload = JSON.parse(responseText);
  } catch {
    return json({ error: "Aether GitHub response is invalid" }, 502);
  }

  if (!payload || typeof payload !== "object") {
    return json({ error: "Aether GitHub file response is invalid" }, 502);
  }
  const file = payload as { type?: unknown; path?: unknown; encoding?: unknown; content?: unknown; size?: unknown };
  if (
    file.type !== "file" ||
    file.path !== "Aether" ||
    file.encoding !== "base64" ||
    typeof file.content !== "string" ||
    typeof file.size !== "number" ||
    !Number.isInteger(file.size) ||
    file.size < 0 ||
    file.size > 1_000_000
  ) {
    return json({ error: "Aether GitHub file metadata is invalid" }, 502);
  }

  let body: string;
  try {
    const binary = atob(file.content.replace(/\s/g, ""));
    if (binary.length > 1_000_000 || binary.length !== file.size) {
      return json({ error: "Aether GitHub file size is invalid" }, 502);
    }
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return json({ error: "Aether GitHub file encoding is invalid" }, 502);
  }

  // An empty file is an intentional empty primary feed and must clear only Aether.
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

type DeviceChallengeRow = { id:string; public_key_hash:string; challenge:string; expires_at:number; used_at:number|null };
type DeviceRow = { id:string; public_key_hash:string; created_at:number; last_seen_at:number; revoked_at:number|null };

function decodeBase64(value:string):Uint8Array {
  const normalized=value.replace(/-/g,"+").replace(/_/g,"/");
  const binary=atob(normalized+"=".repeat((4-normalized.length%4)%4));
  return Uint8Array.from(binary,c=>c.charCodeAt(0));
}
function ecdsaDerToRaw(der:Uint8Array):Uint8Array|null {
  try {
    let p=0;
    if(der[p++]!==0x30)return null;
    let seq=der[p++];
    if(seq&0x80){const n=seq&0x7f;if(n<1||n>2)return null;seq=0;for(let i=0;i<n;i++)seq=(seq<<8)|der[p++];}
    if(p+seq!==der.length||der[p++]!==0x02)return null;
    const rl=der[p++],r=der.slice(p,p+rl);p+=rl;
    if(der[p++]!==0x02)return null;
    const sl=der[p++],sv=der.slice(p,p+sl);
    const norm=(v:Uint8Array)=>{while(v.length>32&&v[0]===0)v=v.slice(1);if(v.length>32)return null;const o=new Uint8Array(32);o.set(v,32-v.length);return o;};
    const rr=norm(r),ss=norm(sv);if(!rr||!ss)return null;
    const out=new Uint8Array(64);out.set(rr);out.set(ss,32);return out;
  } catch { return null; }
}
async function verifyDeviceProof(publicKey:string,challenge:string,signature:string):Promise<boolean>{
  try{
    const sig=ecdsaDerToRaw(decodeBase64(signature));if(!sig)return false;
    const key=await crypto.subtle.importKey("spki",decodeBase64(publicKey),{name:"ECDSA",namedCurve:"P-256"},false,["verify"]);
    return await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},key,sig,new TextEncoder().encode(challenge));
  }catch{return false;}
}
async function issueDeviceChallenge(request:Request,env:Env):Promise<Response>{
  const body=await readJson(request),key=body?.subscriptionKey,publicKey=body?.devicePublicKey;
  if(typeof key!=="string"||!/^pc_[a-f0-9]{64}$/.test(key)||typeof publicKey!=="string"||publicKey.length<80||publicKey.length>2048)
    return json({valid:false,status:"invalid_device_request"},400);
  const keyHash=await sha256Hex(key);
  const sub=await env.DB.prepare("SELECT id,status,expires_at FROM subscriptions WHERE key_hash=? LIMIT 1").bind(keyHash).first<{id:string;status:string;expires_at:number}>();
  if(!sub||sub.status!=="active"||sub.expires_at<=Date.now())return json({valid:false,status:sub?.status==="revoked"?"revoked":"expired"},403);
  try{await crypto.subtle.importKey("spki",decodeBase64(publicKey),{name:"ECDSA",namedCurve:"P-256"},false,["verify"]);}
  catch{return json({valid:false,status:"invalid_device_key"},400);}
  const now=Date.now(),challenge=randomHex(32),challengeId=crypto.randomUUID(),expiresAt=now+300000;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM device_challenges WHERE expires_at<=? OR created_at<?").bind(now,now-86400000),
    env.DB.prepare("INSERT INTO device_challenges (id,subscription_id,public_key_hash,challenge,created_at,expires_at) VALUES (?,?,?,?,?,?)").bind(challengeId,sub.id,await sha256Hex(publicKey),challenge,now,expiresAt)
  ]);
  return json({challengeId,challenge,expiresAt:new Date(expiresAt).toISOString(),serverTime:new Date(now).toISOString()});
}
async function registerDevice(env:Env,subscriptionId:string,publicKey:string,challengeId:string,signature:string):Promise<{ok:true;deviceCount:number;maxDevices:number}|{ok:false;status:string;deviceCount?:number;maxDevices?:number}>{
  if(publicKey.length<80||publicKey.length>2048||challengeId.length>64||signature.length>512)return{ok:false,status:"invalid_device_proof"};
  const publicKeyHash=await sha256Hex(publicKey),now=Date.now();
  const challenge=await env.DB.prepare("SELECT id,public_key_hash,challenge,expires_at,used_at FROM device_challenges WHERE id=? AND subscription_id=? LIMIT 1").bind(challengeId,subscriptionId).first<DeviceChallengeRow>();
  if(!challenge||challenge.used_at!==null||challenge.expires_at<=now||challenge.public_key_hash!==publicKeyHash)return{ok:false,status:"invalid_device_proof"};
  if(!(await verifyDeviceProof(publicKey,challenge.challenge,signature)))return{ok:false,status:"invalid_device_proof"};
  const id=crypto.randomUUID();
  const results=await env.DB.batch([
    env.DB.prepare("UPDATE device_challenges SET used_at=? WHERE id=? AND subscription_id=? AND public_key_hash=? AND used_at IS NULL AND expires_at>?").bind(now,challengeId,subscriptionId,publicKeyHash,now),
    env.DB.prepare("UPDATE subscription_devices SET last_seen_at=? WHERE subscription_id=? AND public_key_hash=? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM device_challenges WHERE id=? AND used_at=?)").bind(now,subscriptionId,publicKeyHash,challengeId,now),
    env.DB.prepare("INSERT INTO subscription_devices (id,subscription_id,public_key_hash,public_key,created_at,last_seen_at) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM device_challenges WHERE id=? AND used_at=?) AND NOT EXISTS (SELECT 1 FROM subscription_devices WHERE subscription_id=? AND public_key_hash=?) AND (SELECT COUNT(*) FROM subscription_devices WHERE subscription_id=? AND revoked_at IS NULL)<(SELECT max_devices FROM subscriptions WHERE id=? AND status='active' AND expires_at>?)").bind(id,subscriptionId,publicKeyHash,publicKey,now,now,challengeId,now,subscriptionId,publicKeyHash,subscriptionId,subscriptionId,now)
  ]);
  if(!results[0]?.meta?.changes)return{ok:false,status:"invalid_device_proof"};
  const device=await env.DB.prepare("SELECT id,public_key_hash,created_at,last_seen_at,revoked_at FROM subscription_devices WHERE subscription_id=? AND public_key_hash=? LIMIT 1").bind(subscriptionId,publicKeyHash).first<DeviceRow>();
  const sub=await env.DB.prepare("SELECT max_devices FROM subscriptions WHERE id=? LIMIT 1").bind(subscriptionId).first<{max_devices:number}>();
  const max=sub?.max_devices??1;
  if(device&&device.revoked_at!==null)return{ok:false,status:"device_revoked",deviceCount:0,maxDevices:max};
  const countRow=await env.DB.prepare("SELECT COUNT(*) AS count FROM subscription_devices WHERE subscription_id=? AND revoked_at IS NULL").bind(subscriptionId).first<{count:number}>();
  const count=countRow?.count??0;
  if(device)return{ok:true,deviceCount:count,maxDevices:max};
  if(count>=max)return{ok:false,status:"device_limit",deviceCount:count,maxDevices:max};
  return{ok:false,status:"device_registration_failed",deviceCount:count,maxDevices:max};
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

    if (primaryFeedMatch[1] === "aether") {
      return proxyAetherGithubFeed(env.AETHER_SOURCE_URL, env.AETHER_GITHUB_TOKEN);
    }
    return proxyPrivateFeed(env.V2RAY_SOURCE_URL, "v2ray", true);
  }

  if (request.method === "GET" && path === "/admin") {
    return new Response(adminPage, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
  }

  if (request.method === "POST" && path === "/v1/device-challenge") return issueDeviceChallenge(request, env);

  if (request.method === "POST" && path === "/v1/validate") {
    const body = await readJson(request);
    const key = body?.subscriptionKey;
    if (typeof key !== "string" || !/^pc_[a-f0-9]{64}$/.test(key)) {
      return json({ valid: false, status: "invalid", message: "Invalid subscription key format" }, 400);
    }
    const keyHash = await sha256Hex(key);
    const row = await env.DB.prepare(
      "SELECT id, key_prefix, customer_label, status, created_at, updated_at, expires_at, max_devices FROM subscriptions WHERE key_hash = ? LIMIT 1"
    ).bind(keyHash).first<SubscriptionRow>();
    if (!row) return json({ valid: false, status: "invalid" }, 200);
    const status = publicStatus(row, Date.now());
    if (status !== "active") return json({ valid: false, status, subscriptionId: row.id, expiresAt: new Date(row.expires_at).toISOString(), serverTime: new Date().toISOString() });

    const publicKey=body?.devicePublicKey, challengeId=body?.challengeId, signature=body?.signature;
    const hasProof=publicKey!==undefined||challengeId!==undefined||signature!==undefined;
    if(!hasProof){
      if(env.DEVICE_LIMITS_ENFORCED==="true")return json({valid:false,status:"device_required"},403);
      return json({valid:true,status:"active",subscriptionId:row.id,expiresAt:new Date(row.expires_at).toISOString(),serverTime:new Date().toISOString(),deviceLimitsEnforced:false});
    }
    if(typeof publicKey!=="string"||typeof challengeId!=="string"||typeof signature!=="string")return json({valid:false,status:"invalid_device_proof"},400);
    const registration=await registerDevice(env,row.id,publicKey,challengeId,signature);
    if(!registration.ok)return json({valid:false,status:registration.status,deviceCount:registration.deviceCount,maxDevices:registration.maxDevices??row.max_devices},registration.status==="device_limit"||registration.status==="device_revoked"?403:400);
    return json({valid:true,status:"active",subscriptionId:row.id,expiresAt:new Date(row.expires_at).toISOString(),serverTime:new Date().toISOString(),deviceCount:registration.deviceCount,maxDevices:registration.maxDevices,deviceLimitsEnforced:true});
  }

  if (!path.startsWith("/admin/")) return json({ error: "Not found" }, 404);
  if (!isAdmin(request, env)) return json({ error: "Unauthorized" }, 401);

  if (request.method === "POST" && path === "/admin/subscriptions") {
    const body = await readJson(request);
    if (!body) return json({ error: "Expected a JSON object" }, 400);
    const customerLabel = cleanLabel(body.customerLabel);
    const expiresAt = expiryFromBody(body, Date.now());
    const deviceLimit = maxDevices(body.maxDevices);
    if (!customerLabel || expiresAt === null || deviceLimit === null) {
      return json({ error: "Provide customerLabel, maxDevices (1-100), and either durationDays (1-3650) or a future expiresAt date" }, 400);
    }

    const rawKey = `pc_${randomHex(32)}`;
    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO subscriptions (id, key_hash, key_prefix, customer_label, status, created_at, updated_at, expires_at, max_devices) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)"
    ).bind(id, await sha256Hex(rawKey), rawKey.slice(0, 11), customerLabel, now, now, expiresAt, deviceLimit).run();

    return json({
      created: true,
      subscription: {
        id,
        customerLabel,
        status: "active",
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        maxDevices: deviceLimit,
        registeredDevices: 0,
        subscriptionKey: rawKey,
      },
      warning: "Save this subscription key now. It cannot be retrieved later.",
    }, 201);
  }

  if (request.method === "GET" && path === "/admin/subscriptions") {
    const requestedLimit = Number(url.searchParams.get("limit") ?? "50");
    const limit = Number.isInteger(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 50;
    const result = await env.DB.prepare(
      "SELECT s.id, s.key_prefix, s.customer_label, s.status, s.created_at, s.updated_at, s.expires_at, s.max_devices, (SELECT COUNT(*) FROM subscription_devices d WHERE d.subscription_id = s.id AND d.revoked_at IS NULL) AS registered_devices FROM subscriptions s ORDER BY s.created_at DESC LIMIT ?"
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
        maxDevices: row.max_devices,
        registeredDevices: Number((row as SubscriptionRow & { registered_devices?: number }).registered_devices ?? 0),
      })),
    });
  }

  const devicesMatch = path.match(/^\\/admin\\/subscriptions\\/([0-9a-f-]{36})\\/devices$/i);
  if (request.method === "GET" && devicesMatch) {
    const subscriptionId = devicesMatch[1];
    const sub = await env.DB.prepare("SELECT id,max_devices FROM subscriptions WHERE id=? LIMIT 1").bind(subscriptionId).first<{id:string;max_devices:number}>();
    if (!sub) return json({error:"Subscription not found"},404);
    const result = await env.DB.prepare("SELECT id,public_key_hash,created_at,last_seen_at,revoked_at FROM subscription_devices WHERE subscription_id=? ORDER BY created_at ASC").bind(subscriptionId).all<DeviceRow>();
    const devices=result.results??[];
    return json({maxDevices:sub.max_devices,registeredDevices:devices.filter(d=>d.revoked_at===null).length,devices:devices.map(d=>({id:d.id,fingerprint:d.public_key_hash.slice(0,12),createdAt:new Date(d.created_at).toISOString(),lastSeenAt:new Date(d.last_seen_at).toISOString(),revoked:d.revoked_at!==null,revokedAt:d.revoked_at===null?null:new Date(d.revoked_at).toISOString()}))});
  }

  const deleteDeviceMatch = path.match(/^\\/admin\\/subscriptions\\/([0-9a-f-]{36})\\/devices\\/([0-9a-f-]{36})$/i);
  if (request.method === "DELETE" && deleteDeviceMatch) {
    const result=await env.DB.prepare("UPDATE subscription_devices SET revoked_at=? WHERE id=? AND subscription_id=? AND revoked_at IS NULL").bind(Date.now(),deleteDeviceMatch[2],deleteDeviceMatch[1]).run();
    if(!result.meta.changes)return json({error:"Active device not found"},404);
    return json({removed:true,deviceId:deleteDeviceMatch[2],freedSlot:true});
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
