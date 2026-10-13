// GET /api/leaderboard?week=current|last|season  → top 100 teams, plus your own rank
import { calendar } from "../lib/weeks.js";
import { leaderboard, seasonBoard } from "../lib/game.js";
import { sessionAddress } from "../lib/auth.js";
import { hasDatabase } from "../lib/redis.js";
import { send, query } from "../lib/http.js";

export default async function handler(req, res) {
  if (!hasDatabase() && process.env.VERCEL) return send(res, 503, { error: "The game database isn't connected yet." });
  try {
    const cal = calendar();
    const me = await sessionAddress(req);
    const q = query(req).week;
    if (q === "season") return send(res, 200, await seasonBoard(cal.current.id, me));
    const which = q === "last" ? cal.last : cal.current;
    return send(res, 200, { ...(await leaderboard(which.id, me)), start: which.start, end: which.end });
  } catch {
    return send(res, 500, { error: "Couldn't load the leaderboard." });
  }
}
