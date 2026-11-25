#!/usr/bin/env node
/**
 * End-to-end test against a LOCAL Worker only.
 * Required env: LOCAL_WORKER_URL (default http://127.0.0.1:8787), LOCAL_ADMIN_TOKEN.
 */
import { generateKeyPairSync, sign, createHash } from "node:crypto";

const base = (process.env.LOCAL_WORKER_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const adminToken = process.env.LOCAL_ADMIN_TOKEN;
if (!adminToken || adminToken.length < 32) {
  throw new Error("Set LOCAL_ADMIN_TOKEN to a local-only token (32+ chars). Never use production credentials.");
}

async function call(path, { method = "GET", body, admin = false } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(admin ? { authorization: `Bearer ${adminToken}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}
function assert(condition, message) {
  if (!condition) throw new Error("FAIL: " + message);
  console.log("PASS: " + message);
}
function newDevice() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey,
  };
}
async function register(subscriptionKey, device) {
  const challenge = await call("/v1/device-challenge", {
    method: "POST",
    body: { subscriptionKey, devicePublicKey: device.publicKey },
  });
  assert(challenge.status === 200 && challenge.data.challengeId && challenge.data.challenge, "challenge issued");
  const signature = sign("sha256", Buffer.from(challenge.data.challenge, "utf8"), {
    key: device.privateKey,
    dsaEncoding: "der",
  }).toString("base64");
  return call("/v1/validate", {
    method: "POST",
    body: {
      subscriptionKey,
      devicePublicKey: device.publicKey,
      challengeId: challenge.data.challengeId,
      signature,
    },
  });
}
async function createSubscription(label, cap) {
  const response = await call("/admin/subscriptions", {
    method: "POST",
    admin: true,
    body: { customerLabel: label, durationDays: 1, maxDevices: cap },
  });
  assert(response.status === 201, `test subscription created (cap=${cap})`);
  return response.data.subscription;
}
async function admin(path, method = "GET", body) {
  return call(path, { method, body, admin: true });
}

const health = await call("/health");
assert(health.status === 200 && health.data.ok, "local Worker health endpoint");

const one = await createSubscription("LOCAL DEVICE TEST 1", 1);
const deviceA = newDevice(), deviceB = newDevice();
let result = await register(one.subscriptionKey, deviceA);
assert(result.status === 200 && result.data.valid && result.data.deviceCount === 1, "Device A registers under capacity 1");
result = await register(one.subscriptionKey, deviceA);
assert(result.status === 200 && result.data.valid && result.data.deviceCount === 1, "same installation revalidates without taking another slot");
result = await register(one.subscriptionKey, deviceB);
assert(result.status === 403 && result.data.status === "device_limit", "second installation is rejected at cap 1");

let list = await admin(`/admin/subscriptions/${one.id}/devices`);
assert(list.status === 200 && list.data.registeredDevices === 1, "admin reports 1 active registration");
const activeA = list.data.devices.find(d => !d.revoked);
assert(Boolean(activeA), "Device A listed by admin");
const deleted = await admin(`/admin/subscriptions/${one.id}/devices/${activeA.id}`, "DELETE");
assert(deleted.status === 200 && deleted.data.registeredDevices === 0, "admin revokes Device A and frees its slot");
result = await register(one.subscriptionKey, deviceB);
assert(result.status === 200 && result.data.valid && result.data.deviceCount === 1, "Device B registers after slot is freed");
result = await register(one.subscriptionKey, deviceA);
assert(result.status === 403 && result.data.status === "device_revoked", "revoked Device A cannot silently re-register");

const two = await createSubscription("LOCAL DEVICE TEST 2", 2);
const deviceC = newDevice(), deviceD = newDevice(), deviceE = newDevice();
result = await register(two.subscriptionKey, deviceC);
assert(result.status === 200 && result.data.valid, "Device C registers under cap 2");
result = await register(two.subscriptionKey, deviceD);
assert(result.status === 200 && result.data.valid && result.data.deviceCount === 2, "Device D fills cap 2");
const lowered = await admin(`/admin/subscriptions/${two.id}/device-limit`, "POST", { maxDevices: 1 });
assert(lowered.status === 200 && lowered.data.registeredDevices === 2 && lowered.data.newDevicesAllowed === 0, "lowering cap below current usage preserves devices and blocks new ones");
result = await register(two.subscriptionKey, deviceC);
assert(result.status === 200 && result.data.valid, "existing Device C remains valid after lowering capacity");
result = await register(two.subscriptionKey, deviceE);
assert(result.status === 403 && result.data.status === "device_limit", "new Device E is denied while usage exceeds lowered cap");
list = await admin(`/admin/subscriptions/${two.id}/devices`);
const fingerprintD = createHash("sha256").update(deviceD.publicKey).digest("hex").slice(0, 12);
const activeD = list.data.devices.find(d => !d.revoked && d.fingerprint === fingerprintD);\nassert(Boolean(activeD), "Device D found by its SHA-256 fingerprint in admin list");
const deleteD = await admin(`/admin/subscriptions/${two.id}/devices/${activeD?.id}`, "DELETE");
assert(deleteD.status === 200 && deleteD.data.registeredDevices === 1, "revoking one of two existing devices frees one slot");
result = await register(two.subscriptionKey, deviceE);
assert(result.status === 200 && result.data.valid && result.data.deviceCount === 2, "Device E registers once usage falls below the lowered cap");

console.log("\nAll local device-limit integration checks passed. No production resources were accessed.");
