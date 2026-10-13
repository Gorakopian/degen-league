// Run with: node test/auth.test.js  — signs a real ed25519 message like a wallet would
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { base58Decode, isAddress, verifySignature, createNonce, finishSignIn, sessionAddress } from "../lib/auth.js";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(buf) {
  let n = BigInt("0x" + (buf.toString("hex") || "0")), s = "";
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = "1" + s; else break; }
  return s;
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
const address = base58Encode(raw);
assert.ok(isAddress(address));
assert.deepEqual(base58Decode(address), raw);
assert.equal(isAddress("0xabc"), false);

const { nonce, message } = await createNonce(address, "test.local");
const sig = sign(null, Buffer.from(message, "utf8"), privateKey);
assert.ok(verifySignature(address, message, sig));
assert.equal(verifySignature(address, message + "x", sig), false);

const ok = await finishSignIn(address, nonce, sig.toString("base64"));
assert.equal(ok.address, address);
assert.equal(await sessionAddress({ headers: { authorization: "Bearer " + ok.token } }), address);
const replay = await finishSignIn(address, nonce, sig.toString("base64"));
assert.ok(replay.error, "a nonce can only be used once");
console.log("auth OK");
