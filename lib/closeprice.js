// Prices at the moment a week closes (Monday 00:00 UTC), so open positions are valued at
// the same instant for every trader, no matter when the final update runs.
// Uses free GeckoTerminal price candles. Results are cached per coin per week.
import { redis, pipeline } from "./redis.js";

const GT = "https://api.geckoterminal.com/api/v2";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gt(path, retry = true) {
  const res = await fetch(GT + path, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; DegenLeague/1.0)" } });
  if (res.status === 429 && retry) { await sleep(2500); return gt(path, false); }
  if (res.status === 429) throw new Error("gt_rate_limited");
  if (!res.ok) throw new Error(`gt_${res.status}`);
  return res.json();
}

/** Biggest pool for each coin (30 per call). */
async function topPools(mints) {
  const out = {};
  for (let i = 0; i < mints.length; i += 30) {
    const j = await gt(`/networks/solana/tokens/multi/${mints.slice(i, i + 30).join(",")}?include=top_pools`);
    for (const t of j?.data || []) {
      const mint = t?.attributes?.address;
      const poolId = t?.relationships?.top_pools?.data?.[0]?.id || "";
      if (mint && poolId) out[mint] = poolId.split("_").slice(1).join("_");
    }
  }
  return out;
}

/** Last close at or before `endTs` from a candle list. Pure. */
export function closeAt(ohlcvList, endTs) {
  let best = null;
  for (const c of ohlcvList || []) {
    const t = Number(c[0]), close = Number(c[4]);
    if (t < endTs && close > 0 && (!best || t > best.t)) best = { t, close };
  }
  return best && endTs - best.t <= 6 * 3600 ? best.close : null; // ignore if the last trade was >6h before close
}

/**
 * USD price of each coin at `endTs`. Coins we can't price are left out (caller falls back).
 * @returns {Promise<{[mint:string]:number}>}
 */
export async function closePrices(mints, endTs, weekId) {
  const key = `closepx:${weekId}`;
  const ids = [...new Set(mints)];
  if (!ids.length) return {};
  const cachedRaw = await pipeline(ids.map((m) => ["HGET", key, m]));
  const out = {};
  const need = [];
  ids.forEach((m, i) => {
    const v = cachedRaw[i];
    if (v == null) need.push(m);
    else if (Number(v) > 0) out[m] = Number(v);
  });
  if (!need.length) return out;

  let pools = {};
  try { pools = await topPools(need); } catch { return out; }
  const save = [];
  for (const m of need) {
    const pool = pools[m];
    if (!pool) { save.push([m, "0"]); continue; }
    try {
      const j = await gt(`/networks/solana/pools/${pool}/ohlcv/minute?aggregate=15&before_timestamp=${endTs}&limit=8&currency=usd&token=${m}`);
      const px = closeAt(j?.data?.attributes?.ohlcv_list, endTs);
      save.push([m, px ? String(px) : "0"]);
      if (px) out[m] = px;
    } catch (e) {
      if (String(e.message).includes("rate_limited")) break; // try the rest next time
    }
  }
  if (save.length) await redis("HSET", key, ...save.flat());
  return out;
}
