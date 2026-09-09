import { RestClientV5 } from "bybit-api";
import { TelegramNotifier } from "./TelegramNotifier";
import {
  dbClaimReportDelivery,
  dbCompleteReportDelivery,
  dbGetAccountSnapshot,
  dbGetReportEvents,
  dbGetReportTrades,
  dbGetSettings,
  dbSaveAccountSnapshot,
  dbSaveSettings,
} from "../db";
import { classifyClosedTradeExit } from "../utils/exitClassification";
import { normalizeTimestampMs } from "../utils/utcTradingDay";
import {
  aggregateClosedPnlByIdentity,
  bangladeshBoundaryReady,
  bangladeshDailyDeliveryKey,
  coverageForWindow,
  currentBangladeshDay,
  dedupeOpeningExecutions,
  finiteOrNull,
  formatBangladeshDay,
  formatMoney,
  formatUtcHourWindow,
  hasUsableEmaTimingMetadata,
  hourlyDeliveryKey,
  maxConsecutiveLosses,
  paginateUntilBoundary,
  previousBangladeshDay,
  previousFullUtcHour,
  qualityBreakdown,
  reconcileTradeLifecycles,
  ReportWindow,
  safeAverage,
  snapshotReliability,
  splitTelegramMessage,
  summarizeClosedTrades,
  summarizeTradeSourceCoverage,
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

type DailyReportData = {
  date: string;
  partialErrors: SourceError[];
  account: {
    startingWallet: number | null;
    startingEquity: number | null;
    endingWallet: number | null;
    endingEquity: number | null;
    currentUnrealized: number | null;
    netAccountChange: number | null;
  };
  performance: ReturnType<typeof summarizeClosedTrades> | null;
  bestPnl: number | null;
  worstPnl: number | null;
  averageDurationMs: number | null;
  reconciliation: ReturnType<typeof reconcileTradeLifecycles> | null;
  exchangeOpenedCount: number | null;
  exchangeClosedCount: number | null;
  sourceAttribution: ReturnType<typeof summarizeTradeSourceCoverage> | null;
  sourceUnmatchedExchange: number;
  ema: {
    denominator: number;
    covered: number;
    quality: ReturnType<typeof qualityBreakdown> | null;
    averageScore: number | null;
  };
  exits: ReturnType<typeof summarizeClosedTrades>["exits"] | null;
  longStats: ReturnType<typeof summarizeClosedTrades> | null;
  shortStats: ReturnType<typeof summarizeClosedTrades> | null;
  risk: {
    runtimeCoverage: "FULL" | "PARTIAL" | "UNAVAILABLE";
    maxPositionsObserved: number | null;
    breakerStatus: "YES" | "NO" | "PARTIAL" | "UNAVAILABLE";
    lossPauseCount: number | null;
    lossPauseCoverage: "FULL" | "PARTIAL" | "UNAVAILABLE";
    maxLossStreak: number | null;
    slRate: number | null;
    avgSlDistance: number | null;
    slCoverage: number;
    reducedNotionalCount: number | null;
    reducedNotionalCoverage: number;
  };
  scanner: {
    runtimeCoverage: "FULL" | "PARTIAL" | "UNAVAILABLE";
    scannedCandidates: number | null;
    sixGatePasses: number | null;
    breakoutBonusTrades: number | null;
    breakoutCoverage: number;
  };
};

const TICK_MS = 15_000;
const DAILY_REPORT_DELAY_MS = 5_000;
const REPORTING_TIMEZONE = "Asia/Dhaka";
const LOSS_PAUSE_COVERAGE_KEY = "reporting:lossPauseEventCoverageStart";

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

function observedMetric(value: number | null, coverage: "FULL" | "PARTIAL" | "UNAVAILABLE"): string {
  if (value === null || coverage === "UNAVAILABLE") return "Unavailable";
  return coverage === "FULL" ? String(value) : `${value} (partial coverage)`;
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
    console.log("[TelegramReports] Scheduler started: UTC hourly + completed Asia/Dhaka daily reports.");
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
      await this.ensureCoverageMarkers(now);
      await this.observeRuntime(now);
      await this.captureBangladeshBoundarySnapshot(now);
      await this.ensureHourlyReport(now, isStartup);
      if (bangladeshBoundaryReady(now, DAILY_REPORT_DELAY_MS)) await this.ensureDailyReport(now, isStartup);
    } catch (error) {
      console.error(`[TelegramReports] scheduler warning: ${errorText(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async ensureCoverageMarkers(now: number) {
    const existing = await dbGetSettings(LOSS_PAUSE_COVERAGE_KEY);
    if (!existing?.startMs) await dbSaveSettings(LOSS_PAUSE_COVERAGE_KEY, { startMs: now });
  }

  private async wasSent(key: string): Promise<boolean> {
    const value = await dbGetSettings(key);
    return Boolean(value?.status === "sent" || value?.sent === true);
  }

  private async sendReportParts(key: string, type: "hourly" | "daily", parts: string[], context: Record<string, any>): Promise<boolean> {
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
    const window = previousBangladeshDay(now);
    const key = bangladeshDailyDeliveryKey(window);
    if (await this.wasSent(key)) return;
    const data = await this.buildDailyReportData(window, now);
    const logicalParts = this.renderDailyReport(data);
    const parts = logicalParts.flatMap((part) => splitTelegramMessage(part));
    await this.sendReportParts(key, "daily", parts, {
      reportingDate: data.date,
      timezone: REPORTING_TIMEZONE,
      periodStart: new Date(window.startMs).toISOString(),
      periodEnd: new Date(window.endMs).toISOString(),
      startupCatchup: isStartup,
    });
  }

  private async accountSnapshot(): Promise<{ snapshot: AccountSnapshot; errors: SourceError[] }> {
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
        errors: [],
      };
    } catch (error) {
      return {
        snapshot: { wallet: null, equity: null, available: null, capturedAt: Date.now() },
        errors: [{ source: "Bybit wallet", reason: errorText(error) }],
      };
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

  private async pagedRange(source: "closedPnL" | "executions" | "orders", window: ReportWindow): Promise<{ items: any[]; errors: SourceError[] }> {
    const timestamp = (item: any) => source === "closedPnL"
      ? unixMs(item.updatedTime || item.execTime || item.createdTime)
      : source === "executions"
        ? unixMs(item.execTime || item.createdTime)
        : unixMs(item.updatedTime || item.createdTime);
    try {
      const items = await paginateUntilBoundary(async (cursor?: string) => {
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
      }, window.startMs, timestamp, 100);
      return { items: items.filter((item) => inWindow(timestamp(item), window)), errors: [] };
    } catch (error) {
      return { items: [], errors: [{ source: `Bybit ${source}`, reason: errorText(error) }] };
    }
  }

  private async reportTrades(window: ReportWindow) {
    return await dbGetReportTrades(window.startMs, window.endMs);
  }

  private classifyClosed(closed: any[], executions: any[], orders: any[], dbTrades: any[]) {
    return closed.map((item) => {
      const classified = classifyClosedTradeExit({ closedTrade: item, executions, orders, localHistory: dbTrades });
      const closedAt = Number(item.__timestampMs || unixMs(item.updatedTime || item.execTime || item.createdTime));
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
    return dedupeOpeningExecutions(executions.map((item: any) => ({
      ...item,
      __timestampMs: unixMs(item.execTime || item.createdTime),
    })), window);
  }

  private partialWarning(errors: SourceError[]): string {
    if (!errors.length) return "";
    return `\n⚠️ Partial data — ${errors.map((e) => `${e.source}: ${e.reason}`).join("; ")}\n`;
  }

  private async buildHourlyReport(window: ReportWindow): Promise<string> {
    const [account, positions, closed, executions] = await Promise.all([
      this.accountSnapshot(), this.activePositions(), this.pagedRange("closedPnL", window), this.pagedRange("executions", window),
    ]);
    const errors = [...account.errors, ...positions.errors, ...closed.errors, ...executions.errors];
    const aggregated = closed.errors.length ? [] : aggregateClosedPnlByIdentity(closed.items, (x) => unixMs(x.updatedTime || x.execTime || x.createdTime));
    const stats = closed.errors.length ? null : summarizeClosedTrades(aggregated.map((x) => ({ pnl: Number(x.closedPnl) })));
    const opens = executions.errors.length ? null : this.openingExecutions(executions.items, window);
    let message = `📊 HOURLY TRADING REPORT\n🕐 ${formatUtcHourWindow(window)}\n${this.partialWarning(errors)}`;
    message += `\n💰 Account\nWallet: ${formatMoney(account.snapshot.wallet)}\nEquity: ${formatMoney(account.snapshot.equity)}\nAvailable: ${formatMoney(account.snapshot.available)}\n`;
    message += `\n📈 Trading\nOpened: ${opens ? opens.length : "Unavailable"}\nClosed: ${stats ? stats.closed : "Unavailable"}\nRealized: ${stats ? formatMoney(stats.realized) : "Unavailable"}\n`;
    message += `\n📌 Positions\nActive: ${positions.errors.length ? "Unavailable" : `${positions.positions.length}/3`}\n`;
    if (!positions.errors.length && positions.positions.length) message += positions.positions.map(positionLine).join("\n");
    return message;
  }

  private async buildDailyReportData(window: ReportWindow, reportTime: number): Promise<DailyReportData> {
    const [accountNow, positionsNow, closed, executions, orders, db, runtime, startSnapshotResult, endSnapshotResult, lossPauseEvents, lossPauseMarker] = await Promise.all([
      this.accountSnapshot(),
      this.activePositions(),
      this.pagedRange("closedPnL", window),
      this.pagedRange("executions", window),
      this.pagedRange("orders", window),
      this.reportTrades(window),
      dbGetSettings(`reportmetrics:d:bdt:${formatBangladeshDay(window)}`),
      dbGetAccountSnapshot(window.startMs, REPORTING_TIMEZONE),
      dbGetAccountSnapshot(window.endMs, REPORTING_TIMEZONE),
      dbGetReportEvents("loss_pause_trigger", window.startMs, window.endMs),
      dbGetSettings(LOSS_PAUSE_COVERAGE_KEY),
    ]);

    const errors: SourceError[] = [
      ...accountNow.errors,
      ...positionsNow.errors,
      ...closed.errors,
      ...executions.errors,
      ...orders.errors,
      ...(db.ok ? [] : [{ source: "Database report trades", reason: db.error || "unavailable" }]),
      ...(startSnapshotResult.ok ? [] : [{ source: "Account start snapshot store", reason: startSnapshotResult.error || "unavailable" }]),
      ...(endSnapshotResult.ok ? [] : [{ source: "Account end snapshot store", reason: endSnapshotResult.error || "unavailable" }]),
      ...(lossPauseEvents.ok ? [] : [{ source: "Loss-pause event store", reason: lossPauseEvents.error || "unavailable" }]),
    ];

    const dbTrades = db.ok ? db.rows : [];
    const aggregatedClosed = closed.errors.length ? [] : aggregateClosedPnlByIdentity(closed.items, (x) => unixMs(x.updatedTime || x.execTime || x.createdTime));
    const classified = closed.errors.length ? [] : this.classifyClosed(aggregatedClosed, executions.items, orders.items, dbTrades);
    const stats = closed.errors.length ? null : summarizeClosedTrades(classified);
    const openingExecs = executions.errors.length ? null : this.openingExecutions(executions.items, window);
    const exchangeOpenedCount = openingExecs ? openingExecs.length : null;
    const exchangeClosedCount = closed.errors.length ? null : aggregatedClosed.length;
    const reconciliation = db.ok ? reconcileTradeLifecycles(dbTrades, window, exchangeOpenedCount, exchangeClosedCount) : null;

    const openedDbRows = dbTrades.filter((t: any) => t.openedAt >= window.startMs && t.openedAt < window.endMs);
    const sourceAttribution = db.ok ? summarizeTradeSourceCoverage(openedDbRows, exchangeOpenedCount) : null;
    const sourceUnmatchedExchange = sourceAttribution ? Math.max(0, sourceAttribution.expected - openedDbRows.length) : 0;

    const dayClosedDb = dbTrades.filter((t: any) => t.closedAt && inWindow(t.closedAt, window));
    const emaDenominator = Math.max(dayClosedDb.length, exchangeClosedCount || 0);
    const emaCoveredRows = dayClosedDb.filter(hasUsableEmaTimingMetadata);
    const emaQualityTrades = emaCoveredRows.map((t: any) => ({
      pnl: Number(t.realizedPnl), exitLabel: t.exitReason, side: t.side === "Buy" ? "LONG" : "SHORT",
      openedAt: t.openedAt, closedAt: t.closedAt, entryDiagnostics: t.entryDiagnostics,
    }));
    const emaQuality = emaCoveredRows.length ? qualityBreakdown(emaQualityTrades) : null;
    const averageScore = safeAverage(emaCoveredRows.map((t: any) => t.entryDiagnostics?.emaTimingScore));

    const longStats = stats ? summarizeClosedTrades(classified.filter((t: any) => t.side === "LONG")) : null;
    const shortStats = stats ? summarizeClosedTrades(classified.filter((t: any) => t.side === "SHORT")) : null;
    const sortedPnl = classified.filter((t: any) => Number.isFinite(t.pnl)).sort((a: any, b: any) => b.pnl - a.pnl);
    const durations = dayClosedDb.map((t: any) => t.openedAt && t.closedAt ? t.closedAt - t.openedAt : NaN).filter(Number.isFinite);

    const slCoveredRows = dayClosedDb.filter((t: any) => Number.isFinite(Number(t.entryDiagnostics?.slDistancePercent)));
    const avgSlDistance = safeAverage(slCoveredRows.map((t: any) => t.entryDiagnostics.slDistancePercent));
    const reducedCoveredRows = dayClosedDb.filter((t: any) => Number.isFinite(Number(t.entryDiagnostics?.actualMarginUsedUsdt)) && Number.isFinite(Number(t.entryDiagnostics?.configuredMarginCapUsdt)));
    const reducedNotionalCount = reducedCoveredRows.length ? reducedCoveredRows.filter((t: any) => Number(t.entryDiagnostics.actualMarginUsedUsdt) < Number(t.entryDiagnostics.configuredMarginCapUsdt) - 0.01).length : null;
    const breakoutCoveredRows = dayClosedDb.filter((t: any) => typeof t.entryDiagnostics?.breakoutBonus === "boolean");
    const breakoutBonusTrades = breakoutCoveredRows.length ? breakoutCoveredRows.filter((t: any) => t.entryDiagnostics.breakoutBonus === true).length : null;

    const runtimeCoverage = coverageForWindow(runtime?.coverageStart, window);
    const breakerStatus: DailyReportData["risk"]["breakerStatus"] = runtime?.breakerTriggered === true
      ? "YES"
      : runtimeCoverage === "FULL" ? "NO" : runtimeCoverage === "PARTIAL" ? "PARTIAL" : "UNAVAILABLE";
    const lossPauseCoverage = coverageForWindow(lossPauseMarker?.startMs, window);
    const lossPauseCount = lossPauseEvents.ok && (lossPauseCoverage === "FULL" || lossPauseEvents.rows.length > 0) ? lossPauseEvents.rows.length : null;

    const startSnapshot = startSnapshotResult.ok && startSnapshotResult.row?.reliableBoundary ? startSnapshotResult.row : null;
    const endSnapshot = endSnapshotResult.ok && endSnapshotResult.row?.reliableBoundary ? endSnapshotResult.row : null;
    const netAccountChange = startSnapshot && endSnapshot && Number.isFinite(Number(startSnapshot.equity)) && Number.isFinite(Number(endSnapshot.equity))
      ? Number(endSnapshot.equity) - Number(startSnapshot.equity)
      : null;
    const currentUnrealized = positionsNow.errors.length ? null : positionsNow.positions.reduce((sum, p) => sum + Number(p.unrealisedPnl || 0), 0);

    return {
      date: formatBangladeshDay(window),
      partialErrors: errors,
      account: {
        startingWallet: startSnapshot ? finiteOrNull(startSnapshot.wallet) : null,
        startingEquity: startSnapshot ? finiteOrNull(startSnapshot.equity) : null,
        endingWallet: endSnapshot ? finiteOrNull(endSnapshot.wallet) : null,
        endingEquity: endSnapshot ? finiteOrNull(endSnapshot.equity) : null,
        currentUnrealized,
        netAccountChange,
      },
      performance: stats,
      bestPnl: sortedPnl.length ? sortedPnl[0].pnl : null,
      worstPnl: sortedPnl.length ? sortedPnl[sortedPnl.length - 1].pnl : null,
      averageDurationMs: safeAverage(durations),
      reconciliation,
      exchangeOpenedCount,
      exchangeClosedCount,
      sourceAttribution,
      sourceUnmatchedExchange,
      ema: { denominator: emaDenominator, covered: emaCoveredRows.length, quality: emaQuality, averageScore },
      exits: stats?.exits || null,
      longStats,
      shortStats,
      risk: {
        runtimeCoverage,
        maxPositionsObserved: runtime && Number.isFinite(Number(runtime.maxPositionsObserved)) ? Number(runtime.maxPositionsObserved) : null,
        breakerStatus,
        lossPauseCount,
        lossPauseCoverage,
        maxLossStreak: stats ? maxConsecutiveLosses([...classified].sort((a: any, b: any) => Number(a.closedAt || 0) - Number(b.closedAt || 0))) : null,
        slRate: stats && stats.closed ? stats.exits.SL / stats.closed * 100 : stats ? 0 : null,
        avgSlDistance,
        slCoverage: slCoveredRows.length,
        reducedNotionalCount,
        reducedNotionalCoverage: reducedCoveredRows.length,
      },
      scanner: {
        runtimeCoverage,
        scannedCandidates: runtime && Number.isFinite(Number(runtime.scannedCandidates)) ? Number(runtime.scannedCandidates) : null,
        sixGatePasses: runtime && Number.isFinite(Number(runtime.sixGatePasses)) ? Number(runtime.sixGatePasses) : null,
        breakoutBonusTrades,
        breakoutCoverage: breakoutCoveredRows.length,
      },
    };
  }

  private renderDailyReport(data: DailyReportData): string[] {
    const partial = this.partialWarning(data.partialErrors);
    const r = data.reconciliation;
    const dayStartOpen = r ? String(r.dayStartOpen) : "Unavailable";
    const opened = r ? String(r.openedDuringWindow) : data.exchangeOpenedCount === null ? "Unavailable" : `${data.exchangeOpenedCount} (exchange-only)`;
    const closed = r ? String(r.closedDuringWindow) : data.exchangeClosedCount === null ? "Unavailable" : `${data.exchangeClosedCount} (exchange-only)`;
    const dayEndOpen = r ? String(r.dayEndOpen) : "Unavailable";
    const reconciliation = r ? `${r.status}${r.status === "FAIL" ? ` (delta ${r.delta})` : r.status === "PARTIAL" ? ` — ${r.reason}` : ""}` : "UNAVAILABLE";

    let part1 = `📈 FULL DAY TRADING REPORT — Daily Report 1/3\nDate: ${data.date} BDT\n${partial}`;
    part1 += `\n💰 ACCOUNT\n`;
    part1 += `Starting wallet: ${formatMoney(data.account.startingWallet)}\n`;
    part1 += `Starting equity: ${formatMoney(data.account.startingEquity)}\n`;
    part1 += `Ending wallet: ${formatMoney(data.account.endingWallet)}\n`;
    part1 += `Ending equity: ${formatMoney(data.account.endingEquity)}\n`;
    part1 += `Net realized PnL: ${data.performance ? formatMoney(data.performance.realized) : "Unavailable"}\n`;
    part1 += `Unrealized at report time: ${formatMoney(data.account.currentUnrealized)}\n`;
    part1 += `Net account change: ${formatMoney(data.account.netAccountChange)}\n`;
    part1 += `\n📈 TRADES\nDay-start open: ${dayStartOpen}\nOpened: ${opened}\nClosed: ${closed}\nDay-end open: ${dayEndOpen}\nAccounting reconciliation: ${reconciliation}\n`;
    if (data.performance) {
      part1 += `W/L: ${data.performance.wins}/${data.performance.losses} | Win rate ${data.performance.winRate.toFixed(1)}%\n`;
      part1 += `Gross profit: ${formatMoney(data.performance.grossProfit)} | Gross loss: ${formatMoney(data.performance.grossLoss)}\n`;
      part1 += `Average PnL: ${formatMoney(data.performance.averagePnl)}\n`;
      part1 += `Best: ${data.bestPnl === null ? "—" : formatMoney(data.bestPnl)} | Worst: ${data.worstPnl === null ? "—" : formatMoney(data.worstPnl)}\n`;
    }
    part1 += `Avg duration: ${data.averageDurationMs === null ? "Unavailable" : `${(data.averageDurationMs / 60000).toFixed(1)} min`}\n`;

    let part2 = `📈 FULL DAY TRADING REPORT — Daily Report 2/3\nDate: ${data.date} BDT\n`;
    part2 += `\n🚪 EXIT BREAKDOWN\n`;
    part2 += data.exits ? `TP ${data.exits.TP} | SL ${data.exits.SL} | Trail ${data.exits.Trailing} | Manual ${data.exits.Manual} | Other ${data.exits.Other}\n` : `Unavailable\n`;
    part2 += `Exit reasons are metadata-based; PnL sign is never used to infer TP/SL.\n`;
    if (data.longStats && data.shortStats) {
      part2 += `\n↕️ LONG / SHORT\nLong closed ${data.longStats.closed} | W/L ${data.longStats.wins}/${data.longStats.losses} | PnL ${formatMoney(data.longStats.realized)}\n`;
      part2 += `Short closed ${data.shortStats.closed} | W/L ${data.shortStats.wins}/${data.shortStats.losses} | PnL ${formatMoney(data.shortStats.realized)}\n`;
    }

    part2 += `\n🤖 AUTO ATTRIBUTION\n`;
    if (!data.sourceAttribution || (data.sourceAttribution.expected > 0 && data.sourceAttribution.known === 0)) {
      part2 += `Auto trades executed: Unavailable\nManual: Unavailable\nExternal/Unknown: Unavailable\nCoverage: 0/${data.sourceAttribution?.expected ?? data.exchangeOpenedCount ?? "?"}\n`;
    } else {
      const suffix = data.sourceAttribution.full ? "" : " (partial coverage)";
      part2 += `Auto: ${data.sourceAttribution.auto}${suffix}\nManual: ${data.sourceAttribution.manual}${suffix}\nExternal/Unknown: ${data.sourceAttribution.external + data.sourceAttribution.unknown + data.sourceUnmatchedExchange}${suffix}\n`;
      part2 += `Coverage: ${data.sourceAttribution.known}/${data.sourceAttribution.expected} opening lifecycles\n`;
    }

    part2 += `\n⚡ EMA9/21 QUALITY\n`;
    if (data.ema.denominator > 0 && data.ema.covered === 0) {
      part2 += `Unavailable — historical trades predate or lack EMA timing metadata\n`;
    } else if (data.ema.denominator === 0) {
      part2 += `Coverage: 0/0 trades\nAligned: 0 | Non-aligned/neutral: 0 | Fresh cross: 0 | No fresh cross: 0 | Avg score: —\n`;
    } else if (data.ema.quality) {
      part2 += `Coverage: ${data.ema.covered}/${data.ema.denominator} trades${data.ema.covered < data.ema.denominator ? " (partial)" : ""}\n`;
      part2 += `Aligned: ${data.ema.quality.aligned.count} | Non-aligned/neutral: ${data.ema.quality.nonAligned.count}\n`;
      part2 += `Fresh cross: ${data.ema.quality.freshCross.count} | No fresh cross: ${data.ema.quality.noFreshCross.count}\n`;
      part2 += `Avg score: ${data.ema.averageScore === null ? "Unavailable" : `${data.ema.averageScore.toFixed(2)}/2`}\n`;
    }

    let part3 = `📈 FULL DAY TRADING REPORT — Daily Report 3/3\nDate: ${data.date} BDT\n`;
    part3 += `\n🛡 RISK\n`;
    part3 += `Max simultaneous positions observed: ${observedMetric(data.risk.maxPositionsObserved, data.risk.runtimeCoverage)}\n`;
    part3 += `Breaker historical status: ${data.risk.breakerStatus}\n`;
    part3 += `3-loss pause triggered count: ${data.risk.lossPauseCount === null ? "Unavailable" : data.risk.lossPauseCoverage === "FULL" ? data.risk.lossPauseCount : `${data.risk.lossPauseCount} (partial coverage)`}\n`;
    part3 += `Max consecutive losses: ${data.risk.maxLossStreak === null ? "Unavailable" : data.risk.maxLossStreak}\n`;
    part3 += `SL rate: ${data.risk.slRate === null ? "Unavailable" : `${data.risk.slRate.toFixed(1)}%`}\n`;
    part3 += `Adaptive SL avg distance: ${data.risk.avgSlDistance === null ? "Unavailable" : `${data.risk.avgSlDistance.toFixed(2)}%`} | Coverage ${data.risk.slCoverage}/${data.exchangeClosedCount ?? "?"}\n`;
    part3 += `Wider-SL reduced-notional: ${data.risk.reducedNotionalCount === null ? "Unavailable" : data.risk.reducedNotionalCount} | Coverage ${data.risk.reducedNotionalCoverage}/${data.exchangeClosedCount ?? "?"}\n`;
    part3 += `\n🔎 SCANNER / STRATEGY\n`;
    part3 += `Scanned candidates: ${observedMetric(data.scanner.scannedCandidates, data.scanner.runtimeCoverage)}\n`;
    part3 += `Six-gate qualified setups: ${observedMetric(data.scanner.sixGatePasses, data.scanner.runtimeCoverage)}\n`;
    part3 += `Breakout bonus trades: ${data.scanner.breakoutBonusTrades === null ? "Unavailable" : data.scanner.breakoutBonusTrades} | Coverage ${data.scanner.breakoutCoverage}/${data.exchangeClosedCount ?? "?"}\n`;
    return [part1, part2, part3];
  }

  private async observeRuntime(now: number) {
    const scanner = this.engine.scanner.getState();
    const hour = previousFullUtcHour(now + 60 * 60 * 1000);
    const bdtDay = currentBangladeshDay(now);
    const lastObserved = await dbGetSettings("telegram:scanner:lastObserved");
    const isNewScan = scanner.lastScanTime && scanner.lastScanTime !== lastObserved?.lastScanTime;

    const update = async (key: string) => {
      const current: RuntimeMetrics = await dbGetSettings(key) || {
        coverageStart: now,
        scannedCandidates: 0,
        sixGatePasses: 0,
        breakoutBonusSetups: 0,
        freshCrossSetups: 0,
        maxPositionsObserved: 0,
        breakerTriggered: false,
      };
      current.maxPositionsObserved = Math.max(Number(current.maxPositionsObserved || 0), this.engine.activePositions.length);
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
      update(`reportmetrics:d:bdt:${formatBangladeshDay(bdtDay)}`),
    ]);
    if (isNewScan) await dbSaveSettings("telegram:scanner:lastObserved", { lastScanTime: scanner.lastScanTime });
  }

  private async captureBangladeshBoundarySnapshot(now: number) {
    const day = currentBangladeshDay(now);
    const existing = await dbGetAccountSnapshot(day.startMs, REPORTING_TIMEZONE);
    if (existing.ok && existing.row) return;
    const account = await this.accountSnapshot();
    if (account.errors.length) return;
    const reliableBoundary = snapshotReliability(day.startMs, account.snapshot.capturedAt);
    await dbSaveAccountSnapshot({
      boundaryMs: day.startMs,
      reportingDate: formatBangladeshDay(day),
      timezone: REPORTING_TIMEZONE,
      wallet: account.snapshot.wallet,
      equity: account.snapshot.equity,
      available: account.snapshot.available,
      capturedAt: account.snapshot.capturedAt,
      source: "bybit-unified-live",
      reliableBoundary,
    });
  }
}
