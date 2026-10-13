// GET /api/cron   (Vercel cron, or an outside pinger with ?key=CRON_SECRET)
// POST /api/cron  (the website calls this quietly after loading, so scores keep moving)
// Refreshes the traders with the oldest scores within ~20 seconds.
import { tick } from "../lib/scoring.js";
import { hasDatabase } from "../lib/redis.js";
import { send, query } from "../lib/http.js";

export default async function handler(req, res) {
  if (!hasDatabase() && process.env.VERCEL) return send(res, 503, { error: "Database not connected." });
  const secret = process.env.CRON_SECRET;
  const auth = req.headers?.authorization || "";
  const trusted = !secret || auth === `Bearer ${secret}` || query(req).key === secret;
  // Visitors can nudge a small refresh; trusted callers get a bigger one
  const budgetMs = trusted && req.method === "GET" ? 45000 : 12000;
  try {
    const r = await tick(process.env.HELIUS_API_KEY, { budgetMs });
    return send(res, 200, r);
  } catch (e) {
    return send(res, 500, { error: "refresh failed" });
  }
}
