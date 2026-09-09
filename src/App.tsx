import { useEffect, useState, useRef } from "react";
import { io, Socket } from "socket.io-client";
import { AlertCircle } from "lucide-react";
import { Position, TradeHistory, Technicals, Settings, KlineUpdatePayload, ScannerState } from "./types";
import { Sidebar } from "./components/Sidebar";
import { TerminalPage } from "./components/TerminalPage";
import { ActiveTradesPage } from "./components/ActiveTradesPage";
import { StrategyPage } from "./components/StrategyPage";
import { HistoryPage } from "./components/HistoryPage";
import { SettingsPage } from "./components/SettingsPage";

export default function App() {
  const [activeTab, setActiveTab] = useState("terminal");
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<"live" | "reconnecting" | "disconnected">("reconnecting");
  const [isBotRunning, setIsBotRunning] = useState(true);
  const [isCircuitBreaker, setIsCircuitBreaker] = useState(false);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [balance, setBalance] = useState<string>("");
  const [settings, setSettings] = useState<Settings>({
    leverage: 10,
    positionMarginUsdt: 50,
    maxPositions: 3,
    tpPercent: 2.5,
    slPercent: 1.0,
    trailingStopPercent: 0.5,
    maxLossUsdt: 50,
    globalMaxLossUsdt: -50,
  });
  const [positions, setPositions] = useState<Position[]>([]);
  const [history, setHistory] = useState<TradeHistory[]>([]);
  const [technicals, setTechnicals] = useState<Record<string, Technicals>>({});
  const [latestKlineUpdate, setLatestKlineUpdate] = useState<KlineUpdatePayload | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [scannerState, setScannerState] = useState<ScannerState>({
    markets: [],
    autoTrade: true,
    maxConcurrent: 3,
    isScanning: false,
    lastScanTime: 0,
    topSymbols: [],
  });

  const pendingPricesRef = useRef<Record<string, number>>({});
  const lastPriceUpdateRef = useRef<number>(0);
  const priceTimerRef = useRef<NodeJS.Timeout | null>(null);

  const handleThrottledPrices = (data: Record<string, number>) => {
    pendingPricesRef.current = { ...pendingPricesRef.current, ...data };
    const now = Date.now();
    if (now - lastPriceUpdateRef.current >= 1000) {
      lastPriceUpdateRef.current = now;
      setPrices({ ...pendingPricesRef.current });
    } else if (!priceTimerRef.current) {
      priceTimerRef.current = setTimeout(() => {
        lastPriceUpdateRef.current = Date.now();
        setPrices({ ...pendingPricesRef.current });
        priceTimerRef.current = null;
      }, 1000 - (now - lastPriceUpdateRef.current));
    }
  };

  useEffect(() => {
    const newSocket = io({
      path: "/socket.io",
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
    });
    setSocket(newSocket);

    newSocket.on("connect", () => {
      setIsConnected(true);
      setConnectionStatus("live");
    });
    newSocket.on("disconnect", () => {
      setIsConnected(false);
      setConnectionStatus("reconnecting");
    });
    newSocket.on("connect_error", () => {
      setIsConnected(false);
      setConnectionStatus("reconnecting");
    });
    newSocket.on("reconnect_attempt", () => {
      setConnectionStatus("reconnecting");
    });

    newSocket.on("bot-status", (data: { running: boolean }) => setIsBotRunning(data.running));
    newSocket.on("price-update", (data: Record<string, number>) => handleThrottledPrices(data));
    newSocket.on("ticker:update", (data: Record<string, number>) => handleThrottledPrices(data));
    newSocket.on("positions-update", (data: Position[]) => setPositions(data));
    newSocket.on("position:update", (data: Position[]) => setPositions(data));
    newSocket.on("balance-update", (data: { balance: string }) => { if (data?.balance !== undefined) setBalance(data.balance); });
    newSocket.on("wallet:update", (data: { balance: string }) => { if (data?.balance !== undefined) setBalance(data.balance); });
    newSocket.on("technicals-update", (data: Record<string, Technicals>) => setTechnicals(data));
    newSocket.on("watchlist-update", (data: string[]) => setWatchlist(data));
    newSocket.on("kline-update", (data: KlineUpdatePayload) => setLatestKlineUpdate(data));
    newSocket.on("kline:update", (data: KlineUpdatePayload) => setLatestKlineUpdate(data));
    newSocket.on("scanner-update", (data: ScannerState) => { if (data) setScannerState(data); });
    newSocket.on("scanner:update", (data: ScannerState) => { if (data) setScannerState(data); });
    newSocket.on("settings-update", (data: any) => setSettings(data));
    newSocket.on("log", (message: string) => setLogs((prev) => [...prev, message].slice(-50)));
    newSocket.on("trade-update", () => fetchData());
    newSocket.on("execution:update", () => fetchData());

    return () => {
      if (priceTimerRef.current) clearTimeout(priceTimerRef.current);
      newSocket.close();
    };
  }, []);

  const fetchData = async () => {
    setError(null);
    try {
      const [balanceRes, positionsRes, watchlistRes, settingsRes, summaryRes, techRes, botRes, scannerRes] = await Promise.all([
        fetch("/api/balance").then(r => r.json()),
        fetch("/api/positions").then(r => r.json()),
        fetch("/api/watchlist").then(r => r.json()),
        fetch("/api/settings").then(r => r.json()),
        fetch("/api/history").then(r => r.json()).catch(() => ({ success: false })),
        fetch("/api/technicals").then(r => r.json()),
        fetch('/api/bot/status').then(r => r.json()).catch(() => ({ success: false })),
        fetch("/api/scanner/state").then(r => r.json()).catch(() => ({ success: false })),
      ]);

      if (balanceRes.success) setBalance(balanceRes.balance);
      if (positionsRes.success) setPositions(positionsRes.positions);
      if (watchlistRes.success) setWatchlist(watchlistRes.watchlist);
      if (settingsRes.success) setSettings(settingsRes.settings);

      if (summaryRes.success && Array.isArray(summaryRes.history)) {
        const normalizedHistory: TradeHistory[] = summaryRes.history.map((trade: any) => ({
          id: String(trade.id ?? `${trade.symbol}-${trade.time}`),
          symbol: String(trade.symbol ?? ""),
          side: trade.side === "Sell" ? "Sell" : "Buy",
          entryPrice: Number(trade.entryPrice ?? Number.NaN),
          exitPrice: Number(trade.exitPrice ?? Number.NaN),
          size: Number(trade.qty ?? Number.NaN),
          qty: trade.qty ?? "",
          pnl: Number(trade.pnl ?? Number.NaN),
          pnlPercent: Number(trade.pnlPercent ?? Number.NaN),
          reason: String(trade.reason ?? "Other / Unknown"),
          time: Number(trade.time ?? Number.NaN),
        }));
        setHistory(normalizedHistory);
      }

      if (techRes.success) setTechnicals(techRes.technicals);
      if (botRes?.success && typeof botRes.running === "boolean") setIsBotRunning(botRes.running);
      if (botRes?.success && typeof botRes.circuitBreaker === "boolean") setIsCircuitBreaker(botRes.circuitBreaker);
      if (scannerRes?.success && scannerRes.state) setScannerState(scannerRes.state);
      if (!balanceRes.success) setError(balanceRes.error);
    } catch (err: any) {
      setError("Failed to fetch data from server");
    }
  };

  const closePosition = async (symbol: string) => {
    setError(null);
    try {
      const res = await fetch("/api/positions/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol }),
      });
      const data = await res.json();
      if (!data.success) setError(data.message || `Failed to close position for ${symbol}`);
      else await fetchData();
    } catch (err: any) {
      setError(`Error submitting close order for ${symbol}`);
    }
  };

  const executeTestOrder = async (symbol: string = "BTCUSDT") => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/test-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, qty: symbol.includes("BTC") ? "0.001" : undefined }),
      });
      const data = await res.json();
      if (!data.success) setError(data.message || "Failed to execute manual test order");
      else await fetchData();
    } catch {
      setError("Error submitting test order to Bybit");
    } finally {
      setIsLoading(false);
    }
  };

  const toggleScannerAutoTrade = async (autoTrade: boolean) => {
    try {
      const res = await fetch("/api/scanner/toggle-autotrade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoTrade }),
      });
      const data = await res.json();
      if (data.success) setScannerState((prev) => ({ ...prev, autoTrade: data.autoTrade }));
    } catch {
      console.error("Failed to toggle scanner auto-trade");
    }
  };

  const triggerScanNow = async () => {
    try {
      setScannerState((prev) => ({ ...prev, isScanning: true }));
      const res = await fetch("/api/scanner/scan-now", { method: "POST" });
      const data = await res.json();
      if (data.success && data.state) setScannerState(data.state);
    } catch {
      console.error("Failed to scan markets");
    } finally {
      setScannerState((prev) => ({ ...prev, isScanning: false }));
    }
  };

  const refreshTopMarkets = async () => {
    try {
      setScannerState((prev) => ({ ...prev, isScanning: true }));
      const res = await fetch("/api/scanner/refresh-markets", { method: "POST" });
      const data = await res.json();
      if (data.success && data.state) setScannerState(data.state);
    } catch {
      console.error("Failed to refresh market rankings");
    } finally {
      setScannerState((prev) => ({ ...prev, isScanning: false }));
    }
  };

  const setScannerMaxConcurrent = async (maxConcurrent: number) => {
    try {
      const res = await fetch("/api/scanner/max-concurrent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxConcurrent }),
      });
      const data = await res.json();
      if (data.success) setScannerState((prev) => ({ ...prev, maxConcurrent: data.maxConcurrent }));
    } catch {
      console.error("Failed to set max concurrent slots");
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, []);

  const toggleBot = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const endpoint = isBotRunning ? "/api/bot/stop" : "/api/bot/start";
      const res = await fetch(endpoint, { method: "POST" });
      const data = await res.json();
      if (!data.success) setError(data.message);
    } catch {
      setError("Failed to toggle bot");
    } finally {
      setIsLoading(false);
    }
  };

  const toggleWatchlist = async (symbol: string, remove: boolean) => {
    try {
      const endpoint = remove ? "/api/watchlist/remove" : "/api/watchlist/add";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol })
      });
      const data = await res.json();
      if (data.success) setWatchlist(data.watchlist);
    } catch {
      console.error("Failed to update watchlist");
    }
  };

  const updateSetting = async (key: string, value: number) => {
    const newSettings = { ...settings, [key]: value };
    setSettings(newSettings);
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: newSettings })
      });
    } catch {
      console.error("Failed to save settings");
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 font-sans flex">
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        isConnected={isConnected}
        isBotRunning={isBotRunning}
        demoTrading={settings?.demoTrading}
        connectionStatus={connectionStatus}
      />

      <div className="flex-1 ml-64 p-8 overflow-y-auto h-screen">
        <div className="max-w-6xl mx-auto space-y-8">
          {error && (
            <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-lg flex items-center gap-3">
              <AlertCircle className="w-5 h-5 flex-shrink-0" />
              <p className="text-sm">{error}</p>
            </div>
          )}

          {activeTab === 'terminal' && (
            <TerminalPage
              balance={balance}
              isBotRunning={isBotRunning}
              isCircuitBreaker={isCircuitBreaker}
              isLoading={isLoading}
              toggleBot={toggleBot}
              watchlist={watchlist}
              prices={prices}
              positions={positions}
              trades={history}
              latestKlineUpdate={latestKlineUpdate}
              logs={logs}
              onClosePosition={closePosition}
              onTestOrder={executeTestOrder}
            />
          )}

          {activeTab === 'positions' && (
            <ActiveTradesPage
              positions={positions}
              settings={settings}
              tradeHistory={history}
              onClosePosition={closePosition}
              onRefresh={fetchData}
            />
          )}

          {activeTab === 'strategy' && (
            <StrategyPage
              watchlist={watchlist}
              technicals={technicals}
              toggleWatchlist={toggleWatchlist}
              trades={history}
              latestKlineUpdate={latestKlineUpdate}
              prices={prices}
              scannerState={scannerState}
              activePositions={positions}
              onToggleAutoTrade={toggleScannerAutoTrade}
              onScanNow={triggerScanNow}
              onRefreshMarkets={refreshTopMarkets}
              onSetMaxConcurrent={setScannerMaxConcurrent}
              onQuickBuy={executeTestOrder}
            />
          )}

          {activeTab === 'history' && <HistoryPage history={history} />}

          {activeTab === 'settings' && (
            <SettingsPage
              settings={settings}
              updateSetting={updateSetting}
              systemLogs={logs}
            />
          )}
        </div>
      </div>
    </div>
  );
}
