// Salary cap rules, prices, teams and leaderboards.
import { TRADERS, TRADER_BY_ID } from "./traders.js";
import { redis, getJSON, hgetallJSON } from "./redis.js";
import { shiftWeek } from "./weeks.js";

export const BUDGET = 100;
export const TEAM_SIZE = 5;
export const PRICE_MIN = 5, PRICE_MAX = 35;

const basePrices = () => Object.fromEntries(TRADERS.map((t) => [t.id, t.price]));

/** New price from last price and the trader's last finished week. Pure. */
export function nextPrice(price, score) {
  if (!score) return price;
  if (score.inactive) return Math.max(PRICE_MIN, price - 1);
  const move = Math.max(-4, Math.min(4, Math.round(score.ret / 25)));
  return Math.max(PRICE_MIN, Math.min(PRICE_MAX, price + move));
}

/**
 * Prices for a week. Fixed the first time anyone asks, from the previous week's prices
 * and the results of the last finished week (two weeks back), so they never change while
 * people are picking.
 */
export async function getPrices(weekId) {
  const stored = await getJSON(`prices:${weekId}`);
  const base = basePrices();
  if (stored) return { ...base, ...stored };
  const prev = (await getJSON(`prices:${shiftWeek(weekId, -1)}`)) || base;
  const results = await hgetallJSON(`scores:${shiftWeek(weekId, -2)}`);
  const prices = {};
  for (const t of TRADERS) prices[t.id] = nextPrice(prev[t.id] ?? t.price, results[t.id]);
  await redis("SET", `prices:${weekId}`, JSON.stringify(prices), "NX");
  return { ...base, ...((await getJSON(`prices:${weekId}`)) || prices) };
}

/** Check a team against the rules. Returns an error message or null. Pure. */
export function validateTeam(picks, captain, prices) {
  if (!Array.isArray(picks) || picks.length !== TEAM_SIZE) return `Pick exactly ${TEAM_SIZE} traders.`;
  if (new Set(picks).size !== TEAM_SIZE) return "You picked the same trader twice.";
  for (const id of picks) if (!TRADER_BY_ID[id]) return "One of your traders isn't in the game.";
  const cost = picks.reduce((s, id) => s + (prices[id] ?? TRADER_BY_ID[id].price), 0);
  if (cost > BUDGET) return `That team costs ${cost} credits. Your budget is ${BUDGET}.`;
  if (!picks.includes(captain)) return "Choose a captain from your 5 traders.";
  return null;
}

export function cleanNickname(s, address) {
  const n = String(s || "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 20);
  return n || address.slice(0, 4) + "…" + address.slice(-4);
}

/** A team's points for a week: sum of its traders' % returns, captain counted twice. Pure. */
export function teamPoints(team, scores) {
  let pts = 0;
  for (const id of team.picks || []) {
    const r = scores[id]?.ret || 0;
    pts += id === team.captain ? 2 * r : r;
  }
  return Math.round(pts * 10) / 10;
}

export async function leaderboard(weekId, me, limit = 100) {
  const [teams, scores] = await Promise.all([hgetallJSON(`teams:${weekId}`), hgetallJSON(`scores:${weekId}`)]);
  const rows = Object.entries(teams).map(([address, t]) => ({
    address, name: t.nickname || cleanNickname("", address), points: teamPoints(t, scores),
    captain: TRADER_BY_ID[t.captain]?.name || null,
  })).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  rows.forEach((r, i) => { r.rank = i + 1; });
  const mine = me ? rows.find((r) => r.address === me) || null : null;
  const strip = (r) => r && ({ rank: r.rank, name: r.name, points: r.points, captain: r.captain, short: r.address.slice(0, 4) + "…" + r.address.slice(-4), me: r.address === me });
  return { week: weekId, players: rows.length, rows: rows.slice(0, limit).map(strip), me: strip(mine) };
}
