// Run with: node test/game.test.js  — rules, prices, and the API end to end (in-memory, demo scores)
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { Readable } from "node:stream";
import { nextPrice, validateTeam, teamPoints, getPrices, BUDGET } from "../lib/game.js";
import { TRADERS } from "../lib/traders.js";
import { calendar, shiftWeek } from "../lib/weeks.js";
import { redis } from "../lib/redis.js";
import { tick } from "../lib/scoring.js";

delete process.env.HELIUS_API_KEY;

// Prices
assert.equal(nextPrice(20, { ret: 100 }), 24);
assert.equal(nextPrice(20, { ret: -500 }), 16);
assert.equal(nextPrice(34, { ret: 300 }), 35);
assert.equal(nextPrice(10, { inactive: true, ret: 0 }), 9);

// Rules
const base = Object.fromEntries(TRADERS.map((t) => [t.id, t.price]));
const ids = TRADERS.map((t) => t.id);
const top5 = ids.slice(0, 5);
assert.match(validateTeam(top5, top5[0], base), /budget/);
const cheap = ids.slice(-5);
assert.equal(validateTeam(cheap, cheap[2], base), null);
assert.match(validateTeam(cheap.slice(0, 4), cheap[0], base), /exactly 5/);
assert.match(validateTeam([...cheap.slice(0, 4), cheap[0]], cheap[0], base), /twice/);
assert.match(validateTeam(cheap, ids[0], base), /captain/);
assert.ok(TRADERS.map((t) => t.price).sort((a, b) => a - b).slice(0, 5).reduce((a, b) => a + b) <= BUDGET);
assert.equal(teamPoints({ picks: ["a", "b"], captain: "a" }, { a: { ret: 10 }, b: { ret: -5 } }), 15);

// Prices for a week are created once from the week before + results two weeks back
const cal = calendar();
await redis("SET", `prices:${cal.current.id}`, JSON.stringify(base));
await redis("HSET", `scores:${cal.last.id}`, ids[0], JSON.stringify({ ret: 200 }));
const up = await getPrices(cal.upcoming.id);
assert.equal(up[ids[0]], Math.min(35, base[ids[0]] + 4));
assert.equal(up[ids[1]], base[ids[1]]);
assert.equal(shiftWeek(cal.upcoming.id, -2), cal.last.id);

// --- API end to end -------------------------------------------------------
const call = async (mod, method, url, body, token) => {
  const { default: handler } = await import(mod);
  const req = Readable.from([Buffer.from(body ? JSON.stringify(body) : "")]);
  Object.assign(req, { method, url, headers: token ? { authorization: "Bearer " + token, host: "test" } : { host: "test" } });
  return new Promise((resolve) => {
    const res = { statusCode: 200, setHeader() {}, end(s) { resolve({ status: this.statusCode, body: JSON.parse(s) }); } };
    handler(req, res);
  });
};

// Sign in with a fresh ed25519 key, like a wallet
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (buf) => { let n = BigInt("0x" + buf.toString("hex")), s = ""; while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; } return s; };
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const address = b58(publicKey.export({ format: "der", type: "spki" }).subarray(12));
const n1 = await call("../api/auth.js", "POST", "/api/auth?step=nonce", { address });
assert.equal(n1.status, 200);
const signature = sign(null, Buffer.from(n1.body.message), privateKey).toString("base64");
const v = await call("../api/auth.js", "POST", "/api/auth?step=verify", { address, nonce: n1.body.nonce, signature });
assert.equal(v.status, 200);
const token = v.body.token;

// Save a team
const g0 = await call("../api/game.js", "GET", "/api/game", null, token);
assert.equal(g0.status, 200);
assert.equal(g0.body.traders.length, TRADERS.length);
const team = g0.body.traders.slice(-5).map((t) => t.id);
const bad = await call("../api/game.js", "POST", "/api/game", { picks: g0.body.traders.slice(0, 5).map((t) => t.id), captain: g0.body.traders[0].id }, token);
assert.equal(bad.status, 400);
const noAuth = await call("../api/game.js", "POST", "/api/game", { picks: team, captain: team[0] });
assert.equal(noAuth.status, 401);
const ok = await call("../api/game.js", "POST", "/api/game", { picks: team, captain: team[1], nickname: "Diamond <b>Dave</b>" }, token);
assert.equal(ok.status, 200);
assert.equal(ok.body.team.nickname, "Diamond bDave/b");

// Pretend that team was also locked in for the current week, refresh demo scores, check the leaderboard
await redis("HSET", `teams:${cal.current.id}`, address, JSON.stringify(ok.body.team));
const t = await tick(undefined);
assert.ok(t.refreshed > 0);
const g1 = await call("../api/game.js", "GET", "/api/game", null, token);
assert.equal(g1.body.me.upcoming.captain, team[1]);
assert.equal(g1.body.me.current.rank, 1);
assert.ok(g1.body.traders.every((x) => x.live));
assert.equal(g1.body.traders.find((x) => x.id === team[0]).pickedPct, 100);
const lb = await call("../api/leaderboard.js", "GET", "/api/leaderboard?week=current", null, token);
assert.equal(lb.body.rows[0].me, true);
assert.equal(lb.body.me.rank, 1);
console.log("game OK");
