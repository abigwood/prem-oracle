import test from "node:test";
import assert from "node:assert/strict";
import { buildToken, _resetTokenCache } from "../src/apns.js";

const b64urlDecode = (value) =>
  Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");

// Generates a throwaway P-256 key pair and returns the private key as PKCS#8 PEM
// (the shape Apple hands out in a .p8 file) plus the public key for verification.
async function generateKeyPair() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const base64 = Buffer.from(pkcs8).toString("base64").replace(/(.{64})/g, "$1\n");
  const pem = `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`;
  return { pem, publicKey: pair.publicKey };
}

test("buildToken produces a well-formed, verifiable ES256 JWT", async () => {
  _resetTokenCache();
  const { pem, publicKey } = await generateKeyPair();
  const env = { APNS_KEY: pem, APNS_KEY_ID: "ABC123DEFG", APNS_TEAM_ID: "TEAM123456" };
  const nowMs = 1_752_000_000_000;

  const token = await buildToken(env, nowMs);
  const parts = token.split(".");
  assert.equal(parts.length, 3);

  const header = JSON.parse(b64urlDecode(parts[0]).toString());
  assert.equal(header.alg, "ES256");
  assert.equal(header.kid, "ABC123DEFG");

  const claims = JSON.parse(b64urlDecode(parts[1]).toString());
  assert.equal(claims.iss, "TEAM123456");
  assert.equal(claims.iat, Math.floor(nowMs / 1000));

  // Raw r||s JOSE signature is exactly 64 bytes for P-256.
  const signature = b64urlDecode(parts[2]);
  assert.equal(signature.length, 64);

  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    signature,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  assert.equal(verified, true);
});

test("buildToken caches the token within the TTL window", async () => {
  _resetTokenCache();
  const { pem } = await generateKeyPair();
  const env = { APNS_KEY: pem, APNS_KEY_ID: "KID0000001", APNS_TEAM_ID: "TEAM000001" };
  const first = await buildToken(env, 1_752_000_000_000);
  const second = await buildToken(env, 1_752_000_000_000 + 40 * 60 * 1000);
  assert.equal(first, second);
  const third = await buildToken(env, 1_752_000_000_000 + 55 * 60 * 1000);
  assert.notEqual(first, third);
});
