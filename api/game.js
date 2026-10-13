// GET  /api/game                 → everything the page needs (week, traders, prices, live scores, my teams)
// POST /api/game  { picks, captain, nickname }   (signed in) → saves your team for the upcoming week
import { TRADERS } from "../lib/traders.js";
import { calendar } from "../lib/weeks.js";
import { hgetallJSON, redis, getJSON, hasDatabase } from "../lib/redis.js";
import { sessionAddress } from "../lib/auth.js";
import { BUDGET, TEAM_SIZE, getPrices, validateTeam, cleanNickname, teamPoints } from "../lib/game.js";
import { readBody, send } from "../lib/http.js";

export default async function handler(req, res) {
  if (!hasDatabase() && process.env.VERCEL) {
    return send(res, 503, { error: "The game database isn't connected yet. Add Upstash Redis in Vercel → Storage." });
  }
  try {
    const cal = calendar();
    const me = await sessionAddress(req);

    if (req.method === "POST") {
      if (!me) return send(res, 401, { error: "Connect your wallet first." });
      const body = await readBody(req);
      if (Math.floor(Date.now() / 1000) >= cal.upcoming.lockAt) return send(res, 409, { error: "Teams are locked. Try again in a minute." });
      const prices = await getPrices(cal.upcoming.id);
      const picks = Array.isArray(body.picks) ? body.picks.map(String) : [];
      const err = validateTeam(picks, String(body.captain || ""), prices);
      if (err) return send(res, 400, { error: err });
      const nickname = cleanNickname(body.nickname, me);
      const team = { picks, captain: String(body.captain), nickname, at: Math.floor(Date.now() / 1000) };
      await redis("HSET", `teams:${cal.upcoming.id}`, me, JSON.stringify(team));
      await redis("SET", `user:${me}`, JSON.stringify({ nickname }));
      return send(res, 200, { ok: true, team, week: cal.upcoming.id });
    }

    if (req.method !== "GET") return send(res, 405, { error: "Use GET or POST." });

    const [upPrices, curPrices, curScores, lastScores, upTeams, curTeams, user] = await Promise.all([
      getPrices(cal.upcoming.id),
      getPrices(cal.current.id),
      hgetallJSON(`scores:${cal.current.id}`),
      hgetallJSON(`scores:${cal.last.id}`),
      hgetallJSON(`teams:${cal.upcoming.id}`),
      hgetallJSON(`teams:${cal.current.id}`),
      me ? getJSON(`user:${me}`) : null,
    ]);

    const pickedBy = {};
    const nTeams = Object.keys(upTeams).length;
    for (const t of Object.values(upTeams)) for (const id of t.picks || []) pickedBy[id] = (pickedBy[id] || 0) + 1;

    const traders = TRADERS.map((t) => {
      const live = curScores[t.id];
      const last = lastScores[t.id];
      return {
        id: t.id, name: t.name, x: t.x || null,
        price: upPrices[t.id], priceNow: curPrices[t.id],
        live: live ? { ret: live.ret, spent: live.spent, trades: live.trades, inactive: live.inactive, at: live.at } : null,
        last: last ? { ret: last.ret, inactive: last.inactive } : null,
        pickedPct: nTeams ? Math.round(((pickedBy[t.id] || 0) / nTeams) * 100) : 0,
      };
    });

    let mine = null;
    if (me) {
      const cur = curTeams[me] || null;
      let rank = null;
      if (cur) {
        const pts = Object.values(curTeams).map((t) => teamPoints(t, curScores)).sort((a, b) => b - a);
        rank = pts.indexOf(teamPoints(cur, curScores)) + 1;
      }
      mine = {
        address: me, nickname: user?.nickname || cleanNickname("", me),
        upcoming: upTeams[me] || null,
        current: cur ? { ...cur, points: teamPoints(cur, curScores), rank, players: Object.keys(curTeams).length } : null,
      };
    }

    return send(res, 200, {
      now: cal.now, current: cal.current, upcoming: cal.upcoming,
      budget: BUDGET, teamSize: TEAM_SIZE, players: nTeams,
      demo: !process.env.HELIUS_API_KEY,
      traders, me: mine,
    });
  } catch (e) {
    return send(res, 500, { error: "Something went wrong loading the game." });
  }
}
