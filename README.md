# Bybit Demo Trading Bot

This project is configured to run as a Node.js web service on Render. It is set to use Bybit **Demo Trading** only (`BYBIT_DEMO=true`).

## Final Strict Risk Rules

**Last updated:** Tuesday, 08 September 2026 — 01:27 PM (Asia/Dhaka)

The current agreed risk profile is:

- **Gate 1 Turnover:** minimum **$25M**
- **Gate 2 Trend:** EMA50/EMA200 direction must match, and price must stay on the correct side of EMA50
- **Gate 3 Spread:** maximum **0.08%**
- **Gate 4 ATR:** minimum **0.30%**, maximum **1.20%**
- **Gate 5 OI:** minimum **+0.5% 1h open-interest expansion**
- **Gate 6 RSI:** Long **52–62**, Short **38–48**
- **Confirmed candle only:** entries must use confirmed closed candles
- **Breakout confirmation:** not a hard gate; use only as a **soft confirmation / scoring bonus**
- **No duplicate same-symbol position:** while a symbol has an OPEN position, no second position on the same symbol is allowed
- **Post-close same-symbol cooldown:** after a symbol closes, wait **10 minutes** before a new entry on that symbol
- **Max concurrent positions:** **3**
- **Position margin:** **$50** per position
- **Daily circuit breaker:** cumulative daily net loss of **-$50** stops all new entries for the day
- **Consecutive-loss breaker:** **3 consecutive losses → 30-minute pause** before new entries
- **Stop-loss policy:** do **not** widen SL to compensate for bad entries; improve entry quality and reduce exposure instead
- **Breaker behavior:** existing open positions may still be managed/closed after a breaker triggers; only **new entries** are blocked

The purpose of this profile is to reduce overtrading, duplicate exposure, bad entries, and heavy drawdowns without making the scanner so strict that valid trades disappear.

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
