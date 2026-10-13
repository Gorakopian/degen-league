// Run with: node test/scoring.test.js
import assert from "node:assert/strict";
import { applyTxs, scoreState, emptyState, refreshTrader, demoScore } from "../lib/scoring.js";
import { calendar } from "../lib/weeks.js";
import { hgetallJSON } from "../lib/redis.js";

const W = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const A = "CoinAAAA11111111111111111111111111111111111";
const B = "CoinBBBB11111111111111111111111111111111111";
const OLD = "CoinOLDD11111111111111111111111111111111111";
const start = 1_760_918_400; // a Monday 00:00 UTC
const end = start + 7 * 86400;
let n = 0;
function swap(ts, mint, sol, tok) {
  return {
    signature: "sig" + n++, timestamp: ts, fee: 5000, feePayer: W,
    accountData: [
      { account: W, nativeBalanceChange: Math.round(sol * 1e9), tokenBalanceChanges: [] },
      { account: "ata", nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount: W, mint, rawTokenAmount: { tokenAmount: String(Math.round(tok * 1e6)), decimals: 6 } }] },
    ],
  };
}

const txs = [
  swap(start - 100, A, -9, 1000),       // before the week: ignored
  swap(start + 10, A, -2, 1000),         // buy A for 2 SOL
  swap(start + 20, A, 5, -1000),         // sell A for 5 SOL  (+3)
  swap(start + 30, B, -2, 500),          // buy B for 2 SOL, still holding
  swap(start + 40, OLD, 50, -100),       // sell an old bag: must not count
  swap(end + 5, B, 9, -500),             // after the week: ignored
];
const st = emptyState();
assert.equal(applyTxs(st, txs, W, start, end), 4);
assert.equal(st.pos[OLD].x, true);
// B now worth $0.6 each, SOL $150 → 500 * 0.6 / 150 = 2 SOL → flat
let s = scoreState(st, { [B]: 0.6 }, 150);
assert.equal(s.spent, 4);
assert.equal(s.pnl, 3);
assert.equal(s.ret, 75);
assert.equal(s.inactive, false);
// Same txs again: nothing double counted
assert.equal(applyTxs(st, txs, W, start, end), 0);
// B went to zero
assert.equal(scoreState(st, {}, 150).ret, 25);
// Tiny activity = inactive, scores 0
const tiny = emptyState();
applyTxs(tiny, [swap(start + 1, A, -0.3, 10), swap(start + 2, A, 3, -10)], W, start, end);
assert.deepEqual([scoreState(tiny, {}, 150).ret, scoreState(tiny, {}, 150).inactive], [0, true]);

// refreshTrader pages forward with a fake Helius + Jupiter
const calls = [];
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  calls.push(u);
  let body;
  if (u.host.includes("jup")) body = { [B]: { usdPrice: 0.6 }, So11111111111111111111111111111111111111112: { usdPrice: 150 } };
  else {
    const from = Number(u.searchParams.get("gte-time"));
    body = txs.filter((t) => t.timestamp >= from && t.timestamp < Number(u.searchParams.get("lt-time")));
  }
  return { ok: true, status: 200, json: async () => body };
};
const week = { id: "2026-10-20", start, end };
const r = await refreshTrader(W, week, "KEY", { nowTs: end + 3600 });
assert.equal(r.ret, 75);
assert.equal(r.final, true);
const stored = await hgetallJSON(`scores:${week.id}`);
assert.equal(stored[W].ret, 75);
assert.equal(calls[0].searchParams.get("sort-order"), "asc");

// demo scores are stable for the same hour
assert.deepEqual(demoScore("x", "w", 3600 * 10), demoScore("x", "w", 3600 * 10 + 5));
const cal = calendar(Date.UTC(2026, 9, 14, 12) / 1000); // a Wednesday
assert.equal(cal.current.id, "2026-10-12");
assert.equal(cal.upcoming.id, "2026-10-19");
console.log("scoring OK");
