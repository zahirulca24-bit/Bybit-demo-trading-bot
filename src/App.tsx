import { useEffect, useState, useRef } from "react";
import { io, Socket } from "socket.io-client";
import { AlertCircle } from "lucide-react";
import { Position, TradeHistory, Technicals, Settings, KlineUpdatePayload, ScannerState, RuntimeRiskProfile, RuntimeStatus } from "./types";
import { apiRequest, QUICK_TEST_REQUESTED_QTY } from "./utils/frontendContract";
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
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [riskProfile, setRiskProfile] = useState<RuntimeRiskProfile | null>(null);
  const [historySource, setHistorySource] = useState<string | null>(null);
  const [historyMetadataCoverage, setHistoryMetadataCoverage] = useState<string | null>(null);

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
    const reads = await Promise.allSettled([
      apiRequest<any>("/api/balance"), apiRequest<any>("/api/positions"), apiRequest<any>("/api/watchlist"), apiRequest<any>("/api/settings"),
      apiRequest<any>("/api/history"), apiRequest<any>("/api/technicals"), apiRequest<any>("/api/bot/status"), apiRequest<any>("/api/scanner/state"), apiRequest<any>("/api/runtime-status")
    ]);
    const value=(i:number)=>reads[i].status==="fulfilled"?(reads[i] as PromiseFulfilledResult<any>).value:null;
    const balanceRes=value(0),positionsRes=value(1),watchlistRes=value(2),settingsRes=value(3),historyRes=value(4),techRes=value(5),botRes=value(6),scannerRes=value(7),runtimeRes=value(8);
    if(balanceRes) setBalance(balanceRes.balance); if(positionsRes?.positions) setPositions(positionsRes.positions); if(watchlistRes?.watchlist) setWatchlist(watchlistRes.watchlist);
    if(settingsRes?.settings) setSettings(settingsRes.settings); if(settingsRes?.riskProfile) setRiskProfile(settingsRes.riskProfile);
    if(Array.isArray(historyRes?.history)){setHistory(historyRes.history);setHistorySource(historyRes.source??null);setHistoryMetadataCoverage(historyRes.metadataCoverage??null);}
    if(techRes?.technicals) setTechnicals(techRes.technicals); if(typeof botRes?.running==="boolean") setIsBotRunning(botRes.running); if(typeof botRes?.circuitBreaker==="boolean") setIsCircuitBreaker(botRes.circuitBreaker);
    if(scannerRes?.state) setScannerState(scannerRes.state); if(runtimeRes?.status) setRuntimeStatus(runtimeRes.status);
    const rejected=reads.find(r=>r.status==="rejected") as PromiseRejectedResult|undefined; if(rejected) setError(rejected.reason instanceof Error?rejected.reason.message:"One or more backend reads failed"); else setError(null);
  };

  const closePosition = async (symbol: string) => { setError(null); try { await apiRequest<any>("/api/positions/close", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({symbol}) }); await fetchData(); } catch(err:any){ setError(err.message || `Failed to close ${symbol}`); throw err; } };
  const executeTestOrder = async (symbol: string = "BTCUSDT") => { setIsLoading(true); setError(null); try { await apiRequest<any>("/api/test-order", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({symbol,qty:QUICK_TEST_REQUESTED_QTY}) }); await fetchData(); } catch(err:any){ setError(err.message || "Failed to execute Quick Test order"); } finally { setIsLoading(false); } };
  const toggleScannerAutoTrade = async (autoTrade:boolean) => { setError(null); try { const data=await apiRequest<any>("/api/scanner/toggle-autotrade",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({autoTrade})}); setScannerState(prev=>({...prev,autoTrade:Boolean(data.autoTrade)})); } catch(err:any){ setError(err.message); } };
  const triggerScanNow = async () => { const previous=scannerState; setScannerState(prev=>({...prev,isScanning:true})); setError(null); try { const data=await apiRequest<any>("/api/scanner/scan-now",{method:"POST"}); if(data.state)setScannerState(data.state); } catch(err:any){ setScannerState(previous); setError(err.message); } finally { setScannerState(prev=>({...prev,isScanning:false})); } };
  const refreshTopMarkets = async () => { const previous=scannerState; setScannerState(prev=>({...prev,isScanning:true})); setError(null); try { const data=await apiRequest<any>("/api/scanner/refresh-markets",{method:"POST"}); if(data.state)setScannerState(data.state); } catch(err:any){ setScannerState(previous); setError(err.message); } finally { setScannerState(prev=>({...prev,isScanning:false})); } };
  const setScannerMaxConcurrent = async (maxConcurrent:number) => { setError(null); try { const data=await apiRequest<any>("/api/scanner/max-concurrent",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({maxConcurrent})}); setScannerState(prev=>({...prev,maxConcurrent:Number(data.maxConcurrent)})); } catch(err:any){ setError(err.message); } };
  useEffect(()=>{void fetchData(); const interval=setInterval(()=>void fetchData(),10000); return()=>clearInterval(interval);},[]);
  const toggleBot = async () => { setIsLoading(true); setError(null); try { await apiRequest<any>(isBotRunning?"/api/bot/stop":"/api/bot/start",{method:"POST"}); await fetchData(); } catch(err:any){ setError(err.message || "Failed to change engine state"); } finally { setIsLoading(false); } };
  const resetCircuitBreaker = async () => { setError(null); try { await apiRequest<any>("/api/bot/reset-circuit-breaker",{method:"POST"}); await fetchData(); } catch(err:any){ setError(err.message || "Failed to reset circuit breaker"); } };
  const toggleWatchlist = async (symbol:string,remove:boolean) => { setError(null); try { const data=await apiRequest<any>(remove?"/api/watchlist/remove":"/api/watchlist/add",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({symbol})}); if(Array.isArray(data.watchlist))setWatchlist(data.watchlist); } catch(err:any){ setError(err.message || "Failed to update watchlist"); } };
  const updateSetting = async (key:string,value:number) => { const previous=settings; const next={...settings,[key]:value}; setSettings(next); setError(null); try { const data=await apiRequest<any>("/api/settings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({settings:next})}); if(data.settings)setSettings(data.settings); } catch(err:any){ setSettings(previous); setError(err.message || "Failed to save settings"); } };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 font-sans flex">
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        isConnected={isConnected}
        isBotRunning={isBotRunning}
        demoTrading={settings?.demoTrading}
        connectionStatus={connectionStatus}
        runtimeStatus={runtimeStatus}
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
              onResetCircuitBreaker={resetCircuitBreaker}
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
            <div className="space-y-10">
              <ActiveTradesPage
                positions={positions}
                settings={settings}
                tradeHistory={history}
                onClosePosition={closePosition}
                onRefresh={fetchData}
              />

              <section className="pt-2 border-t border-neutral-800">
                <HistoryPage
                  history={history}
                  source={historySource}
                  metadataCoverage={historyMetadataCoverage}
                />
              </section>
            </div>
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
              riskProfile={riskProfile}
            />
          )}

          {activeTab === 'settings' && (
            <SettingsPage
              settings={settings}
              updateSetting={updateSetting}
              systemLogs={logs}
              riskProfile={riskProfile}
              runtimeStatus={runtimeStatus}
            />
          )}
        </div>
      </div>
    </div>
  );
}
