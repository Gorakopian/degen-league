// GET  /api/winners  → top 3 of each finished week (newest first). Admins also get full wallet addresses.
// POST /api/winners  { week, address, paid }  (admins only) → mark a winner as paid / not paid
// Admins are the wallets listed in the ADMIN_WALLETS setting (comma separated).
import { calendar } from "../lib/weeks.js";
import { seasonWeeks, teamPoints, cleanNickname } from "../lib/game.js";
import { sessionAddress } from "../lib/auth.js";
import { hasDatabase, hgetallJSON, redis } from "../lib/redis.js";
import { readBody, send } from "../lib/http.js";
import { TRADER_BY_ID } from "../lib/traders.js";

const admins = () => (process.env.ADMIN_WALLETS || "").split(",").map((s) => s.trim()).filter(Boolean);
const prizes = () => (process.env.PRIZES || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 3);

export default async function handler(req, res) {
  if (!hasDatabase() && process.env.VERCEL) return send(res, 503, { error: "The game database isn't connected yet." });
  try {
    const me = await sessionAddress(req);
    const isAdmin = !!me && admins().includes(me);
    const cal = calendar();

    if (req.method === "POST") {
      if (!isAdmin) return send(res, 403, { error: "Only the game admin can do that." });
      const { week, address, paid } = await readBody(req);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(week)) || typeof address !== "string") return send(res, 400, { error: "Missing week or wallet." });
      if (paid) await redis("HSET", `paid:${week}`, address, String(Math.floor(Date.now() / 1000)));
      else await redis("HDEL", `paid:${week}`, address);
      return send(res, 200, { ok: true });
    }
    if (req.method !== "GET") return send(res, 405, { error: "Use GET or POST." });

    const finished = (await seasonWeeks(cal.last.id)).reverse().slice(0, 8);
    const weeks = [];
    for (const w of finished) {
      const [teams, scores, paidRaw] = await Promise.all([
        hgetallJSON(`teams:${w}`), hgetallJSON(`scores:${w}`), redis("HGETALL", `paid:${w}`),
      ]);
      const paid = {};
      for (let i = 0; i < (paidRaw || []).length; i += 2) paid[paidRaw[i]] = Number(paidRaw[i + 1]);
      const picked = new Set(Object.values(teams).flatMap((t) => t.picks || []));
      const final = [...picked].every((id) => scores[id]?.final);
      const top = Object.entries(teams)
        .map(([address, t]) => ({ address, name: t.nickname || cleanNickname("", address), points: teamPoints(t, scores), captain: TRADER_BY_ID[t.captain]?.name || null }))
        .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name))
        .slice(0, 3)
        .map((r, i) => ({
          rank: i + 1, name: r.name, points: r.points, captain: r.captain,
          short: r.address.slice(0, 4) + "…" + r.address.slice(-4),
          me: r.address === me,
          ...(isAdmin ? { address: r.address, paidAt: paid[r.address] || null } : { paid: !!paid[r.address] }),
        }));
      weeks.push({ week: w, players: Object.keys(teams).length, final, winners: top });
    }
    return send(res, 200, { admin: isAdmin, prizes: prizes(), weeks });
  } catch {
    return send(res, 500, { error: "Couldn't load the winners." });
  }
}
