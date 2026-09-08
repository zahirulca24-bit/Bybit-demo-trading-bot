import { useState, useEffect, useRef } from "react";
import { 
  Settings as SettingsIcon, 
  Send, 
  Wifi, 
  WifiOff, 
  CheckCircle2, 
  AlertCircle, 
  Terminal as TerminalIcon, 
  RefreshCw, 
  ShieldCheck, 
  Activity, 
  Sliders, 
  Clock, 
  Cpu,
  Trash2,
  AlertTriangle,
  Flame,
  ShieldAlert
} from "lucide-react";
import { Settings } from "../types";

interface SettingsPageProps {
  settings: Settings;
  updateSetting: (key: string, value: number) => void;
  systemLogs?: string[];
}

export function SettingsPage({ settings, updateSetting, systemLogs = [] }: SettingsPageProps) {
  // Bybit API Connection Test State
  const [bybitTesting, setBybitTesting] = useState(false);
  const [bybitStatus, setBybitStatus] = useState<{
    tested: boolean;
    success: boolean;
    latencyMs?: number;
    serverTime?: string;
    environment?: string;
    error?: string;
  } | null>(null);

  // Telegram Alert Test State
  const [telegramTesting, setTelegramTesting] = useState(false);
  const [telegramStatus, setTelegramStatus] = useState<{
    tested: boolean;
    success: boolean;
    message?: string;
    error?: string;
  } | null>(null);

  // Diagnostic Logs state
  const [localLogs, setLocalLogs] = useState<string[]>([]);
  const terminalBottomRef = useRef<HTMLDivElement>(null);

  const addDiagLog = (msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLocalLogs((prev) => [...prev.slice(-100), `[${timestamp}] ${msg}`]);
  };

  // Run initial quick test on mount
  useEffect(() => {
    testBybitConnection();
    addDiagLog("Diagnostics panel initialized. Environment: Bybit V5 Demo.");
  }, []);

  useEffect(() => {
    terminalBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [localLogs, systemLogs]);

  // Test Bybit Demo API Connection & Latency
  const testBybitConnection = async () => {
    setBybitTesting(true);
    addDiagLog("Initiating Bybit Demo API ping test...");
    try {
      const res = await fetch("/api/test-bybit");
      const data = await res.json();
      if (data.success) {
        setBybitStatus({
          tested: true,
          success: true,
          latencyMs: data.latencyMs,
          serverTime: data.serverTime,
          environment: data.environment,
        });
        addDiagLog(`Bybit Demo API reachable: Ping latency = ${data.latencyMs}ms, ServerTime = ${data.serverTime}`);
      } else {
        setBybitStatus({
          tested: true,
          success: false,
          latencyMs: data.latencyMs,
          error: data.error || "Unknown Bybit error",
        });
        addDiagLog(`Bybit Demo API error: ${data.error}`);
      }
    } catch (err: any) {
      setBybitStatus({
        tested: true,
        success: false,
        error: err.message || "Failed to contact local proxy endpoint",
      });
      addDiagLog(`Bybit connection test network failure: ${err.message}`);
    } finally {
      setBybitTesting(false);
    }
  };

  // Test Telegram Bot Alert Ping
  const testTelegramAlert = async () => {
    setTelegramTesting(true);
    addDiagLog("Sending test alert ping to configured Telegram chat...");
    try {
      const res = await fetch("/api/test-telegram", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setTelegramStatus({
          tested: true,
          success: true,
          message: data.message || "Test notification successfully received on Telegram!",
        });
        addDiagLog("Telegram alert delivered successfully.");
      } else {
        setTelegramStatus({
          tested: true,
          success: false,
          error: data.message || data.error || "Failed to send Telegram message",
        });
        addDiagLog(`Telegram alert failure: ${data.message || data.error}`);
      }
    } catch (err: any) {
      setTelegramStatus({
        tested: true,
        success: false,
        error: err.message || "Failed to reach Telegram API",
      });
      addDiagLog(`Telegram network error: ${err.message}`);
    } finally {
      setTelegramTesting(false);
    }
  };

  // Calculated Notional Position Size = Margin * Leverage
  const notionalPositionSize = (settings.riskUsdt || 100) * (settings.leverage || 10);
  const maxLossPerTrade = (notionalPositionSize * ((settings.slPercent || 1.0) / 100));

  return (
    <div className="space-y-6 max-w-5xl">
      <header className="pb-4 border-b border-neutral-800">
        <h1 className="text-3xl font-bold tracking-tight text-white mb-1">Risk & Settings</h1>
        <p className="text-neutral-400 text-sm">
          Live configuration for strategy risk brackets, account leverage, circuit breakers, and notification channels.
        </p>
      </header>

      {/* Connectivity & Service Tests Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* 1. Bybit Demo API Connection Test Card */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 flex flex-col justify-between shadow-sm">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20">
                  <Wifi className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="font-bold text-white text-base">Bybit Demo API Connection</h2>
                  <p className="text-xs text-neutral-400">REST V5 & Unified Trading Account</p>
                </div>
              </div>

              {bybitStatus?.tested && (
                <span
                  className={`px-2.5 py-1 rounded-full text-xs font-semibold flex items-center gap-1.5 ${
                    bybitStatus.success
                      ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                      : "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                  }`}
                >
                  {bybitStatus.success ? (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5" /> Connected
                    </>
                  ) : (
                    <>
                      <AlertCircle className="w-3.5 h-3.5" /> Error
                    </>
                  )}
                </span>
              )}
            </div>

            <div className="bg-neutral-950 p-3.5 rounded-lg border border-neutral-800/80 mb-4 space-y-2 text-xs font-mono">
              <div className="flex justify-between items-center">
                <span className="text-neutral-500">Environment</span>
                <span className="text-neutral-200">Bybit Demo (Linear USDT)</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-neutral-500">Ping Latency</span>
                <span className="text-blue-400 font-bold">
                  {bybitStatus?.latencyMs !== undefined ? `${bybitStatus.latencyMs} ms` : "Not tested"}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-neutral-500">Server Sync Time</span>
                <span className="text-neutral-300 truncate max-w-[180px]">
                  {bybitStatus?.serverTime ? new Date(bybitStatus.serverTime).toLocaleTimeString() : "--:--:--"}
                </span>
              </div>
              {bybitStatus?.error && (
                <div className="pt-2 border-t border-neutral-800 text-rose-400 text-[11px] leading-tight">
                  Error: {bybitStatus.error}
                </div>
              )}
            </div>
          </div>

          <button
            onClick={testBybitConnection}
            disabled={bybitTesting}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs transition-colors disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${bybitTesting ? "animate-spin" : ""}`} />
            {bybitTesting ? "Testing Ping..." : "Test Bybit API Ping"}
          </button>
        </div>

        {/* 2. Telegram Bot Alert Test Card */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 flex flex-col justify-between shadow-sm">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                  <Send className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="font-bold text-white text-base">Telegram Alert Channel</h2>
                  <p className="text-xs text-neutral-400">Instant Trade & Scanner Push Alerts</p>
                </div>
              </div>

              {telegramStatus?.tested && (
                <span
                  className={`px-2.5 py-1 rounded-full text-xs font-semibold flex items-center gap-1.5 ${
                    telegramStatus.success
                      ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                      : "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                  }`}
                >
                  {telegramStatus.success ? (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5" /> Operational
                    </>
                  ) : (
                    <>
                      <AlertCircle className="w-3.5 h-3.5" /> Failed
                    </>
                  )}
                </span>
              )}
            </div>

            <p className="text-xs text-neutral-400 mb-4 leading-relaxed">
              Verifies whether your <code className="text-neutral-300">TELEGRAM_BOT_TOKEN</code> and <code className="text-neutral-300">TELEGRAM_CHAT_ID</code> credentials are able to dispatch live signals to your channel.
            </p>

            {telegramStatus?.tested && (
              <div className={`p-3 rounded-lg border text-xs mb-4 ${
                telegramStatus.success
                  ? "bg-emerald-950/20 border-emerald-500/30 text-emerald-300"
                  : "bg-rose-950/20 border-rose-500/30 text-rose-300"
              }`}>
                {telegramStatus.success ? telegramStatus.message : telegramStatus.error}
              </div>
            )}
          </div>

          <button
            onClick={testTelegramAlert}
            disabled={telegramTesting}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-white font-semibold text-xs border border-neutral-700 transition-colors disabled:opacity-50 cursor-pointer"
          >
            <Send className={`w-3.5 h-3.5 ${telegramTesting ? "animate-pulse" : ""}`} />
            {telegramTesting ? "Sending Ping..." : "Send Test Ping to Telegram"}
          </button>
        </div>
      </div>

      {/* Bot Parameters & Strategy Risk Controls */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 shadow-sm">
        <div className="flex items-center justify-between mb-6 pb-4 border-b border-neutral-800">
          <div className="flex items-center gap-3 text-neutral-400">
            <Sliders className="w-5 h-5 text-blue-400" />
            <div>
              <h2 className="font-bold text-white text-base">Strategy Risk Parameters</h2>
              <p className="text-xs text-neutral-400">Real-time parameters applied to newly executed trades & risk controls.</p>
            </div>
          </div>

          <div className="hidden sm:flex items-center gap-2 bg-neutral-950 px-3 py-1.5 rounded-lg border border-neutral-800 text-xs font-mono">
            <span className="text-neutral-500">Notional Size:</span>
            <span className="text-white font-bold">${notionalPositionSize.toLocaleString()} USDT</span>
          </div>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Left Column: Sizing & Concurrency */}
          <div className="space-y-6">
            {/* Leverage Slider: 1x to 50x, Default 10x */}
            <div className="bg-neutral-950 p-4 rounded-xl border border-neutral-800/80">
              <div className="flex justify-between text-xs font-semibold mb-2">
                <label className="text-neutral-300 flex items-center gap-1.5">
                  <Flame className="w-3.5 h-3.5 text-amber-400" /> Default Account Leverage
                </label>
                <span className="text-blue-400 font-mono text-sm font-bold">{settings.leverage || 10}x</span>
              </div>
              <input 
                type="range" 
                min="1" 
                max="50" 
                value={settings.leverage || 10} 
                onChange={(e) => updateSetting('leverage', Number(e.target.value))} 
                className="w-full accent-blue-500 cursor-pointer" 
              />
              <div className="flex justify-between text-[10px] text-neutral-500 mt-1 font-mono">
                <span>1x (Spot equivalent)</span>
                <span>10x (Default)</span>
                <span>50x (Max)</span>
              </div>
              <p className="text-[11px] text-neutral-400 mt-2">
                Cross-margin multiplier for sizing. Configures initial margin efficiency.
              </p>
            </div>
            
            {/* Position Margin Slider: $10 to $1,000, Default $100 */}
            <div className="bg-neutral-950 p-4 rounded-xl border border-neutral-800/80">
              <div className="flex justify-between text-xs font-semibold mb-2">
                <label className="text-neutral-300">Position Margin (USDT)</label>
                <span className="text-emerald-400 font-mono text-sm font-bold">${settings.riskUsdt || 100} USDT</span>
              </div>
              <input 
                type="range" 
                min="10" 
                max="1000" 
                step="10" 
                value={settings.riskUsdt || 100} 
                onChange={(e) => updateSetting('riskUsdt', Number(e.target.value))} 
                className="w-full accent-blue-500 cursor-pointer" 
              />
              <div className="flex justify-between text-[10px] text-neutral-500 mt-1 font-mono">
                <span>$10</span>
                <span>$100 (Default)</span>
                <span>$1,000</span>
              </div>
              <p className="text-[11px] text-emerald-400/90 mt-2 font-mono">
                → With {settings.leverage || 10}x leverage: notional position size = <strong>${notionalPositionSize.toLocaleString()} USDT</strong>
              </p>
            </div>

            {/* Max Open Positions Slider: 1 to 10, Default 5 */}
            <div className="bg-neutral-950 p-4 rounded-xl border border-neutral-800/80">
              <div className="flex justify-between text-xs font-semibold mb-2">
                <label className="text-neutral-300 flex items-center gap-1.5">
                  <Activity className="w-3.5 h-3.5 text-blue-400" /> Max Open Positions (Concurrency)
                </label>
                <span className="text-white font-mono text-sm font-bold">{settings.maxPositions || 5} Slots</span>
              </div>
              <input 
                type="range" 
                min="1" 
                max="10" 
                step="1"
                value={settings.maxPositions || 5} 
                onChange={(e) => updateSetting('maxPositions', Number(e.target.value))} 
                className="w-full accent-blue-500 cursor-pointer" 
              />
              <div className="flex justify-between text-[10px] text-neutral-500 mt-1 font-mono">
                <span>1 Slot</span>
                <span>5 Slots (Default)</span>
                <span>10 Slots</span>
              </div>
              <p className="text-[11px] text-neutral-400 mt-2">
                Maximum number of concurrent active trades allowed simultaneously.
              </p>
            </div>
          </div>

          {/* Right Column: Brackets & Global Circuit Breaker */}
          <div className="space-y-6">
            {/* Hard Take Profit */}
            <div className="bg-neutral-950 p-4 rounded-xl border border-neutral-800/80">
              <div className="flex justify-between text-xs font-semibold mb-2">
                <label className="text-neutral-300">Hard Take Profit (TP)</label>
                <span className="text-emerald-400 font-mono text-sm font-bold">+{settings.tpPercent || 1.5}%</span>
              </div>
              <input 
                type="range" 
                min="0.5" 
                max="10.0" 
                step="0.1" 
                value={settings.tpPercent || 1.5} 
                onChange={(e) => updateSetting('tpPercent', Number(e.target.value))} 
                className="w-full accent-blue-500 cursor-pointer" 
              />
              <p className="text-[11px] text-neutral-400 mt-1">
                Attached IOC limit bracket. Target gain: <strong>+${(notionalPositionSize * ((settings.tpPercent || 1.5) / 100)).toFixed(2)} USDT</strong>
              </p>
            </div>
            
            {/* Hard Stop Loss (SL): Default -1.0% */}
            <div className="bg-neutral-950 p-4 rounded-xl border border-neutral-800/80">
              <div className="flex justify-between text-xs font-semibold mb-2">
                <label className="text-neutral-300">Hard Stop Loss (SL)</label>
                <span className="text-rose-400 font-mono text-sm font-bold">-{settings.slPercent || 1.0}%</span>
              </div>
              <input 
                type="range" 
                min="0.1" 
                max="5.0" 
                step="0.1" 
                value={settings.slPercent || 1.0} 
                onChange={(e) => updateSetting('slPercent', Number(e.target.value))} 
                className="w-full accent-rose-500 cursor-pointer" 
              />
              <p className="text-[11px] text-rose-400/90 mt-1 font-mono">
                → Capped loss: <strong>-${maxLossPerTrade.toFixed(2)} USDT</strong> per ${notionalPositionSize.toLocaleString()} position.
              </p>
            </div>

            {/* Global Max Loss / Circuit Breaker */}
            <div className="bg-neutral-950 p-4 rounded-xl border border-rose-500/30">
              <div className="flex items-center justify-between text-xs font-semibold mb-2">
                <label className="text-white flex items-center gap-1.5">
                  <ShieldAlert className="w-3.5 h-3.5 text-rose-400" /> Global Max Loss / Circuit Breaker
                </label>
                <span className="text-rose-400 font-mono text-sm font-bold">
                  -${Math.abs(settings.maxLossUsdt || 100)} USDT
                </span>
              </div>
              
              <div className="flex items-center gap-2 mt-2">
                <span className="text-xs text-neutral-400 font-mono">-$</span>
                <input 
                  type="number" 
                  min="10" 
                  max="5000" 
                  step="10"
                  value={Math.abs(settings.maxLossUsdt || 100)} 
                  onChange={(e) => updateSetting('maxLossUsdt', Math.abs(Number(e.target.value)))} 
                  className="bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-1.5 text-xs text-white font-mono w-32 focus:outline-none focus:border-rose-500"
                />
                <span className="text-xs text-neutral-500 font-mono">Net PnL Threshold</span>
              </div>

              <p className="text-[11px] text-rose-300/80 mt-2 leading-relaxed">
                Emergency circuit breaker: When Net Realized + Floating PnL drops to or below this threshold, the bot engine automatically halts and immediately closes all open trades.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* System Diagnostics Terminal at Bottom */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 shadow-sm">
        <div className="flex items-center justify-between mb-3 pb-3 border-b border-neutral-800">
          <div className="flex items-center gap-2">
            <TerminalIcon className="w-5 h-5 text-emerald-400" />
            <h2 className="font-bold text-white text-base">System Diagnostics Terminal</h2>
            <span className="text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded font-mono">
              Live Stream
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setLocalLogs([])}
              className="p-1.5 rounded-lg bg-neutral-950 hover:bg-neutral-800 text-neutral-400 hover:text-white border border-neutral-800 transition-colors text-xs flex items-center gap-1 cursor-pointer"
              title="Clear Terminal Logs"
            >
              <Trash2 className="w-3.5 h-3.5" /> Clear
            </button>
          </div>
        </div>

        <div className="bg-neutral-950 rounded-xl p-4 font-mono text-xs text-neutral-300 h-56 overflow-y-auto border border-neutral-800/80 space-y-1">
          {/* Display merged diagnostics and system logs */}
          {systemLogs.length === 0 && localLogs.length === 0 && (
            <div className="text-neutral-500 italic py-8 text-center">
              No diagnostic events yet. System idle.
            </div>
          )}

          {localLogs.map((log, i) => (
            <div key={`local_${i}`} className="text-blue-300/90 leading-relaxed">
              {log}
            </div>
          ))}

          {systemLogs.map((log, i) => (
            <div 
              key={`sys_${i}`} 
              className={`leading-relaxed ${
                log.includes("🚨") || log.includes("Error") || log.includes("rejected") || log.includes("CIRCUIT BREAKER")
                  ? "text-rose-400"
                  : log.includes("✅") || log.includes("Filled") || log.includes("Buy")
                  ? "text-emerald-400"
                  : log.includes("📡") || log.includes("Scanner")
                  ? "text-indigo-400"
                  : "text-neutral-300"
              }`}
            >
              {log}
            </div>
          ))}
          <div ref={terminalBottomRef} />
        </div>
      </div>
    </div>
  );
}
