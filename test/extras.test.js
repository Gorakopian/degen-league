// Run with: node test/extras.test.js  — close prices, season ranking, winners
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { generateKeyPairSync, sign } from "node:crypto";
import { closeAt, closePrices } from "../lib/closeprice.js";
import { refreshTrader } from "../lib/scoring.js";
import { seasonBoard } from "../lib/game.js";
import { redis, hgetallJSON } from "../lib/redis.js";
import { calendar, shiftWeek } from "../lib/weeks.js";
import { TRADERS } from "../lib/traders.js";

// closeAt picks the last candle before the close, ignores stale ones
const end = 1_761_523_200; // Monday 00:00 UTC
assert.equal(closeAt([[end - 900, 1, 1, 1, 2, 0], [end - 1800, 1, 1, 1, 3, 0], [end + 900, 1, 1, 1, 9, 0]], end), 2);
assert.equal(closeAt([[end - 7 * 3600, 1, 1, 1, 2, 0]], end), null);

// ---- fake network: Helius, Jupiter, GeckoTerminal ----
const W = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const B = "CoinBBBB11111111111111111111111111111111111";
const start = end - 7 * 86400;
const txs = [{
  signature: "s1", timestamp: start + 100, fee: 5000, feePayer: W,
  accountData: [
    { account: W, nativeBalanceChange: -2e9, tokenBalanceChanges: [] },
    { account: "ata", nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount: W, mint: B, rawTokenAmount: { tokenAmount: String(500e6), decimals: 6 } }] },
  ],
}];
let gtCalls = 0;
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  let body;
  if (u.host.includes("helius")) body = txs.filter((t) => t.timestamp >= Number(u.searchParams.get("gte-time")) && t.timestamp < Number(u.searchParams.get("lt-time")));
  else if (u.host.includes("jup")) body = { [B]: { usdPrice: 0.6 }, So11111111111111111111111111111111111111112: { usdPrice: 150 } };
  else if (u.pathname.includes("/tokens/multi/")) { gtCalls++; body = { data: [{ attributes: { address: B }, relationships: { top_pools: { data: [{ id: "solana_PoolB" }] } } }] }; }
  else if (u.pathname.includes("/ohlcv/")) { gtCalls++; body = { data: { attributes: { ohlcv_list: [[end - 900, 0, 0, 0, 1.2, 0]] } } }; }
  return { ok: true, status: 200, json: async () => body };
};

// Before the week ends: valued at today's price (0.6) → 500*0.6/150 = 2 SOL → 0%
const week = { id: "2026-10-20", start, end };
let s = await refreshTrader(W, week, "KEY", { nowTs: end - 3600 });
assert.equal(s.ret, 0);
assert.equal(s.final, false);
// After the close: valued at the Monday 00:00 price (1.2) → 4 SOL → +100%, even though today's price is 0.6
s = await refreshTrader(W, week, "KEY", { nowTs: end + 5 * 3600 });
assert.equal(s.ret, 100);
assert.equal(s.final, true);
assert.equal(s.closePriced, 1);
// Cached: no more GeckoTerminal calls the second time
const before = gtCalls;
assert.deepEqual(await closePrices([B], end, week.id), { [B]: 1.2 });
assert.equal(gtCalls, before);

// ---- season ranking over two weeks ----
const cal = calendar();
const w1 = shiftWeek(cal.current.id, -1), w2 = cal.current.id;
const [a, b, c, d, e] = TRADERS.map((t) => t.id);
await redis("SET", "meta:firstWeek", w1);
await redis("HSET", `scores:${w1}`, a, JSON.stringify({ ret: 50 }), b, JSON.stringify({ ret: -10 }));
await redis("HSET", `scores:${w2}`, a, JSON.stringify({ ret: 10 }), b, JSON.stringify({ ret: 30 }));
await redis("HSET", `teams:${w1}`, "AliceWallet111111111111111111111111111111111", JSON.stringify({ picks: [a, b, c, d, e], captain: a, nickname: "Alice" }));
await redis("HSET", `teams:${w1}`, "BobWallet11111111111111111111111111111111111", JSON.stringify({ picks: [a, b, c, d, e], captain: b, nickname: "Bob" }));
await redis("HSET", `teams:${w2}`, "BobWallet11111111111111111111111111111111111", JSON.stringify({ picks: [a, b, c, d, e], captain: b, nickname: "Bobby" }));
const sb = await seasonBoard(w2, "BobWallet11111111111111111111111111111111111");
// Alice: 100 - 10 = 90 (1 week). Bob: wk1 50 - 20 = 30, wk2 10 + 60 = 70 → 100 (2 weeks)
assert.deepEqual(sb.rows.map((r) => [r.name, r.points, r.weeks]), [["Bobby", 100, 2], ["Alice", 90, 1]]);
assert.equal(sb.me.rank, 1);

// ---- winners API: public vs admin, mark paid ----
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (buf) => { let n = BigInt("0x" + buf.toString("hex")), s = ""; while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; } return s; };
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const admin = b58(publicKey.export({ format: "der", type: "spki" }).subarray(12));
process.env.ADMIN_WALLETS = admin;
process.env.PRIZES = "1 SOL, 0.5 SOL, 0.25 SOL";
const call = async (mod, method, url, body, token) => {
  const { default: handler } = await import(mod);
  const req = Readable.from([Buffer.from(body ? JSON.stringify(body) : "")]);
  Object.assign(req, { method, url, headers: token ? { authorization: "Bearer " + token } : {} });
  return new Promise((resolve) => { handler(req, { statusCode: 200, setHeader() {}, end(s) { resolve({ status: this.statusCode, body: JSON.parse(s) }); } }); });
};
const n = await call("../api/auth.js", "POST", "/api/auth?step=nonce", { address: admin });
const v = await call("../api/auth.js", "POST", "/api/auth?step=verify", { address: admin, nonce: n.body.nonce, signature: sign(null, Buffer.from(n.body.message), privateKey).toString("base64") });
const token = v.body.token;

const pub = await call("../api/winners.js", "GET", "/api/winners");
assert.equal(pub.body.admin, false);
assert.equal(pub.body.weeks[0].week, w1);
assert.equal(pub.body.weeks[0].winners[0].name, "Alice");
assert.equal(pub.body.weeks[0].winners[0].address, undefined, "public view hides full wallets");
assert.deepEqual(pub.body.prizes, ["1 SOL", "0.5 SOL", "0.25 SOL"]);
const denied = await call("../api/winners.js", "POST", "/api/winners", { week: w1, address: "AliceWallet111111111111111111111111111111111", paid: true });
assert.equal(denied.status, 403);
const mark = await call("../api/winners.js", "POST", "/api/winners", { week: w1, address: "AliceWallet111111111111111111111111111111111", paid: true }, token);
assert.equal(mark.status, 200);
const adm = await call("../api/winners.js", "GET", "/api/winners", null, token);
assert.equal(adm.body.admin, true);
assert.equal(adm.body.weeks[0].winners[0].address, "AliceWallet111111111111111111111111111111111");
assert.ok(adm.body.weeks[0].winners[0].paidAt);
const pub2 = await call("../api/winners.js", "GET", "/api/winners");
assert.equal(pub2.body.weeks[0].winners[0].paid, true);
const season = await call("../api/leaderboard.js", "GET", "/api/leaderboard?week=season");
assert.equal(season.body.rows.length, 2);
console.log("extras OK");
