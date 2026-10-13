// GET /api/leaderboard?week=current|last  → top 100 teams for that week, plus your own rank
import { calendar } from "../lib/weeks.js";
import { leaderboard } from "../lib/game.js";
import { sessionAddress } from "../lib/auth.js";
import { hasDatabase } from "../lib/redis.js";
import { send, query } from "../lib/http.js";

export default async function handler(req, res) {
  if (!hasDatabase() && process.env.VERCEL) return send(res, 503, { error: "The game database isn't connected yet." });
  try {
    const cal = calendar();
    const which = query(req).week === "last" ? cal.last : cal.current;
    const me = await sessionAddress(req);
    return send(res, 200, { ...(await leaderboard(which.id, me)), start: which.start, end: which.end });
  } catch {
    return send(res, 500, { error: "Couldn't load the leaderboard." });
  }
}
