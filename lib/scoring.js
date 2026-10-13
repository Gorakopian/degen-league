// Weekly score for each trader: % return on the coins they bought during the game week.
//   return = (SOL got back from selling + value of what they still hold − SOL spent) ÷ SOL spent
// Coins they bought before the week and only sold during it are ignored, so dumping old bags
// doesn't count as profit. A trader who spends less than MIN_SPENT_SOL in the week scores 0.
import { walletDeltas, fetchTxPage, fetchPrices, WSOL, SOL_NOISE } from "./chain.js";
import { getJSON, setJSON, redis, pipeline, hgetallJSON } from "./redis.js";
import { TRADERS } from "./traders.js";
import { calendar } from "./weeks.js";

export const MIN_SPENT_SOL = 1;
const MAX_RET = 1000, MIN_RET = -100;

export function emptyState() {
  return { pos: {}, trades: 0, lastTs: 0, edge: [], caughtUp: false };
}

/** Add transactions (any order) for one wallet to its weekly state. Pure. */
export function applyTxs(state, txs, wallet, startTs, endTs) {
  const sorted = txs.filter((t) => t && !t.transactionError && t.timestamp >= startTs && t.timestamp < endTs)
    .sort((a, b) => a.timestamp - b.timestamp);
  let added = 0;
  for (const tx of sorted) {
    if (tx.timestamp < state.lastTs) continue;
    if (tx.timestamp === state.lastTs && state.edge.includes(tx.signature)) continue;
    if (tx.timestamp > state.lastTs) { state.lastTs = tx.timestamp; state.edge = []; }
    state.edge.push(tx.signature);
    added++;

    const { sol, usd, coins } = walletDeltas(tx, wallet);
    if (coins.length !== 1) continue;
    const [mint, amount] = coins[0];
    if (!(Math.abs(sol) > SOL_NOISE || Math.abs(usd) > 0.01)) continue;
    const isBuy = amount > 0 && (sol < 0 || usd < 0);
    const isSell = amount < 0 && (sol > 0 || usd > 0);
    if (!isBuy && !isSell) continue;

    const p = state.pos[mint] || (state.pos[mint] = { b: 0, s: 0, in: 0, out: 0, inUsd: 0, outUsd: 0, x: false });
    if (isSell && p.b === 0) p.x = true; // first thing we see this week is a sell: an old bag, ignore
    if (isBuy) { p.b += amount; p.in += Math.max(0, -sol); p.inUsd += Math.max(0, -usd); }
    else { p.s += -amount; p.out += Math.max(0, sol); p.outUsd += Math.max(0, usd); }
    state.trades++;
  }
  return added;
}

/** Turn a state into a score, using current USD prices and the SOL price. Pure. */
export function scoreState(state, pricesUsd, solUsd) {
  let spent = 0, value = 0;
  const toSol = (u) => (solUsd > 0 ? u / solUsd : 0);
  for (const [mint, p] of Object.entries(state.pos)) {
    if (p.x) continue;
    const cost = p.in + toSol(p.inUsd);
    if (cost <= 0) continue;
    const held = Math.max(0, p.b - p.s);
    const price = pricesUsd[mint] || 0;
    spent += cost;
    value += p.out + toSol(p.outUsd) + toSol(held * price);
  }
  const pnl = value - spent;
  const inactive = spent < MIN_SPENT_SOL;
  let ret = !inactive && spent > 0 ? (pnl / spent) * 100 : 0;
  ret = Math.max(MIN_RET, Math.min(MAX_RET, ret));
  return { ret: Math.round(ret * 10) / 10, spent: +spent.toFixed(2), pnl: +pnl.toFixed(2), trades: state.trades, inactive };
}

/** Made-up but steady scores for demo mode (no Helius key): changes a bit every hour. */
export function demoScore(id, weekId, nowTs) {
  let h = 2166136261;
  for (const c of id + weekId) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  const base = ((h >>> 0) % 2400) / 10 - 60;            // -60 … +180
  const hour = Math.floor(nowTs / 3600);
  const drift = Math.sin((hour + (h & 255)) / 7) * 15;   // moves through the week
  const inactive = (h >>> 0) % 13 === 0;
  return { ret: inactive ? 0 : Math.round((base + drift) * 10) / 10, spent: inactive ? 0.2 : 4 + ((h >>> 3) % 60), pnl: 0, trades: inactive ? 1 : 10 + ((h >>> 5) % 200), inactive };
}

async function solPrice() {
  const p = await fetchPrices([WSOL]);
  return p[WSOL] || null;
}

/**
 * Read new transactions for one trader in one week and store the updated score.
 * Pages forward from where it stopped last time, so each run is cheap.
 */
export async function refreshTrader(address, week, heliusKey, { maxPages = 3, nowTs = Math.floor(Date.now() / 1000), sol } = {}) {
  const key = `st:${week.id}:${address}`;
  const state = (await getJSON(key)) || emptyState();
  const until = Math.min(week.end, nowTs);
  let pages = 0;
  state.caughtUp = false;
  while (pages < maxPages) {
    const from = Math.max(week.start, state.lastTs);
    const txs = await fetchTxPage(address, heliusKey, from, until);
    pages++;
    const added = applyTxs(state, txs, address, week.start, week.end);
    if (txs.length < 100 || added === 0) { state.caughtUp = true; break; }
  }
  const held = Object.entries(state.pos).filter(([, p]) => !p.x && p.b - p.s > 0).map(([m]) => m);
  const prices = held.length ? await fetchPrices(held) : {};
  const solUsd = sol ?? (await solPrice());
  const score = scoreState(state, prices, solUsd);
  score.at = nowTs;
  score.final = state.caughtUp && nowTs >= week.end;
  await setJSON(key, state, 40 * 86400);
  await redis("HSET", `scores:${week.id}`, address, JSON.stringify(score));
  return score;
}

/**
 * Refresh the traders whose scores are oldest, within a time budget. Called by the cron
 * job and, lightly, when people visit. Also finalizes last week's scores after Monday.
 */
export async function tick(heliusKey, { budgetMs = 20000, minAgeMinutes = Number(process.env.MIN_REFRESH_MINUTES) || 60, nowTs = Math.floor(Date.now() / 1000) } = {}) {
  const started = Date.now();
  const cal = calendar(nowTs);
  const got = await redis("SET", "lock:tick", "1", "NX", "EX", Math.ceil(budgetMs / 1000) + 30);
  if (got !== "OK") return { busy: true };
  const done = { refreshed: 0, errors: 0 };
  try {
    if (!heliusKey) {
      // Demo mode: write made-up scores for everyone
      const cmds = [];
      for (const w of [cal.last, cal.current]) {
        const args = ["HSET", `scores:${w.id}`];
        for (const t of TRADERS) {
          const s = { ...demoScore(t.id, w.id, Math.min(nowTs, w.end)), at: nowTs, final: nowTs >= w.end };
          args.push(t.id, JSON.stringify(s));
        }
        cmds.push(args);
      }
      await pipeline(cmds);
      done.refreshed = TRADERS.length * 2;
      return done;
    }
    const sol = await solPrice();
    const jobs = [];
    // 1) Finish last week: anyone not final yet
    const lastScores = await hgetallJSON(`scores:${cal.last.id}`);
    for (const t of TRADERS) if (lastScores[t.id] && !lastScores[t.id].final) jobs.push([t.id, cal.last, 0]);
    // 2) Current week: oldest first
    const cur = await hgetallJSON(`scores:${cal.current.id}`);
    const stale = TRADERS.map((t) => [t.id, cur[t.id]?.at || 0])
      .filter(([, at]) => nowTs - at >= minAgeMinutes * 60)
      .sort((a, b) => a[1] - b[1]);
    for (const [id, at] of stale) jobs.push([id, cal.current, at]);

    for (const [id, week] of jobs) {
      if (Date.now() - started > budgetMs) break;
      try { await refreshTrader(id, week, heliusKey, { nowTs, sol }); done.refreshed++; }
      catch (e) { done.errors++; if (String(e.message).includes("rate_limited")) break; }
    }
    done.left = Math.max(0, jobs.length - done.refreshed - done.errors);
    return done;
  } finally {
    await redis("DEL", "lock:tick");
  }
}
