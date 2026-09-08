import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { 
  createChart, 
  CandlestickSeries, 
  LineSeries, 
  createSeriesMarkers,
  ColorType, 
  CrosshairMode, 
  IChartApi, 
  ISeriesApi,
  Time
} from "lightweight-charts";
import { CandleData, EmaData, TradeHistory, KlineUpdatePayload } from "../types";
import { RefreshCw, TrendingUp, TrendingDown, Layers, Activity } from "lucide-react";

interface CandlestickChartProps {
  selectedSymbol: string;
  onSelectSymbol?: (symbol: string) => void;
  watchlist?: string[];
  trades?: TradeHistory[];
  latestKlineUpdate?: KlineUpdatePayload | null;
  livePrice?: number;
}

export function CandlestickChart({
  selectedSymbol = "BTCUSDT",
  onSelectSymbol,
  watchlist = ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  trades = [],
  latestKlineUpdate,
  livePrice,
}: CandlestickChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const ema9SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const ema21SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const markersPluginRef = useRef<any>(null);

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredData, setHoveredData] = useState<{
    time?: string;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    ema9?: number;
    ema21?: number;
  } | null>(null);

  const [latestData, setLatestData] = useState<{
    candle?: CandleData;
    ema9?: number;
    ema21?: number;
  }>({});

  // Fetch Kline + EMA data from server
  const fetchChartData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/klines?symbol=${selectedSymbol}&interval=5&limit=120`);
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to load chart data");
      }

      if (chartRef.current && candleSeriesRef.current && ema9SeriesRef.current && ema21SeriesRef.current) {
        const candles: CandleData[] = data.candles || [];
        const ema9: EmaData[] = data.ema9 || [];
        const ema21: EmaData[] = data.ema21 || [];

        // Format for lightweight-charts
        const formattedCandles = candles.map(c => ({
          time: c.time as Time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }));

        const formattedEma9 = ema9.map(e => ({
          time: e.time as Time,
          value: e.value,
        }));

        const formattedEma21 = ema21.map(e => ({
          time: e.time as Time,
          value: e.value,
        }));

        candleSeriesRef.current.setData(formattedCandles);
        ema9SeriesRef.current.setData(formattedEma9);
        ema21SeriesRef.current.setData(formattedEma21);

        if (candles.length > 0) {
          const lastCandle = candles[candles.length - 1];
          const lastEma9 = ema9.length > 0 ? ema9[ema9.length - 1].value : undefined;
          const lastEma21 = ema21.length > 0 ? ema21[ema21.length - 1].value : undefined;
          setLatestData({
            candle: lastCandle,
            ema9: lastEma9,
            ema21: lastEma21,
          });
        }

        // Fit time scale to recent data nicely
        chartRef.current.timeScale().fitContent();
      }
    } catch (err: any) {
      console.error("Chart load error:", err);
      setError(err.message || "Failed to load market chart");
    } finally {
      setIsLoading(false);
    }
  }, [selectedSymbol]);

  // Compute trade markers for this symbol
  const symbolMarkers = useMemo(() => {
    const symbolTrades = trades.filter(t => t.symbol === selectedSymbol);
    const markers: any[] = [];

    symbolTrades.forEach(trade => {
      // Align timestamp to 1-minute or 5-minute candle timestamp (seconds)
      const candleTime = (Math.floor(trade.time / (60 * 1000)) * 60) as Time;
      const entryPriceVal = trade.entryPrice ?? (trade as any).price;

      if (trade.side === "Buy" || (trade as any).type === "buy" || entryPriceVal) {
        markers.push({
          time: candleTime,
          position: "belowBar",
          color: "#22c55e",
          shape: "arrowUp",
          text: `BUY @ $${entryPriceVal ? Number(entryPriceVal).toLocaleString(undefined, { minimumFractionDigits: 2 }) : ""}`,
          size: 1.5,
        });
      }

      if (trade.exitPrice !== undefined && trade.exitPrice !== null) {
        const isWin = (trade.pnl ?? 0) >= 0;
        markers.push({
          time: candleTime,
          position: "aboveBar",
          color: isWin ? "#10b981" : "#ef4444",
          shape: "arrowDown",
          text: `${trade.reason || 'EXIT'} @ $${Number(trade.exitPrice).toLocaleString(undefined, { minimumFractionDigits: 2 })} (${isWin ? '+' : ''}${(trade.pnlPercent ?? 0).toFixed(1)}%)`,
          size: 1.5,
        });
      }
    });

    // Markers must be sorted chronologically ascending by time
    markers.sort((a, b) => (Number(a.time) - Number(b.time)));
    return markers;
  }, [trades, selectedSymbol]);

  // Initialize Lightweight Chart Instance
  useEffect(() => {
    if (!chartContainerRef.current) return;

    // Clean up previous chart instance if exists
    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

    const container = chartContainerRef.current;
    const chart = createChart(container, {
      width: container.clientWidth,
      height: 420,
      layout: {
        background: { type: ColorType.Solid, color: "#09090b" },
        textColor: "#a1a1aa",
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      },
      grid: {
        vertLines: { color: "rgba(39, 39, 42, 0.45)" },
        horzLines: { color: "rgba(39, 39, 42, 0.45)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: "rgba(161, 161, 170, 0.5)",
          width: 1,
          style: 3,
          labelBackgroundColor: "#27272a",
        },
        horzLine: {
          color: "rgba(161, 161, 170, 0.5)",
          width: 1,
          style: 3,
          labelBackgroundColor: "#27272a",
        },
      },
      rightPriceScale: {
        borderColor: "#27272a",
        scaleMargins: {
          top: 0.12,
          bottom: 0.15,
        },
        visible: true,
      },
      timeScale: {
        borderColor: "#27272a",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
    });

    // 1. Candlestick Series (Green / Red)
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
      borderVisible: false,
    });

    // 2. EMA 9 Overlay (Blue)
    const ema9Series = chart.addSeries(LineSeries, {
      color: "#3b82f6",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      title: "EMA 9",
    });

    // 3. EMA 21 Overlay (Amber/Orange)
    const ema21Series = chart.addSeries(LineSeries, {
      color: "#f59e0b",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      title: "EMA 21",
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    ema9SeriesRef.current = ema9Series;
    ema21SeriesRef.current = ema21Series;

    // Create markers plugin
    try {
      const markersPlugin = createSeriesMarkers(candleSeries, symbolMarkers);
      markersPluginRef.current = markersPlugin;
    } catch (e) {
      console.warn("Could not create markers plugin:", e);
    }

    // Crosshair hover listener for OHLC & Indicator legend
    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData) {
        setHoveredData(null);
        return;
      }

      const candleData = param.seriesData.get(candleSeries) as any;
      const ema9Data = param.seriesData.get(ema9Series) as any;
      const ema21Data = param.seriesData.get(ema21Series) as any;

      if (candleData) {
        const timeStr = typeof param.time === "number"
          ? new Date(param.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : String(param.time);

        setHoveredData({
          time: timeStr,
          open: candleData.open,
          high: candleData.high,
          low: candleData.low,
          close: candleData.close,
          ema9: ema9Data?.value,
          ema21: ema21Data?.value,
        });
      }
    });

    // Handle responsive resize via ResizeObserver
    const resizeObserver = new ResizeObserver((entries) => {
      if (entries.length === 0 || !entries[0].contentRect) return;
      const { width } = entries[0].contentRect;
      if (width > 0 && chartRef.current) {
        chartRef.current.applyOptions({ width });
      }
    });

    resizeObserver.observe(container);

    // Initial load
    fetchChartData();

    return () => {
      resizeObserver.disconnect();
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
    };
  }, [selectedSymbol, fetchChartData]);

  // Update markers when trades change
  useEffect(() => {
    if (markersPluginRef.current) {
      try {
        markersPluginRef.current.setMarkers(symbolMarkers);
      } catch (err) {
        console.warn("Failed to set markers:", err);
      }
    }
  }, [symbolMarkers]);

  // Handle live WebSocket kline / price updates
  useEffect(() => {
    if (!latestKlineUpdate || latestKlineUpdate.symbol !== selectedSymbol) return;

    const { candle, ema9, ema21 } = latestKlineUpdate;

    if (candle && candleSeriesRef.current) {
      candleSeriesRef.current.update({
        time: candle.time as Time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      });

      setLatestData(prev => ({
        ...prev,
        candle,
      }));
    }

    if (ema9 && ema9SeriesRef.current) {
      ema9SeriesRef.current.update({
        time: ema9.time as Time,
        value: ema9.value,
      });
      setLatestData(prev => ({
        ...prev,
        ema9: ema9.value,
      }));
    }

    if (ema21 && ema21SeriesRef.current) {
      ema21SeriesRef.current.update({
        time: ema21.time as Time,
        value: ema21.value,
      });
      setLatestData(prev => ({
        ...prev,
        ema21: ema21.value,
      }));
    }
  }, [latestKlineUpdate, selectedSymbol]);

  // Current display figures
  const displayOhlc = hoveredData || (latestData.candle ? {
    open: latestData.candle.open,
    high: latestData.candle.high,
    low: latestData.candle.low,
    close: livePrice || latestData.candle.close,
    ema9: latestData.ema9,
    ema21: latestData.ema21,
  } : null);

  const isBullishCross = (latestData.ema9 ?? 0) > (latestData.ema21 ?? 0);
  const currentPrice = livePrice || latestData.candle?.close;

  return (
    <div id="tradingview-candlestick-chart" className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden flex flex-col shadow-sm">
      {/* Chart Top Navigation / Control Bar */}
      <div className="p-4 border-b border-neutral-800 bg-neutral-900/90 flex flex-wrap items-center justify-between gap-4">
        {/* Left: Symbol Selector and Interval Badge */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5 bg-neutral-950 p-1 rounded-lg border border-neutral-800">
            {watchlist.map((sym) => {
              const isActive = sym === selectedSymbol;
              return (
                <button
                  key={sym}
                  id={`chart-symbol-${sym}`}
                  onClick={() => onSelectSymbol && onSelectSymbol(sym)}
                  className={`px-3 py-1 text-xs font-semibold rounded-md transition-all ${
                    isActive
                      ? "bg-blue-600 text-white shadow"
                      : "text-neutral-400 hover:text-white hover:bg-neutral-800"
                  }`}
                >
                  {sym}
                </button>
              );
            })}
          </div>

          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-neutral-800 text-neutral-300 border border-neutral-700">
            <Layers className="w-3.5 h-3.5 text-blue-400" />
            5m Candles
          </span>

          {/* Trend Tag */}
          {latestData.ema9 && latestData.ema21 && (
            <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border ${
              isBullishCross 
                ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" 
                : "bg-amber-500/10 text-amber-400 border-amber-500/20"
            }`}>
              {isBullishCross ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
              {isBullishCross ? "EMA 9 > EMA 21 (Bullish)" : "EMA 9 < EMA 21 (Bearish)"}
            </span>
          )}
        </div>

        {/* Right: Live Price and Refresh Button */}
        <div className="flex items-center gap-4">
          {currentPrice !== undefined && currentPrice !== null && !isNaN(currentPrice) && (
            <div className="text-right">
              <span className="text-xs text-neutral-400 mr-2">Last Price</span>
              <span className="text-base font-bold text-white font-mono">
                ${Number(currentPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
              </span>
            </div>
          )}

          <button
            id="refresh-chart-button"
            onClick={fetchChartData}
            disabled={isLoading}
            className="p-2 text-neutral-400 hover:text-white transition-colors bg-neutral-950 rounded-lg border border-neutral-800 hover:bg-neutral-800 disabled:opacity-50"
            title="Refresh Chart"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin text-blue-400" : ""}`} />
          </button>
        </div>
      </div>

      {/* OHLC & Indicator Info Ribbon */}
      <div className="px-4 py-2.5 bg-neutral-950/60 border-b border-neutral-800/80 flex flex-wrap items-center justify-between gap-4 text-xs font-mono">
        {displayOhlc ? (
          <div className="flex flex-wrap items-center gap-4 text-neutral-300">
            {displayOhlc.time && (
              <span className="text-neutral-500">{displayOhlc.time}</span>
            )}
            <div>
              <span className="text-neutral-500 mr-1">O</span>
              <span className="font-semibold text-neutral-200">${displayOhlc.open?.toFixed(2)}</span>
            </div>
            <div>
              <span className="text-neutral-500 mr-1">H</span>
              <span className="font-semibold text-emerald-400">${displayOhlc.high?.toFixed(2)}</span>
            </div>
            <div>
              <span className="text-neutral-500 mr-1">L</span>
              <span className="font-semibold text-red-400">${displayOhlc.low?.toFixed(2)}</span>
            </div>
            <div>
              <span className="text-neutral-500 mr-1">C</span>
              <span className={`font-semibold ${(displayOhlc.close || 0) >= (displayOhlc.open || 0) ? 'text-emerald-400' : 'text-red-400'}`}>
                ${displayOhlc.close?.toFixed(2)}
              </span>
            </div>
          </div>
        ) : (
          <span className="text-neutral-500 flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 text-blue-500" />
            Interactive 5m Candlestick Chart with Overlays
          </span>
        )}

        {/* Indicator Overlays Legend */}
        <div className="flex items-center gap-4 ml-auto">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-blue-500"></span>
            <span className="text-neutral-400">EMA 9:</span>
            <span className="font-semibold text-blue-400">
              {displayOhlc?.ema9 ? `$${displayOhlc.ema9.toFixed(2)}` : (latestData.ema9 ? `$${latestData.ema9.toFixed(2)}` : "—")}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-500"></span>
            <span className="text-neutral-400">EMA 21:</span>
            <span className="font-semibold text-amber-400">
              {displayOhlc?.ema21 ? `$${displayOhlc.ema21.toFixed(2)}` : (latestData.ema21 ? `$${latestData.ema21.toFixed(2)}` : "—")}
            </span>
          </div>
        </div>
      </div>

      {/* Chart Canvas Area */}
      <div className="relative w-full h-[420px] bg-neutral-950">
        {isLoading && (
          <div className="absolute inset-0 z-10 bg-neutral-950/70 backdrop-blur-xs flex items-center justify-center gap-2 text-sm text-neutral-400">
            <RefreshCw className="w-5 h-5 animate-spin text-blue-500" />
            Loading 5m candlestick data...
          </div>
        )}

        {error && (
          <div className="absolute inset-0 z-10 bg-neutral-950/80 flex flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={fetchChartData}
              className="px-4 py-2 bg-neutral-800 text-white text-xs font-medium rounded-lg hover:bg-neutral-700 transition-colors"
            >
              Retry Loading Chart
            </button>
          </div>
        )}

        <div ref={chartContainerRef} className="w-full h-full" />
      </div>
    </div>
  );
}
