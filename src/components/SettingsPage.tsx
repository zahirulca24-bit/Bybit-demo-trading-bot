import { useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, CheckCircle2, AlertCircle, Flame, RefreshCw, Send, ShieldAlert, ShieldCheck, Sliders, Terminal as TerminalIcon, Trash2, Wifi } from "lucide-react";
import { Settings } from "../types";

interface SettingsPageProps {
  settings: Settings;
  updateSetting: (key: string, value: number) => void;
  systemLogs?: string[];
}

export function SettingsPage({ settings, updateSetting, systemLogs = [] }: SettingsPageProps) {
  const [bybitTesting, setBybitTesting] = useState(false);
  const [bybitStatus, setBybitStatus] = useState<{ tested: boolean; success: boolean; latencyMs?: number; serverTime?: string; environment?: string; error?: string } | null>(null);
  const [telegramTesting, setTelegramTesting] = useState(false);
  const [telegramStatus, setTelegramStatus] = useState<{ tested: boolean; success: boolean; message?: string; error?: string } | null>(null);
  const [localLogs, setLocalLogs] = useState<string[]>([]);
  const terminalBottomRef = useRef<HTMLDivElement>(null);

  const addDiagLog = (msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLocalLogs(prev => [...prev.slice(-100), `[${timestamp}] ${msg}`]);
  };

  const testBybitConnection = async () => {
    setBybitTesting(true);
    try {
      const data = await fetch("/api/test-bybit").then(r => r.json());
      setBybitStatus({ tested: true, success: Boolean(data.success), latencyMs: data.latencyMs, serverTime: data.serverTime, environment: data.environment, error: data.error });
      addDiagLog(data.success ? `Bybit Demo API reachable (${data.latencyMs}ms)` : `Bybit API error: ${data.error}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Connection test failed";
      setBybitStatus({ tested: true, success: false, error: message });
      addDiagLog(`Bybit connection failure: ${message}`);
    } finally {
      setBybitTesting(false);
    }
  };

  const testTelegramAlert = async () => {
    setTelegramTesting(true);
    try {
      const data = await fetch("/api/test-telegram", { method: "POST" }).then(r => r.json());
      setTelegramStatus({ tested: true, success: Boolean(data.success), message: data.message, error: data.error || data.message });
      addDiagLog(data.success ? "Telegram test alert delivered" : `Telegram alert failure: ${data.error || data.message}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Telegram test failed";
      setTelegramStatus({ tested: true, success: false, error: message });
      addDiagLog(`Telegram network error: ${message}`);
    } finally {
      setTelegramTesting(false);
    }
  };

  useEffect(() => {
    testBybitConnection();
    addDiagLog("Diagnostics initialized. Strict production risk caps are locked by the backend.");
  }, []);

  useEffect(() => {
    terminalBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [localLogs, systemLogs]);

  const strictControls = [
    ["Leverage", "10x"],
    ["Position margin", "$50"],
    ["Approx. notional", "~$500"],
    ["Max concurrent positions", "3"],
    ["Same-symbol duplicate", "Blocked"],
    ["Post-close cooldown", "10 minutes"],
    ["Daily net entry breaker", "-$50"],
    ["3-loss pause", "30 minutes"],
    ["Breaker scope", "New entries only"],
    ["Stop-loss discipline", "Never widened"],
  ];

  return (
    <div className="space-y-6 max-w-5xl">
      <header className="pb-4 border-b border-neutral-800">
        <h1 className="text-3xl font-bold tracking-tight text-white mb-1">Risk & Settings</h1>
        <p className="text-neutral-400 text-sm">Production strict risk caps are locked by the backend. Existing positions continue management when entry breakers are active.</p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2.5"><Wifi className="w-5 h-5 text-blue-400" /><div><h2 className="font-bold text-white">Bybit Demo API</h2><p className="text-xs text-neutral-400">REST V5 / Unified account</p></div></div>
            {bybitStatus?.tested && <span className={`text-xs font-semibold ${bybitStatus.success ? "text-emerald-400" : "text-rose-400"}`}>{bybitStatus.success ? "Connected" : "Error"}</span>}
          </div>
          <div className="bg-neutral-950 rounded-lg border border-neutral-800 p-3 text-xs space-y-2 mb-4">
            <div className="flex justify-between"><span className="text-neutral-500">Latency</span><span className="text-white">{bybitStatus?.latencyMs !== undefined ? `${bybitStatus.latencyMs} ms` : "--"}</span></div>
            <div className="flex justify-between"><span className="text-neutral-500">Server time</span><span className="text-white">{bybitStatus?.serverTime ? new Date(bybitStatus.serverTime).toLocaleTimeString() : "--"}</span></div>
            {bybitStatus?.error && <p className="text-rose-400">{bybitStatus.error}</p>}
          </div>
          <button onClick={testBybitConnection} disabled={bybitTesting} className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs disabled:opacity-50"><RefreshCw className={`w-3.5 h-3.5 ${bybitTesting ? "animate-spin" : ""}`} />Test Bybit API Ping</button>
        </div>

        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
          <div className="flex items-center gap-2.5 mb-4"><Send className="w-5 h-5 text-indigo-400" /><div><h2 className="font-bold text-white">Telegram Alerts</h2><p className="text-xs text-neutral-400">Signal and execution notifications</p></div></div>
          {telegramStatus?.tested && <div className={`rounded-lg border p-3 text-xs mb-4 ${telegramStatus.success ? "border-emerald-500/30 text-emerald-300" : "border-rose-500/30 text-rose-300"}`}>{telegramStatus.success ? telegramStatus.message || "Operational" : telegramStatus.error}</div>}
          <button onClick={testTelegramAlert} disabled={telegramTesting} className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-white font-semibold text-xs disabled:opacity-50"><Send className="w-3.5 h-3.5" />Send Test Ping to Telegram</button>
        </div>
      </div>

      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 sm:p-6">
        <div className="flex items-center gap-3 mb-4"><ShieldCheck className="w-5 h-5 text-emerald-400" /><div><h2 className="font-bold text-white">Locked Execution & Risk Controls</h2><p className="text-xs text-neutral-400">These values reflect the live strict runtime and are not reset by analytics baseline actions.</p></div></div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {strictControls.map(([label, value]) => <div key={label} className="bg-neutral-950 border border-neutral-800 rounded-lg p-3"><p className="text-[11px] text-neutral-500">{label}</p><p className="text-sm font-bold text-white mt-1">{value}</p></div>)}
        </div>
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-950/10 p-3 text-xs text-amber-200 flex items-start gap-2"><ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" /><span>The daily -$50 breaker blocks <strong>new entries only</strong>. It does not stop the engine, disable scanner auto-trade, close positions, or reset settings/history.</span></div>
      </div>

      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 sm:p-6">
        <div className="flex items-center gap-3 mb-5"><Sliders className="w-5 h-5 text-blue-400" /><div><h2 className="font-bold text-white">Trade Brackets</h2><p className="text-xs text-neutral-400">Existing TP/SL/trailing configuration. Stop-loss logic may tighten protection but must never widen risk.</p></div></div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <SettingInput label="Take Profit %" value={settings.tpPercent} min={0.1} max={10} step={0.1} onChange={v => updateSetting("tpPercent", v)} icon={<Activity className="w-4 h-4 text-emerald-400" />} />
          <SettingInput label="Stop Loss %" value={settings.slPercent} min={0.1} max={5} step={0.1} onChange={v => updateSetting("slPercent", v)} icon={<ShieldAlert className="w-4 h-4 text-rose-400" />} />
          <SettingInput label="Trailing Stop %" value={settings.trailingStopPercent} min={0.1} max={5} step={0.1} onChange={v => updateSetting("trailingStopPercent", v)} icon={<Flame className="w-4 h-4 text-amber-400" />} />
        </div>
      </div>

      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-3 pb-3 border-b border-neutral-800"><div className="flex items-center gap-2"><TerminalIcon className="w-5 h-5 text-emerald-400" /><h2 className="font-bold text-white">System Diagnostics</h2></div><button onClick={() => setLocalLogs([])} className="p-1.5 rounded-lg bg-neutral-950 text-neutral-400 border border-neutral-800 text-xs flex items-center gap-1"><Trash2 className="w-3.5 h-3.5" />Clear</button></div>
        <div className="bg-neutral-950 rounded-xl p-4 font-mono text-xs h-56 overflow-y-auto border border-neutral-800 space-y-1">
          {[...localLogs, ...systemLogs].map((log, i) => <div key={`${i}-${log}`} className={log.includes("🚨") || log.includes("Error") ? "text-rose-400" : log.includes("✅") ? "text-emerald-400" : "text-neutral-300"}>{log}</div>)}
          {localLogs.length + systemLogs.length === 0 && <div className="text-neutral-500 text-center py-8">No diagnostic events yet.</div>}
          <div ref={terminalBottomRef} />
        </div>
      </div>
    </div>
  );
}

function SettingInput({ label, value, min, max, step, onChange, icon }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void; icon: ReactNode }) {
  return <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-4"><label className="text-xs text-neutral-300 flex items-center gap-2 mb-2">{icon}{label}</label><input type="number" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} className="w-full bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2 text-sm text-white" /></div>;
}
