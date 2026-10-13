// Reading Solana wallets: Helius for transactions, Jupiter for prices.
export const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const STABLES = new Set([USDC, USDT]);
const QUOTES = new Set([WSOL, USDC, USDT]);
export const SOL_NOISE = 0.0005;

/**
 * What one transaction did to a wallet: SOL change (incl. wrapped SOL), stablecoin change,
 * and memecoin balance changes. Works on Helius "enhanced transaction" objects.
 */
export function walletDeltas(tx, wallet) {
  let sol = 0;
  const tokens = new Map();
  for (const acc of tx.accountData || []) {
    if (acc.account === wallet) sol += (Number(acc.nativeBalanceChange) || 0) / 1e9;
    for (const ch of acc.tokenBalanceChanges || []) {
      if (ch.userAccount !== wallet) continue;
      const raw = ch.rawTokenAmount || {};
      const amt = Number(raw.tokenAmount) / Math.pow(10, Number(raw.decimals) || 0);
      if (!Number.isFinite(amt) || amt === 0) continue;
      tokens.set(ch.mint, (tokens.get(ch.mint) || 0) + amt);
    }
  }
  sol += tokens.get(WSOL) || 0;
  let usd = 0;
  for (const m of STABLES) usd += tokens.get(m) || 0;
  const coins = [...tokens.entries()].filter(([m, a]) => !QUOTES.has(m) && Math.abs(a) > 0);
  return { sol, usd, coins };
}

/** One page (up to 100) of a wallet's transactions, oldest first, from `fromTs` up to `toTs`. */
export async function fetchTxPage(address, apiKey, fromTs, toTs) {
  const url = new URL(`https://mainnet.helius-rpc.com/v0/addresses/${address}/transactions`);
  url.searchParams.set("api-key", apiKey);
  url.searchParams.set("limit", "100");
  url.searchParams.set("sort-order", "asc");
  url.searchParams.set("gte-time", String(fromTs));
  url.searchParams.set("lt-time", String(toTs));
  const res = await fetch(url);
  if (res.status === 429) throw new Error("helius_rate_limited");
  if (res.status === 404) return []; // no transactions in this window
  if (!res.ok) throw new Error(`helius_${res.status}`);
  const j = await res.json();
  return Array.isArray(j) ? j : [];
}

/** Current USD prices from Jupiter. Returns {mint: price}. */
export async function fetchPrices(mints) {
  const out = {};
  const ids = [...new Set(mints)];
  for (let i = 0; i < ids.length; i += 50) {
    try {
      const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids.slice(i, i + 50).join(",")}`);
      if (!res.ok) continue;
      const j = await res.json();
      for (const [mint, v] of Object.entries(j || {})) {
        const p = Number(v?.usdPrice);
        if (p > 0) out[mint] = p;
      }
    } catch { /* keep going */ }
  }
  return out;
}
