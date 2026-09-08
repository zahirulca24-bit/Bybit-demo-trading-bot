# Bybit Demo Trading Bot

This project runs as a Node.js web service on Render and is configured for Bybit **Demo Trading** only (`BYBIT_DEMO=true`).

## Final Strict 6-Gate + Risk Rules

**Last updated:** Tuesday, 08 September 2026 — Asia/Dhaka

The frontend blueprint and production runtime are aligned to these strict automated-entry rules:

- **Gate 1 — 24h Turnover:** minimum **$25M**.
- **Gate 2 — Trend:** **EMA50/EMA200 direction + confirmed price must be on the correct side of EMA50** for the intended trade direction.
- **Gate 3 — Spread:** maximum **0.08%** using a fresh bid/ask check.
- **Gate 4 — ATR:** **0.30%–1.20%**.
- **Gate 5 — Open Interest:** **real Bybit 1h OI expansion >= +0.50%**; unavailable OI **fails closed**.
- **Gate 6 — RSI:** **Long 52–62 / Short 38–48** on a confirmed closed candle.
- **Confirmed candles only:** entry validation uses confirmed closed candles, not an in-progress candle.
- **Breakout:** previous high/low breakout is a **soft confirmation/scoring bonus only**, never a hard gate.
- **Duplicate exposure:** a new entry is blocked while the same symbol already has an open position.
- **Same-symbol cooldown:** wait **10 minutes** after a close before re-entering that symbol.
- **Maximum concurrent positions:** **3**.
- **Position margin:** **$50 USDT** at **10x leverage**, targeting about **$500 notional** per position.
- **Daily circuit breaker:** **net daily PnL <= -$50** blocks **new entries only**.
- **3 consecutive losses:** pause new entries for **30 minutes**.
- **Existing positions:** continue normal management/closing while an entry breaker is active.
- **Stop-loss discipline:** SL may be tightened but must **never be widened**.
- **Legacy entry path:** loose legacy auto-entry remains disabled; automated entries use the strict confirmed scanner path.

## UTC Trading-Day Stats

Trading-day analytics and daily risk accounting use one shared UTC day window:

**00:00:00.000 UTC → now**

At every new UTC day, the following values naturally start fresh because they are calculated only from records inside the new UTC window:

- Today's Total Opened
- Closed Trades Today
- Wins / Losses Today
- TP / SL / Trailing / Manual / Other exits Today
- Realized PnL Today
- live Unrealized PnL
- Net Daily PnL
- the **-$50 daily entry circuit breaker** calculation

This daily reset is an accounting/window reset only. It does **not** delete trade history, alter Bybit wallet balance/equity, close positions, stop the bot, disable scanner auto-trade, or reset strict settings.

Active positions remain live across midnight. A position opened yesterday and still open today remains an active position, but it is **not** counted as "Opened Today". A position opened yesterday and closed today contributes to **Closed Trades Today** and **Realized PnL Today**, but not to **Opened Today**.

Exit categories are mutually exclusive. Each closed-today trade is classified as exactly one of **TP**, **SL**, **Trailing**, **Manual**, or **Other / Unknown**. When reliable exit-reason metadata is unavailable, analytics use **Other / Unknown** instead of inferring an exit from PnL or fabricating a cause.

The daily circuit breaker uses this same UTC boundary. Therefore, a prior day's realized loss (for example **-$60**) does not keep the next UTC day's entries blocked. At 00:00 UTC, realized daily PnL starts from the new day's records, while current open-position unrealized PnL remains live in net daily risk accounting.

### Consecutive-loss pause semantics

The strict **3 consecutive losses => 30-minute new-entry pause** remains a **rolling timestamp-based rule across UTC midnight**. It is intentionally separate from UTC daily PnL accounting and expires naturally 30 minutes after the latest qualifying loss sequence. This PR does not weaken or change that behavior.

## Performance Baseline Reset

The History / Analytics view includes a clearly separate action named **Reset Performance Baseline**. It is an analytics-only reset for comparing strategy performance from a chosen point forward.

**Performance Baseline Reset is independent from UTC daily trading stats.** Resetting a performance baseline at any time does not reset Today's counters, daily PnL, or the daily breaker. Likewise, crossing 00:00 UTC does not remove or replace the active Reset # baseline.

A baseline reset:

- preserves all previous trade/history data;
- preserves bot running state;
- preserves scanner auto-trade state;
- preserves strict risk settings;
- preserves Bybit wallet balance and equity;
- does **not** modify or zero any Bybit account data;
- creates a new snapshot labelled **Reset #1**, **Reset #2**, and so on;
- stores reset date/time, wallet balance, estimated equity, cumulative realized-PnL reference, and trade-count reference;
- keeps previous reset snapshots for **Before Reset vs Reset #N** comparison.

After a reset, analytics are presented from a zero performance baseline while the actual account stays untouched. For example, if estimated equity is **$945** at reset, that point is displayed as **0.00 PnL**. If equity later becomes **$970**, net performance since that reset is approximately **+$25**; if it becomes **$930**, it is approximately **-$15**.

Post-reset analytics include:

- realized PnL since reset;
- unrealized PnL;
- net PnL since reset;
- total trades since reset;
- wins / losses and win rate;
- TP / SL / trailing exit counts when recognizable from available trade reasons;
- average PnL per trade.

Baseline history is persisted in durable browser storage (`localStorage`) so it survives page reloads and browser/app restarts on the same browser profile. This storage is analytics metadata only; it does not call bot stop, scanner disable, settings reset, circuit-breaker reset, or trade deletion paths.

If a separate circuit-breaker reset control is added in the future, it must be labelled **Reset Circuit Breaker** so it cannot be confused with the analytics baseline action.

## Current Render Production Service

- **Service:** `bybit-demo-trading-bot`
- **Branch:** `main`
- **Auto-deploy:** ON
- **Region:** Singapore
- **Build:** `npm ci && npm run build`
- **Start:** `npm start`
- **URL:** `https://bybit-demo-trading-bot.onrender.com`

## Run locally

1. Install Node.js 20 or 22.
2. Copy `.env.example` to `.env` and enter your own values.
3. Run `npm ci` and then `npm run dev`.

The local server runs on `http://localhost:3000` by default.

## Deploy on Render

1. Connect this repository to Render. Do not commit a real `.env` file.
2. Add required secrets:
   - `BYBIT_API_KEY`
   - `BYBIT_API_SECRET`
3. Keep `BYBIT_DEMO=true` for this demo-trading service.
4. Configure optional `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID` as needed.
5. Render builds with `npm ci && npm run build` and starts with `npm start`.

For safety, use a Bybit API key restricted to Demo Trading and keep withdrawal permissions disabled. Sensitive endpoints are protected when `APP_SECRET` is configured.
