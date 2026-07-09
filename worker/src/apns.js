// Apple Push Notification service (APNs) sender for Prem Oracle.
// Signs a provider JWT with ES256 (P-256) using the APNS_KEY / APNS_KEY_ID /
// APNS_TEAM_ID secrets and posts alert payloads to the APNs HTTP/2 endpoint.

const APNS_HOST = "https://api.push.apple.com";
export const APNS_TOPIC = "com.abigwood.premoracle";
// Apple rejects provider tokens older than 60 minutes; refresh a little early.
const TOKEN_TTL_MS = 50 * 60 * 1000;

let cachedToken = null;
let cachedAt = 0;
let cachedKeyId = null;

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const b64urlJson = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

function pemToPkcs8(pem) {
  const base64 = String(pem)
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function importKey(pem) {
  return crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(pem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
}

// Builds (and ~50 min caches) an ES256 provider token. WebCrypto returns the
// signature in raw r||s form, which is exactly the JOSE encoding APNs expects.
export async function buildToken(env, nowMs = Date.now()) {
  if (cachedToken && cachedKeyId === env.APNS_KEY_ID && nowMs - cachedAt < TOKEN_TTL_MS) {
    return cachedToken;
  }
  const header = b64urlJson({ alg: "ES256", kid: env.APNS_KEY_ID });
  const claims = b64urlJson({ iss: env.APNS_TEAM_ID, iat: Math.floor(nowMs / 1000) });
  const signingInput = `${header}.${claims}`;
  const key = await importKey(env.APNS_KEY);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput)
  );
  cachedToken = `${signingInput}.${b64url(signature)}`;
  cachedAt = nowMs;
  cachedKeyId = env.APNS_KEY_ID;
  return cachedToken;
}

// POSTs an alert payload to APNs and resolves with the raw Response so callers
// can react to status codes (e.g. 410 Unregistered => drop the stale token).
export async function sendPush(deviceToken, payload, env) {
  const token = await buildToken(env);
  return fetch(`${APNS_HOST}/3/device/${deviceToken}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${token}`,
      "apns-topic": APNS_TOPIC,
      "apns-push-type": "alert",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

export const apnsConfigured = (env) =>
  !!(env.APNS_KEY && env.APNS_KEY_ID && env.APNS_TEAM_ID);

// Test-only hook to clear the module-level token cache between cases.
export function _resetTokenCache() {
  cachedToken = null;
  cachedAt = 0;
  cachedKeyId = null;
}
