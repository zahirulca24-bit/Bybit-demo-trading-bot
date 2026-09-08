import { LayoutDashboard, Flame, Radar, History, Settings, Activity, Wifi, WifiOff } from 'lucide-react';

interface SidebarProps {
  demoTrading?: boolean;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  isConnected: boolean;
  connectionStatus?: "live" | "reconnecting" | "disconnected";
  isBotRunning: boolean;
}

export function Sidebar({ activeTab, setActiveTab, isConnected, isBotRunning, demoTrading = true, connectionStatus = "live" }: SidebarProps) {
  const navItems = [
    { id: 'terminal', label: 'Terminal', icon: <LayoutDashboard className="w-5 h-5" /> },
    { id: 'positions', label: 'Active Trades', icon: <Flame className="w-5 h-5" /> },
    { id: 'strategy', label: 'Market Scanner & Strategy', icon: <Radar className="w-5 h-5" /> },
    { id: 'history', label: 'Trade History & PnL', icon: <History className="w-5 h-5" /> },
    { id: 'settings', label: 'Risk & Settings', icon: <Settings className="w-5 h-5" /> },
  ];

  return (
    <div className="w-64 h-screen bg-neutral-900 border-r border-neutral-800 flex flex-col fixed left-0 top-0 text-neutral-300">
      <div className="p-6 border-b border-neutral-800">

        <div className="flex items-center gap-3">
          <div className="bg-blue-500/20 p-2 rounded-lg text-blue-500">
            <Activity className="w-6 h-6" />
          </div>
          <h1 className="font-bold text-lg text-white">Bybit Term</h1>
        </div>
        <div className="mt-3">
          {demoTrading ? (
            <div className="bg-amber-500/10 border border-amber-500/30 text-amber-500 text-[10px] font-bold px-2 py-1 rounded text-center uppercase tracking-wider">
              [DEMO TRADING]
            </div>
          ) : (
            <div className="bg-red-500/10 border border-red-500/30 text-red-500 text-[10px] font-bold px-2 py-1 rounded text-center uppercase tracking-wider">
              [LIVE REAL TRADING]
            </div>
          )}
        </div>

      </div>
      
      <div className="flex-1 py-6 px-4 space-y-2">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => setActiveTab(item.id)}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all font-medium ${
              activeTab === item.id 
                ? 'bg-blue-600/10 text-blue-400 border border-blue-500/20' 
                : 'hover:bg-neutral-800 hover:text-white border border-transparent'
            }`}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>

      <div className="p-4 border-t border-neutral-800">
        <div className="bg-neutral-950 rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-neutral-500">API Connection</span>
            {connectionStatus === "live" || (isConnected && connectionStatus !== "reconnecting") ? (
              <span className="flex items-center gap-1 text-green-500 font-medium">
                <Wifi className="w-3 h-3" /> Live
              </span>
            ) : connectionStatus === "reconnecting" ? (
              <span className="flex items-center gap-1 text-amber-500 font-medium animate-pulse">
                <Wifi className="w-3 h-3 animate-spin" /> Reconnecting...
              </span>
            ) : (
              <span className="flex items-center gap-1 text-red-500 font-medium">
                <WifiOff className="w-3 h-3" /> Disconnected
              </span>
            )}
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-neutral-500">Bot Engine</span>
            {isBotRunning ? (
              <span className="flex items-center gap-1 text-blue-400 font-medium">
                <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" /> Active
              </span>
            ) : (
              <span className="flex items-center gap-1 text-neutral-500 font-medium">
                <div className="w-2 h-2 rounded-full bg-neutral-600" /> Paused
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
