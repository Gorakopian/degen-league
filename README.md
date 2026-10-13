# Degen League

Fantasy league for memecoin traders. Players pick 5 real trader wallets within a 100-credit budget,
choose a captain, and score on those wallets' on-chain returns each week. Free to play, sign in with a Solana wallet.

## How the game works

- Every week runs **Monday 00:00 UTC → next Monday 00:00 UTC**.
- You pick your team for **next week**, and can change it until it locks on Monday.
- A trader's score is their **% return on coins they bought that week**: what they got back from selling,
  plus what they still hold at today's price, compared with what they spent. Old bags they dump don't count.
- A trader who spends less than 1 SOL in the week scores 0.
- Team points = the 5 returns added up, captain counted twice.
- Open positions count: coins bought that week and still held are valued at their price when the week closes
  (Monday 00:00 UTC, from GeckoTerminal price charts), so every trader is valued at the same moment.
- Prices start between 8 and 30 credits (best-known traders highest) and move each week with results (±4 max, between 5 and 35).
- **Season ranking** adds up every week's points. **Winners** shows the top 3 of every finished week.

## What's inside

| File | What it does |
|---|---|
| `index.html` | The website: connect wallet, trader market, your squad, live team, leaderboard, rules |
| `api/auth.js` | Wallet sign-in: the wallet signs a message, the server checks it and gives a session |
| `api/game.js` | Loads the game (week, prices, live scores, your teams) and saves your team |
| `api/leaderboard.js` | Weekly standings |
| `api/cron.js` | Updates trader scores from the blockchain, a few traders at a time |
| `api/winners.js` | Top 3 per finished week; the admin can see full wallets and mark prizes as paid |
| `lib/traders.js` | The 100 traders, their X accounts and starting prices. Edit this file to add or remove traders |
| `lib/scoring.js` | Reads each trader's swaps for the week and works out their return |
| `lib/closeprice.js` | Prices at the exact moment a week closes, for open positions |
| `lib/game.js` | Budget rules, weekly prices, team points |
| `lib/auth.js`, `lib/redis.js`, `lib/chain.js`, `lib/weeks.js`, `lib/http.js` | Helpers |
| `scripts/dev.js` | Run it on your own computer (not used by Vercel) |

## Put it online

1. **GitHub:** the code lives in its own repository (separate from Roaster).
2. **Vercel → Add New → Project**, import the repository, click **Deploy**.
3. **Database:** in the new Vercel project open **Storage → Create Database → Upstash for Redis** (free plan),
   and connect it to this project. Vercel adds the database keys for you.
4. **Settings → Environment Variables**, add:
   - `HELIUS_API_KEY`: your Helius key (the same one as Roaster is fine). Without it scores are simulated (demo mode).
   - `CRON_SECRET`: any long random text you make up. Protects the score updater.
5. **Deployments → Redeploy** so the new settings are used.

## Paying winners

The admin wallet and the prizes (1 SOL, 0.5 SOL, 0.25 SOL) are set in `lib/config.js`.
If the prizes change, also update the Rules text in `index.html`.

Every Monday, open the **Winners** tab while signed in with your admin wallet. You'll see the top 3 of the week
that just ended with their full wallet addresses. Send the prizes from your own wallet (Phantom), then press
**Mark paid** so players can see it was paid. Wait until "final scores still coming in" disappears first.

## Keeping scores fresh

Scores update in three ways:
- When someone opens the site, it quietly updates a few traders.
- Vercel runs the updater once a day (free plan limit).
- Recommended: a free pinger such as **cron-job.org** calling
  `https://YOUR-SITE.vercel.app/api/cron?key=YOUR_CRON_SECRET` every 30 minutes.

Each trader is updated at most once per hour (`MIN_REFRESH_MINUTES`, default 60). Every update reads that trader's
new transactions from Helius, so check your Helius usage page after the first week and raise
`MIN_REFRESH_MINUTES` if you get close to your plan's limit.

## Run it on your computer

Install Node.js 18+, then in this folder: `npm run dev` and open http://localhost:3000.
Without database keys it keeps everything in memory. `npm test` runs the tests.

## Good to know

- Trader list sources: KolExplorer (kolexplorer.com) for X accounts and wallets, and the public Kolscan leaderboard (kolscan.io), October 2026.
- Signing in only signs a text message. It can't move funds and costs nothing.
- Free to play. If you add prizes later, keep entry free to stay clear of gambling rules, and check with a lawyer.
