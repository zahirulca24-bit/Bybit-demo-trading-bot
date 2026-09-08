# Bybit Demo Trading Bot

This project is configured to run as a Node.js web service on Render. It is set to use Bybit **Demo Trading** only (`BYBIT_DEMO=true`).

## Final Strict Risk Rules

**Last updated:** Tuesday, 08 September 2026 — 03:06 PM (Asia/Dhaka)

These rules are the active target configuration for automated entries and risk control:

- **Gate 1 — 24h Turnover:** minimum **$25M**.
- **Gate 2 — 15m Trend:** EMA50/EMA200 direction must match the trade direction, and confirmed price must be on the correct side of EMA50.
- **Gate 3 — Spread:** maximum **0.08%**, using a fresh bid/ask check.
- **Gate 4 — 5m ATR:** minimum **0.30%**, maximum **1.20%**.
- **Gate 5 — Open Interest:** minimum **+0.50% 1h expansion** from real Bybit OI history; unavailable OI fails closed.
- **Gate 6 — RSI:** Long **52–62**, Short **38–48**, using confirmed closed 5m candles only.
- **Candle confirmation:** Long prefers close above previous close with a bullish body; Short prefers close below previous close with a bearish body.
- **Breakout:** previous 5m high/low breakout is a **bonus only**, not a mandatory hard gate.
- **Duplicate exposure:** while a symbol already has an open position, a new entry in that symbol is blocked.
- **Same-symbol cooldown:** after a position closes, wait **10 minutes** before re-entry in that symbol.
- **Maximum concurrent positions:** **3**.
- **Position margin:** **$50 USDT** per trade. At 10x leverage this targets about **$500 notional** per position.
- **Daily circuit breaker:** when net daily PnL reaches **−$50 USDT**, block new entries. Existing positions remain open and continue to be managed/closed by TP, SL, break-even, trailing, or manual exit logic.
- **Consecutive-loss breaker:** **3 losses in a row → 30-minute pause** before new entries.
- **Stop-loss discipline:** the SL may be tightened to break-even/trailing protection but must **never be widened** to increase risk.
- **Legacy entry path:** loose 1m auto-entry is disabled; new automated entries come from the strict confirmed 5m scanner.

## Run locally

1. Install Node.js 20 or 22.
2. Copy `.env.example` to `.env` and enter your own values.
3. Run `npm ci` and then `npm run dev`.

The local server runs on `http://localhost:3000` by default.

## Deploy on Render

1. Create a new GitHub repository and push this entire project (including `render.yaml`). Do not commit a real `.env` file.
2. In Render, select **New +** → **Blueprint**, then connect the GitHub repository.
3. Render will read `render.yaml`. Add the following required secrets during setup:
   - `BYBIT_API_KEY` — a key created for Bybit Demo Trading
   - `BYBIT_API_SECRET` — its matching secret
4. Render generates `APP_SECRET` automatically. Add optional `DATABASE_URL` (for persistent data), `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID` later in the service Environment settings if needed.
5. Click **Apply**. Render runs `npm ci && npm run build`, then starts the app with `npm start`.

For safety, use a Bybit API key restricted to Demo Trading and keep withdrawal permissions disabled. The service protects sensitive endpoints when `APP_SECRET` is set; requests to those endpoints must include it as `Authorization: Bearer <APP_SECRET>` (or `x-app-secret`).

## GitHub quick start

```bash
git init
git add .
git commit -m "Prepare Bybit demo bot for Render"
git branch -M main
git remote add origin https://github.com/YOUR-USER/YOUR-REPOSITORY.git
git push -u origin main
```
