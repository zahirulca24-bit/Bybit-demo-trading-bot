import { RestClientV5 } from "bybit-api";
import { TelegramNotifier } from "./TelegramNotifier";
import { dbClaimReportDelivery, dbCompleteReportDelivery, dbGetReportTrades, dbGetSettings, dbSaveSettings } from "../db";
import { classifyClosedTradeExit } from "../utils/exitClassification";
import { normalizeTimestampMs } from "../utils/utcTradingDay";
import {
  CursorPage,
  ClosedTradeLike,
  dailyDeliveryKey,
  finiteOrNull,
  formatMetric,
  formatMoney,
  formatUtcDay,
  formatUtcHourWindow,
  hourlyDeliveryKey,
  maxConsecutiveLosses,
  paginateUntilBoundary,
  previousFullUtcHour,
  previousUtcDay,
  qualityBreakdown,
  ReportWindow,
  safeAverage,
  summarizeClosedTrades,
  splitTelegramMessage,
} from "../utils/tradingReports";

type ReportEngine = {
  getIsRunning(): boolean;
  circuitBreakerTriggered: boolean;
  scanner: { autoTrade: boolean; lastScanTime: number; getState(): any };
  activePositions: any[];
  settings: { maxPositions: number; maxLossUsdt: number; leverage: number; positionMarginUsdt: number };
};

type SourceError = { source: string; reason: string };

type AccountSnapshot = {
  wallet: number | null;
  equity: number | null;
  available: number | null;
  capturedAt: number;
  reliableBoundary?: boolean;
};

type RuntimeMetrics = {
  coverageStart: number;
  lastScannerTimestamp?: number;
  scannedCandidates: number;
  sixGatePasses: number;
  breakoutBonusSetups: number;
  freshCrossSetups: number;
  maxPositionsObserved: number;
  breakerTriggered: boolean;
};

const TICK_MS = 15_000;
const DAILY_REPORT_DELAY_MS = 5_000;

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || "Unknown error");
}

function unixMs(value: any): number {
  return normalizeTimestampMs(value);
}

function inWindow(timestamp: number, window: ReportWindow): boolean {
  return timestamp >= window.startMs && timestamp < window.endMs;
}

function positionLine(position: any): string {
  const symbol = String(position.symbol || "?");
  const side = String(position.side || "?");
  const entry = finiteOrNull(position.avgPrice);
  const mark = finiteOrNull(position.markPrice);
  const pnl = finiteOrNull(position.unrealisedPnl);
  const sl = finiteOrNull(position.stopLoss);
  const tp = finiteOrNull(position.takeProfit);
  const price = (v: number | null) => v === null ? "—" : `$${v.toFixed(v < 1 ? 5 : 2)}`;
  return `• ${symbol} ${side} | Entry ${price(entry)} | Mark ${price(mark)} | uPnL ${formatMoney(pnl)} | SL ${price(sl)} | TP ${price(tp)}`;
}

export class TelegramReportService {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private bybit: RestClientV5,
    private engine: ReportEngine,
    private telegram: TelegramNotifier,
  ) {}

  public start() {
    if (this.timer) return;
    void this.tick(true);
    this.timer = setInterval(() => void this.tick(false), TICK_MS);
    console.log("[TelegramReports] Scheduler started: previous full UTC hour + previous UTC day.");
  }

  public stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(isStartup: boolean) {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      await this.observeRuntime(now);
      await this.captureBoundarySnapshot(now);
      await this.ensureHourlyReport(now, isStartup);
      const currentDayStart = Date.UTC(
        new Date(now).getUTCFullYear(),
        new Date(now).getUTCMonth(),
        new Date(now).getUTCDate(),
      );
      if (now - currentDayStart >= DAILY_REPORT_DELAY_MS) await this.ensureDailyReport(now, isStartup);
    } catch (error) {
      console.error(`[TelegramReports] scheduler warning: ${errorText(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async wasSent(key: string): Promise<boolean> {
    const value = await dbGetSettings(key);
    return Boolean(value?.status === "sent" || value?.sent === true);
  }

  private async sendReportParts(
    key: string,
    type: "hourly" | "daily",
    parts: string[],
    context: Record<string, any>,
  ): Promise<boolean> {
    for (let index = 0; index < parts.length; index++) {
      const partKey = `${key}:p${index + 1}`;
      if (await this.wasSent(partKey)) continue;
      const claim = await dbClaimReportDelivery(partKey);
      if (!claim.persistent) {
        console.error(`TELEGRAM_REPORT_FAILED type=${type} reason=persistent delivery store unavailable`);
        return false;
      }
      if (!claim.claimed) {
        if (await this.wasSent(partKey)) continue;
        return false;
      }
      const result = await this.telegram.send(parts[index]);
      if (!result.success) {
        await dbCompleteReportDelivery(partKey, false, { type, part: index + 1, reason: String(result.error || "unknown") });
        console.error(`TELEGRAM_REPORT_FAILED type=${type} reason=${String(result.error || "unknown")}`);
        return false;
      }
      await dbCompleteReportDelivery(partKey, true, { type, part: index + 1 });
    }
    await dbCompleteReportDelivery(key, true, { type, ...context });
    const ctx = Object.entries(context).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`TELEGRAM_REPORT_SENT type=${type}${ctx ? ` ${ctx}` : ""}`);
    return true;
  }

  private async ensureHourlyReport(now: number, isStartup: boolean) {
    const window = previousFullUtcHour(now);
    const key = hourlyDeliveryKey(window);
    if (await this.wasSent(key)) return;
    const report = await this.buildHourlyReport(window);
    await this.sendReportParts(key, "hourly", splitTelegramMessage(report), {
      periodStart: new Date(window.startMs).toISOString(),
      periodEnd: new Date(window.endMs).toISOString(),
      startupCatchup: isStartup,
    });
  }

  private async ensureDailyReport(now: number, isStartup: boolean) {
    const window = previousUtcDay(now);
    const key = dailyDeliveryKey(window);
    if (await this.wasSent(key)) return;
    const logicalParts = await this.buildDailyReport(window, now);
    const parts = logicalParts.flatMap((part) => splitTelegramMessage(part));
    await this.sendReportParts(key, "daily", parts, {
      tradingDay: formatUtcDay(window),
      startupCatchup: isStartup,
    });
  }

  private async accountSnapshot(): Promise<{ snapshot: AccountSnapshot; errors: SourceError[] }> {
    const errors: SourceError[] = [];
    try {
      const response: any = await this.bybit.getWalletBalance({ accountType: "UNIFIED", coin: "USDT" });
      if (response.retCode !== 0 || !response.result?.list?.length) throw new Error(response.retMsg || "wallet response unavailable");
      const account = response.result.list[0] || {};
      const coin = account.coin?.find((c: any) => c.coin === "USDT") || account.coin?.[0] || {};
      return {
        snapshot: {
          wallet: finiteOrNull(account.totalWalletBalance ?? coin.walletBalance),
          equity: finiteOrNull(account.totalEquity ?? coin.equity),
          available: finiteOrNull(account.totalAvailableBalance ?? coin.availableToWithdraw),
          capturedAt: Date.now(),
        },
        errors,
      };
    } catch (error) {
      errors.push({ source: "Bybit wallet", reason: errorText(error) });
      return { snapshot: { wallet: null, equity: null, available: null, capturedAt: Date.now() }, errors };
    }
  }

  private async activePositions(): Promise<{ positions: any[]; errors: SourceError[] }> {
    try {
      const response: any = await this.bybit.getPositionInfo({ category: "linear", settleCoin: "USDT" });
      if (response.retCode !== 0) throw new Error(response.retMsg || "position response unavailable");
      return { positions: (response.result?.list || []).filter((p: any) => Number(p.size || 0) > 0), errors: [] };
    } catch (error) {
      return { positions: [], errors: [{ source: "Bybit positions", reason: errorText(error) }] };
    }
  }

  private async pagedRange(
    source: "closedPnL" | "executions" | "orders",
    window: ReportWindow,
  ): Promise<{ items: any[]; errors: SourceError[] }> {
    const errors: SourceError[] = [];
    const timestamp = (item: any) => source === "closedPnL"
      ? unixMs(item.updatedTime || item.execTime || item.createdTime)
      : source === "executions"
        ? unixMs(item.execTime || item.createdTime)
        : unixMs(item.updatedTime || item.createdTime);

    try {
      const fetchPage = async (cursor?: string): Promise<CursorPage<any>> => {
        const common: any = {
          category: "linear",
          startTime: window.startMs,
          endTime: Math.max(window.startMs, window.endMs - 1),
          limit: 100,
          ...(cursor ? { cursor } : {}),
        };
        let response: any;
        if (source === "closedPnL") response = await (this.bybit as any).getClosedPnL(common);
        else if (source === "executions") response = await (this.bybit as any).getExecutionList(common);
        else response = await (this.bybit as any).getHistoricOrders(common);
        if (response?.retCode !== 0) throw new Error(response?.retMsg || `${source} returned non-zero retCode`);
        return { items: response?.result?.list || [], nextCursor: response?.result?.nextPageCursor || null };
      };
      const items = await paginateUntilBoundary(fetchPage, window.startMs, timestamp, 100);
      return { items: items.filter((item) => inWindow(timestamp(item), window)), errors };
    } catch (error) {
      errors.push({ source: `Bybit ${source}`, reason: errorText(error) });
      return { items: [], errors };
    }
  }

  private async reportTrades(window: ReportWindow) {
    const result = await dbGetReportTrades(window.startMs, window.endMs);
    return result;
  }

  private classifyClosed(closed: any[], executions: any[], orders: any[], dbTrades: any[]): ClosedTradeLike[] {
    return closed.map((item) => {
      const classified = classifyClosedTradeExit({
        closedTrade: item,
        executions,
        orders,
        localHistory: dbTrades,
      });
      const closedAt = unixMs(item.updatedTime || item.execTime || item.createdTime);
      const originalSide = item.side === "Sell" ? "LONG" : item.side === "Buy" ? "SHORT" : undefined;
      const dbMatch = dbTrades
        .filter((trade: any) => trade.symbol === item.symbol && trade.closedAt)
        .sort((a: any, b: any) => Math.abs(a.closedAt - closedAt) - Math.abs(b.closedAt - closedAt))[0];
      return {
        pnl: Number(item.closedPnl),
        exitLabel: classified.label,
        side: dbMatch?.side === "Buy" ? "LONG" : dbMatch?.side === "Sell" ? "SHORT" : originalSide,
        openedAt: dbMatch?.openedAt ?? null,
        closedAt,
        entryDiagnostics: dbMatch?.entryDiagnostics || null,
      };
    });
  }

  private openingExecutions(executions: any[], window: ReportWindow) {
    const byOrder = new Map<string, any>();
    for (const item of executions) {
      const t = unixMs(item.execTime || item.createdTime);
      if (!inWindow(t, window)) continue;
      const closedSize = Number(item.closedSize || 0);
      const execQty = Number(item.execQty || 0);
      if (!(execQty > 0) || closedSize > 0) continue;
      const key = String(item.orderId || item.orderLinkId || item.execId || `${item.symbol}:${t}:${item.side}`);
      if (!byOrder.has(key)) byOrder.set(key, item);
    }
    return [...byOrder.values()];
  }

  private async dailyRiskSnapshot(now: number) {
    const dayStart = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate(),
      0, 0, 0, 0,
    );
    const range = { startMs: dayStart, endMs: now + 1 };
    const [closed, positions, recentClosedResult] = await Promise.all([
      this.pagedRange("closedPnL", range),
      this.activePositions(),
      (this.bybit as any).getClosedPnL({ category: "linear", limit: 100 }).catch((error: unknown) => ({ __error: error })),
    ]);
    const recentErrors: SourceError[] = [];
    let recentClosed: any[] | null = null;
    if (recentClosedResult?.__error) recentErrors.push({ source: "Bybit recent closed PnL", reason: errorText(recentClosedResult.__error) });
    else if (recentClosedResult?.retCode !== 0) recentErrors.push({ source: "Bybit recent closed PnL", reason: recentClosedResult?.retMsg || "non-zero retCode" });
    else recentClosed = recentClosedResult?.result?.list || [];

    const realized = closed.errors.length ? null : closed.items.reduce((sum, item) => sum + Number(item.closedPnl || 0), 0);
    const unrealized = positions.errors.length ? null : positions.positions.reduce((sum, item) => sum + Number(item.unrealisedPnl || 0), 0);
    const net = realized !== null && unrealized !== null ? realized + unrealized : null;
    const ordered = recentClosed === null ? [] : [...recentClosed].sort((a, b) => unixMs(b.updatedTime || b.execTime || b.createdTime) - unixMs(a.updatedTime || a.execTime || a.createdTime));
    let consecutiveLosses: number | null = recentClosed === null ? null : 0;
    if (consecutiveLosses !== null) {
      for (const item of ordered) {
        if (Number(item.closedPnl || 0) < 0) consecutiveLosses++;
        else break;
      }
    }
    const lastClose = ordered.length ? unixMs(ordered[0].updatedTime || ordered[0].execTime || ordered[0].createdTime) : 0;
    const pauseRemainingMs = consecutiveLosses === null
      ? null
      : consecutiveLosses >= 3 ? Math.max(0, 30 * 60 * 1000 - (now - lastClose)) : 0;
    return {
      realized,
      unrealized,
      net,
      consecutiveLosses,
      pauseRemainingMs,
      errors: [...closed.errors, ...positions.errors, ...recentErrors],
    };
  }

  private partialWarning(errors: SourceError[]): string {
    if (!errors.length) return "";
    const sources = errors.map((e) => `${e.source}: ${e.reason}`).join("; ");
    return `\n⚠️ Partial data — some upstream trading history could not be retrieved. ${sources}\n`;
  }

  private async buildHourlyReport(window: ReportWindow): Promise<string> {
    const [account, positions, closed, executions, orders, db, risk, runtime] = await Promise.all([
      this.accountSnapshot(),
      this.activePositions(),
      this.pagedRange("closedPnL", window),
      this.pagedRange("executions", window),
      this.pagedRange("orders", window),
      this.reportTrades(window),
      this.dailyRiskSnapshot(window.endMs),
      dbGetSettings(`reportmetrics:h:${new Date(window.startMs).toISOString().slice(0, 13)}`),
    ]);
    const errors: SourceError[] = [
      ...account.errors,
      ...positions.errors,
      ...closed.errors,
      ...executions.errors,
      ...orders.errors,
      ...(db.ok ? [] : [{ source: "Database report trades", reason: db.error || "unavailable" }]),
      ...risk.errors,
    ];
    const dbTrades = db.ok ? db.rows : [];
    const classified = closed.errors.length ? [] : this.classifyClosed(closed.items, executions.items, orders.items, dbTrades);
    const stats = closed.errors.length ? null : summarizeClosedTrades(classified);
    const opens = executions.errors.length ? null : this.openingExecutions(executions.items, window);
    const qualityTrades = dbTrades
      .filter((t: any) => t.openedAt >= window.startMs && t.openedAt < window.endMs && t.entryDiagnostics)
      .map((t: any) => ({ pnl: Number(t.realizedPnl || 0), entryDiagnostics: t.entryDiagnostics }));
    const alignedCount = qualityTrades.filter((t: any) => {
      const d = t.entryDiagnostics;
      return (String(d.trendState).toLowerCase().includes("bull") && d.emaTimingState === "Bullish") ||
        (String(d.trendState).toLowerCase().includes("bear") && d.emaTimingState === "Bearish");
    }).length;
    const freshCrossCount = qualityTrades.filter((t: any) => ["bullish", "bearish"].includes(String(t.entryDiagnostics?.freshCross))).length;
    const avgTiming = safeAverage(qualityTrades.map((t: any) => t.entryDiagnostics?.emaTimingScore));
    const scannerState = this.engine.scanner.getState();
    const dailyRoom = risk.net === null ? null : 50 + risk.net;

    let message = `📊 HOURLY TRADING REPORT\n🕐 ${formatUtcHourWindow(window)}\n`;
    message += this.partialWarning(errors);
    message += `\n💰 Account\n`;
    message += `Wallet: ${formatMoney(account.snapshot.wallet)}\n`;
    message += `Equity: ${formatMoney(account.snapshot.equity)}\n`;
    message += `Available: ${formatMoney(account.snapshot.available)}\n`;
    message += `Realized this hour: ${stats ? formatMoney(stats.realized) : "Unavailable"}\n`;
    message += `Unrealized now: ${formatMoney(risk.unrealized)}\n`;

    message += `\n📈 Trading\n`;
    message += `Opened: ${opens ? opens.length : "Unavailable"}\n`;
    message += `Closed: ${stats ? stats.closed : "Unavailable"}\n`;
    if (stats) {
      message += `W/L: ${stats.wins} / ${stats.losses} | Win rate: ${stats.winRate.toFixed(1)}%\n`;
      message += `TP ${stats.exits.TP} | SL ${stats.exits.SL} | Trail ${stats.exits.Trailing} | Manual ${stats.exits.Manual} | Other ${stats.exits.Other}\n`;
      if (stats.closed === 0) message += `No trades executed during this hour.\n`;
    }

    message += `\n📌 Positions\nActive: ${positions.errors.length ? "Unavailable" : `${positions.positions.length}/3`}\n`;
    if (!positions.errors.length && positions.positions.length) message += `${positions.positions.map(positionLine).join("\n")}\n`;

    message += `\n🤖 Auto strategy\n`;
    message += `Scanner engine: ${this.engine.getIsRunning() ? "ON" : "OFF"}\n`;
    message += `Auto-trade: ${this.engine.scanner.autoTrade ? "ON" : "OFF"}\n`;
    message += `Candidates scanned: ${runtime?.scannedCandidates ?? "Unavailable"}\n`;
    message += `Six-gate passes: ${runtime?.sixGatePasses ?? "Unavailable"}\n`;
    const autoRows = dbTrades.filter((t: any) => t.openedAt >= window.startMs && t.openedAt < window.endMs && t.entryDiagnostics);
    message += `Actual auto entries: ${db.ok ? autoRows.length : "Unavailable"}\n`;
    const lastAuto = autoRows.sort((a: any, b: any) => b.openedAt - a.openedAt)[0];
    message += `Last auto trade: ${lastAuto ? new Date(lastAuto.openedAt).toISOString() : "—"}\n`;

    message += `\n⚡ EMA Timing\n`;
    message += `Aligned: ${db.ok ? alignedCount : "Unavailable"}\n`;
    message += `Fresh Cross: ${db.ok ? freshCrossCount : "Unavailable"}\n`;
    message += `Avg Score: ${avgTiming === null ? "Unavailable" : `${avgTiming.toFixed(2)}/2`}\n`;

    message += `\n🛡 Risk\n`;
    message += `UTC daily realized: ${formatMoney(risk.realized)}\n`;
    message += `Daily net: ${formatMoney(risk.net)}\n`;
    message += `Breaker: ${this.engine.circuitBreakerTriggered ? "ACTIVE" : "SAFE"}\n`;
    message += `Consecutive losses: ${risk.consecutiveLosses === null ? "Unavailable" : risk.consecutiveLosses}\n`;
    message += `Loss pause: ${risk.pauseRemainingMs === null ? "Unavailable" : risk.pauseRemainingMs > 0 ? `ON (${Math.ceil(risk.pauseRemainingMs / 60000)}m)` : "OFF"}\n`;
    message += `Room before -$50 breaker: ${dailyRoom === null ? "Unavailable" : formatMoney(Math.max(0, dailyRoom))}`;
    return message;
  }

  private async buildDailyReport(window: ReportWindow, reportTime: number): Promise<string[]> {
    const [accountEnd, closed, executions, orders, db, runtime] = await Promise.all([
      this.accountSnapshot(),
      this.pagedRange("closedPnL", window),
      this.pagedRange("executions", window),
      this.pagedRange("orders", window),
      this.reportTrades(window),
      dbGetSettings(`reportmetrics:d:${formatUtcDay(window)}`),
    ]);
    const startSnapshot = await dbGetSettings(`reportaccount:${formatUtcDay(window)}`);
    const endSnapshotKey = `reportaccount:${new Date(window.endMs).toISOString().slice(0, 10)}`;
    const storedEndSnapshot = await dbGetSettings(endSnapshotKey);
    const endSnapshot = storedEndSnapshot?.reliableBoundary === true
      ? storedEndSnapshot
      : reportTime - window.endMs <= 60_000 && accountEnd.errors.length === 0
        ? { ...accountEnd.snapshot, reliableBoundary: true }
        : null;
    const errors: SourceError[] = [
      ...accountEnd.errors,
      ...closed.errors,
      ...executions.errors,
      ...orders.errors,
      ...(db.ok ? [] : [{ source: "Database report trades", reason: db.error || "unavailable" }]),
    ];
    const dbTrades = db.ok ? db.rows : [];
    const classified = closed.errors.length ? [] : this.classifyClosed(closed.items, executions.items, orders.items, dbTrades);
    const stats = closed.errors.length ? null : summarizeClosedTrades(classified);
    const opens = executions.errors.length ? null : this.openingExecutions(executions.items, window);
    const dayClosedDb = dbTrades.filter((t: any) => t.closedAt && inWindow(t.closedAt, window));
    const closedWithMetadata: ClosedTradeLike[] = dayClosedDb.map((t: any) => ({
      pnl: Number(t.realizedPnl),
      exitLabel: t.exitReason,
      side: t.side === "Buy" ? "LONG" : "SHORT",
      openedAt: t.openedAt,
      closedAt: t.closedAt,
      entryDiagnostics: t.entryDiagnostics,
    }));
    const quality = qualityBreakdown(closedWithMetadata);
    const longClosed = classified.filter((t) => t.side === "LONG");
    const shortClosed = classified.filter((t) => t.side === "SHORT");
    const longStats = summarizeClosedTrades(longClosed);
    const shortStats = summarizeClosedTrades(shortClosed);
    const openExecs = opens || [];
    const longOpened = openExecs.filter((e: any) => e.side === "Buy").length;
    const shortOpened = openExecs.filter((e: any) => e.side === "Sell").length;
    const sortedPnl = classified.filter((t) => Number.isFinite(t.pnl)).sort((a, b) => b.pnl - a.pnl);
    const durations = closedWithMetadata
      .map((t) => t.openedAt && t.closedAt ? t.closedAt - t.openedAt : NaN)
      .filter(Number.isFinite);
    const avgDurationMs = safeAverage(durations);
    const slDistances = dayClosedDb.map((t: any) => t.entryDiagnostics?.slDistancePercent);
    const avgSl = safeAverage(slDistances);
    const reducedNotional = dayClosedDb.filter((t: any) => {
      const d = t.entryDiagnostics;
      return Number.isFinite(Number(d?.actualMarginUsedUsdt)) && Number(d.actualMarginUsedUsdt) < 49.99;
    }).length;
    const emaScores = dayClosedDb.map((t: any) => t.entryDiagnostics?.emaTimingScore);
    const avgEmaScore = safeAverage(emaScores);
    const freshCrossUsed = dayClosedDb.filter((t: any) => ["bullish", "bearish"].includes(String(t.entryDiagnostics?.freshCross))).length;
    const breakoutTrades = dayClosedDb.filter((t: any) => t.entryDiagnostics?.breakoutBonus === true).length;
    const openAtEnd = db.ok ? db.rows.filter((t: any) => t.openedAt < window.endMs && (!t.closedAt || t.closedAt >= window.endMs)) : [];
    const maxLossStreak = maxConsecutiveLosses([...classified].sort((a, b) => Number(a.closedAt || 0) - Number(b.closedAt || 0)));
    const partial = this.partialWarning(errors);
    const day = formatUtcDay(window);

    const reliableStart = startSnapshot?.reliableBoundary === true ? startSnapshot : null;
    const reliableEnd = endSnapshot;
    const netAccountChange = reliableStart && reliableEnd && Number.isFinite(Number(reliableStart.equity)) && Number.isFinite(Number(reliableEnd.equity))
      ? Number(reliableEnd.equity) - Number(reliableStart.equity)
      : null;

    let part1 = `📈 FULL DAY TRADING REPORT — Daily Report 1/3\nDate: ${day} UTC\n${partial}`;
    part1 += `\n💰 ACCOUNT\n`;
    part1 += `Starting wallet: ${reliableStart ? formatMoney(finiteOrNull(reliableStart.wallet)) : "Unavailable"}\n`;
    part1 += `Starting equity: ${reliableStart ? formatMoney(finiteOrNull(reliableStart.equity)) : "Unavailable"}\n`;
    part1 += `Ending wallet: ${reliableEnd ? formatMoney(finiteOrNull(reliableEnd.wallet)) : "Unavailable"}\n`;
    part1 += `Ending equity: ${reliableEnd ? formatMoney(finiteOrNull(reliableEnd.equity)) : "Unavailable"}\n`;
    part1 += `Net realized PnL: ${stats ? formatMoney(stats.realized) : "Unavailable"}\n`;
    const currentPositions = await this.activePositions();
    const reportUnrealized = currentPositions.errors.length ? null : currentPositions.positions.reduce((s, p) => s + Number(p.unrealisedPnl || 0), 0);
    part1 += `Unrealized at report time: ${formatMoney(reportUnrealized)}\n`;
    part1 += `Net account change: ${formatMoney(netAccountChange)}\n`;

    part1 += `\n📈 TRADES\n`;
    part1 += `Opened: ${opens ? opens.length : "Unavailable"}\n`;
    part1 += `Closed: ${stats ? stats.closed : "Unavailable"}\n`;
    if (stats) {
      part1 += `W/L: ${stats.wins}/${stats.losses} | Win rate ${stats.winRate.toFixed(1)}%\n`;
      part1 += `Gross profit: ${formatMoney(stats.grossProfit)} | Gross loss: ${formatMoney(stats.grossLoss)}\n`;
      part1 += `Average PnL: ${formatMoney(stats.averagePnl)}\n`;
      part1 += `Best: ${sortedPnl[0] ? formatMoney(sortedPnl[0].pnl) : "—"}\n`;
      part1 += `Worst: ${sortedPnl.length ? formatMoney(sortedPnl[sortedPnl.length - 1].pnl) : "—"}\n`;
    }
    part1 += `Avg duration: ${avgDurationMs === null ? "Unavailable" : `${(avgDurationMs / 60000).toFixed(1)} min`}\n`;

    let part2 = `📈 FULL DAY TRADING REPORT — Daily Report 2/3\nDate: ${day} UTC\n`;
    part2 += `\n🚪 EXIT BREAKDOWN\n`;
    if (stats) part2 += `TP ${stats.exits.TP} | SL ${stats.exits.SL} | Trail ${stats.exits.Trailing} | Manual ${stats.exits.Manual} | Other ${stats.exits.Other}\n`;
    else part2 += `Unavailable\n`;
    part2 += `Exit reasons are metadata-based; PnL sign is never used to infer TP/SL.\n`;

    part2 += `\n↕️ LONG / SHORT\n`;
    part2 += `Long opened: ${opens ? longOpened : "Unavailable"} | closed ${closed.errors.length ? "Unavailable" : longStats.closed} | W/L ${closed.errors.length ? "—" : `${longStats.wins}/${longStats.losses}`} | PnL ${closed.errors.length ? "Unavailable" : formatMoney(longStats.realized)} | WR ${closed.errors.length || !longStats.closed ? "—" : `${longStats.winRate.toFixed(1)}%`}\n`;
    part2 += `Short opened: ${opens ? shortOpened : "Unavailable"} | closed ${closed.errors.length ? "Unavailable" : shortStats.closed} | W/L ${closed.errors.length ? "—" : `${shortStats.wins}/${shortStats.losses}`} | PnL ${closed.errors.length ? "Unavailable" : formatMoney(shortStats.realized)} | WR ${closed.errors.length || !shortStats.closed ? "—" : `${shortStats.winRate.toFixed(1)}%`}\n`;

    const groupLine = (name: string, g: any) => `${name}: ${g.count} | WR ${g.winRate === null ? "—" : `${g.winRate.toFixed(1)}%`} | SL ${g.slRate === null ? "—" : `${g.slRate.toFixed(1)}%`} | Avg ${g.avgPnl === null ? "—" : formatMoney(g.avgPnl)}`;
    part2 += `\n⚡ EMA9/21 QUALITY\n`;
    if (db.ok) {
      part2 += `${groupLine("Aligned", quality.aligned)}\n`;
      part2 += `${groupLine("Non-aligned/neutral", quality.nonAligned)}\n`;
      part2 += `${groupLine("Fresh cross", quality.freshCross)}\n`;
      part2 += `${groupLine("No fresh cross", quality.noFreshCross)}\n`;
    } else part2 += `Unavailable\n`;

    let part3 = `📈 FULL DAY TRADING REPORT — Daily Report 3/3\nDate: ${day} UTC\n`;
    part3 += `\n🛡 RISK\n`;
    part3 += `Max simultaneous positions observed: ${runtime?.maxPositionsObserved ?? "Unavailable"}\n`;
    part3 += `Daily breaker triggered: ${runtime ? (runtime.breakerTriggered ? "Yes" : "No") : "Unavailable"}\n`;
    part3 += `3-loss pause triggered count: ${runtime?.lossPauseTriggeredCount ?? "Unavailable"}\n`;
    part3 += `Max consecutive losses: ${closed.errors.length ? "Unavailable" : maxLossStreak}\n`;
    part3 += `SL rate: ${stats && stats.closed ? `${(stats.exits.SL / stats.closed * 100).toFixed(1)}%` : stats ? "0.0%" : "Unavailable"}\n`;
    part3 += `Adaptive SL avg distance: ${avgSl === null ? "Unavailable" : `${avgSl.toFixed(2)}%`}\n`;
    part3 += `Wider-SL reduced-notional trades: ${db.ok ? reducedNotional : "Unavailable"}\n`;

    part3 += `\n🔎 SCANNER / STRATEGY\n`;
    part3 += `Scanned candidates: ${runtime?.scannedCandidates ?? "Unavailable"}\n`;
    part3 += `Six-gate qualified setups: ${runtime?.sixGatePasses ?? "Unavailable"}\n`;
    const autoEntries = db.ok ? db.rows.filter((t: any) => t.openedAt >= window.startMs && t.openedAt < window.endMs && t.entryDiagnostics).length : null;
    part3 += `Auto trades executed: ${autoEntries ?? "Unavailable"}\n`;
    part3 += `EMA timing avg score: ${avgEmaScore === null ? "Unavailable" : `${avgEmaScore.toFixed(2)}/2`}\n`;
    part3 += `Fresh crosses used: ${db.ok ? freshCrossUsed : "Unavailable"}\n`;
    part3 += `Breakout bonus trades: ${db.ok ? breakoutTrades : "Unavailable"}\n`;

    part3 += `\n📌 OPEN POSITIONS AT DAY END\n`;
    if (!db.ok) part3 += `Unavailable\n`;
    else if (!openAtEnd.length) part3 += `None\n`;
    else part3 += `${openAtEnd.map((t: any) => `• ${t.symbol} ${t.side} | Entry $${Number(t.entryPrice).toFixed(4)} | opened ${new Date(t.openedAt).toISOString()}`).join("\n")}\n`;
    if (reportTime - window.endMs > 5 * 60 * 1000) part3 += `\nCatch-up note: report sent after the scheduled boundary; account unrealized is current report-time data.`;

    return [part1, part2, part3];
  }

  private async observeRuntime(now: number) {
    const scanner = this.engine.scanner.getState();
    const hour = previousFullUtcHour(now + 60 * 60 * 1000);
    const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
    const day: ReportWindow = { startMs: dayStart, endMs: dayStart + 24 * 60 * 60 * 1000 };
    const lastObserved = await dbGetSettings("telegram:scanner:lastObserved");
    const isNewScan = scanner.lastScanTime && scanner.lastScanTime !== lastObserved?.lastScanTime;

    const update = async (key: string) => {
      const current: RuntimeMetrics & { lossPauseTriggeredCount?: number; pauseWasActive?: boolean } = await dbGetSettings(key) || {
        coverageStart: now,
        scannedCandidates: 0,
        sixGatePasses: 0,
        breakoutBonusSetups: 0,
        freshCrossSetups: 0,
        maxPositionsObserved: 0,
        breakerTriggered: false,
      };
      current.maxPositionsObserved = Math.max(current.maxPositionsObserved || 0, this.engine.activePositions.length);
      current.breakerTriggered = Boolean(current.breakerTriggered || this.engine.circuitBreakerTriggered);
      if (isNewScan) {
        const markets = Array.isArray(scanner.markets) ? scanner.markets : [];
        current.scannedCandidates += markets.length;
        current.sixGatePasses += markets.filter((m: any) => m.gatePassed === 6).length;
        current.breakoutBonusSetups += markets.filter((m: any) => m.gatePassed === 6 && m.breakoutBonus === true).length;
        current.freshCrossSetups += markets.filter((m: any) => m.gatePassed === 6 && ["bullish", "bearish"].includes(m.freshCross)).length;
        current.lastScannerTimestamp = scanner.lastScanTime;
      }
      await dbSaveSettings(key, current);
    };

    await Promise.all([
      update(`reportmetrics:h:${new Date(hour.startMs).toISOString().slice(0, 13)}`),
      update(`reportmetrics:d:${formatUtcDay(day)}`),
    ]);
    if (isNewScan) await dbSaveSettings("telegram:scanner:lastObserved", { lastScanTime: scanner.lastScanTime });
  }

  private async captureBoundarySnapshot(now: number) {
    const date = new Date(now);
    const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    if (now - dayStart > 60_000) return;
    const key = `reportaccount:${new Date(dayStart).toISOString().slice(0, 10)}`;
    if (await dbGetSettings(key)) return;
    const account = await this.accountSnapshot();
    if (account.errors.length) return;
    await dbSaveSettings(key, { ...account.snapshot, reliableBoundary: true });
  }
}
