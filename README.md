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


## Exit Audit & Trade Quality — 2026-09-09

**Updated:** Wednesday, 09 September 2026 — 02:45 PM (Asia/Dhaka)

### Exit classification

Daily closed trades are classified from real exchange/order metadata, never from PnL sign. Correlation uses exact `orderId`/`orderLinkId` first, then symbol, close-time proximity, reduce-only/closed-size evidence and quantity proximity. Classification precedence is **exact Stop Loss → exact Take Profit → exact Trailing Stop → explicit app/user Manual close → Other / Unknown**. `stopOrderType` and `createType` are preferred; explicit app close orders carry `bot-manual-*` or `bot-trail-*` link IDs. `Unknown / Other` remains the fallback when Bybit does not expose enough reliable metadata. Audit fields include `classifiedBy`, matched order/link IDs and raw stop/create types when available.

### Entry quality and adaptive stop

The strict six-gate eligibility remains: **$25M turnover**, **EMA50/EMA200 direction + confirmed price on the correct side of EMA50**, **spread <= 0.08%**, **ATR 0.30%–1.20%**, **real Bybit 1h OI expansion >= +0.50% (unavailable fails closed)**, and confirmed 5m candle agreement. RSI is rebalanced to **Long 50–64 / Short 36–50**. Breakout remains a **soft scoring/confirmation bonus only**, never a hard gate.

Automated entries now use a deterministic ATR/structure-aware stop. ATR multiplier interpolates from **1.20x at 0.30% ATR to 1.50x at 1.20% ATR**. The structure candidate is the confirmed **6-candle swing low/high plus a 0.15 ATR buffer**. The initial stop uses the farther protective candidate, is never tighter than the legacy **1.00%** noise tolerance, and is capped at **1.80%** maximum distance. When the stop is wider than 1%, notional is reduced from the normal ~$500 so gross price-risk does not exceed the previous `$500 × 1% ≈ $5` envelope; the configured **$50 margin remains a cap**, leverage stays **10x**, and quantity is never increased above the normal ~$500 notional.

Break-even and app-managed trailing are delayed until favorable movement reaches the maximum of **1.00%**, **1.0R (initial stop distance)**, or **1.25× ATR%**. Trailing retrace distance is `max(0.50%, min(1.00%, 0.75×ATR%))`. Both mechanisms only tighten risk; SL is never widened after placement.

There is **no daily trade-count target or arbitrary max-trades-per-day cap**. The objective is to reduce avoidable wick/poor-entry stop-outs while preserving valid opportunity flow. Existing safety controls remain unchanged: max **3** positions, same-symbol **10m** cooldown, daily UTC net PnL **<= -$50** blocks new entries only, **3 consecutive losses = 30m** pause, and existing positions continue to be managed while the daily breaker blocks entries.
