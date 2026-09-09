import { WebsocketClient, RestClientV5 } from "bybit-api";
import EventEmitter from "events";
import { EMA, RSI } from "technicalindicators";

export interface Candle {
  time: number; // in seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface KlineEventPayload {
  symbol: string;
  candle: Candle;
  isConfirmed: boolean;
  technicals: {
    ema9: number;
    prevEma9: number;
    ema21: number;
    prevEma21: number;
    rsi: number;
    prevRsi: number;
  };
}

export interface TickerEventPayload {
  symbol: string;
  price: number;
  markPrice: number;
  raw: any;
}

export class BybitWebSocketManager extends EventEmitter {
  private wsClient: WebsocketClient | null = null;
  private candleBuffers: Map<string, Candle[]> = new Map();
  private subscribedSymbols: Set<string> = new Set();
  private isConnected = false;
  private privateAuthenticated = false;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30000;
  private lastMessageTime = Date.now();
  private lastPrivateMessageTime: number | null = null;
  private lastPrivateError: string | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  constructor(
    private restClient: RestClientV5,
    private apiKey?: string,
    private apiSecret?: string,
    private demoTrading: boolean = process.env.BYBIT_DEMO === "true"
  ) {
    super();
  }

  public async init(initialSymbols: string[]) {
    this.shuttingDown = false;
    this.subscribedSymbols = new Set(initialSymbols);

    await Promise.all(initialSymbols.map((sym) => this.seedCandles(sym)));

    this.connectWs();
    this.startHeartbeatMonitor();
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private connectWs() {
    if (this.shuttingDown) return;
    this.clearReconnectTimer();
    try {
      const previous = this.wsClient;
      this.wsClient = null;
      if (previous) previous.closeAll();

      const client = new WebsocketClient({
        key: this.apiKey,
        secret: this.apiSecret,
        market: "v5",
        demoTrading: this.demoTrading,
        pingInterval: 20000,
      });
      this.wsClient = client;
      this.isConnected = false;
      this.privateAuthenticated = false;
      this.setupListeners(client);
      this.subscribeAll();
      this.emit("status", { status: "connecting", private: this.getPrivateHealth() });
    } catch (err: any) {
      this.lastPrivateError = err?.message || "Failed to connect";
      this.emit("log", `[Bybit WS Error] Failed to connect: ${this.lastPrivateError}`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.shuttingDown || this.reconnectTimer) return;
    this.reconnectAttempts++;
    const delay = Math.min(this.maxReconnectDelay, 1000 * Math.pow(2, this.reconnectAttempts));
    this.emit("log", `[Bybit WS] Reconnecting in ${delay}ms (Attempt ${this.reconnectAttempts})...`);
    this.emit("status", { status: "reconnecting", private: this.getPrivateHealth() });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWs();
    }, delay);
  }

  private forceReconnect(reason: string) {
    if (this.shuttingDown) return;
    this.emit("log", reason);
    this.isConnected = false;
    this.privateAuthenticated = false;
    const stale = this.wsClient;
    this.wsClient = null;
    if (stale) stale.closeAll();
    this.scheduleReconnect();
  }

  private startHeartbeatMonitor() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      if (this.isConnected && now - this.lastMessageTime > 25000) {
        this.forceReconnect("⚠️ [Bybit WS Heartbeat] No message received in 25s. Scheduling one reconnect...");
      }
    }, 5000);
  }

  private setupListeners(client: WebsocketClient) {
    client.on("open", (data: any) => {
      if (this.shuttingDown || client !== this.wsClient) return;
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.clearReconnectTimer();
      this.lastMessageTime = Date.now();
      const wsKey = data?.wsKey || "WS";
      this.emit("log", `[Bybit WS] Connected to stream: ${wsKey}`);
      this.emit("status", { status: "live", private: this.getPrivateHealth() });
    });

    client.on("authenticated", (data: any) => {
      if (this.shuttingDown || client !== this.wsClient) return;
      if (data.success) {
        this.privateAuthenticated = true;
        this.lastPrivateError = null;
        this.lastPrivateMessageTime = Date.now();
        this.emit("log", "[Bybit WS Private] Authenticated successfully for account streams.");
      } else {
        this.privateAuthenticated = false;
        this.lastPrivateError = String(data?.ret_msg || "Private websocket authentication failed");
        this.emit("log", `[Bybit WS Private] Authentication failed: ${this.lastPrivateError}`);
      }
      this.emit("status", { status: data.success ? "live" : "degraded", private: this.getPrivateHealth() });
    });

    client.on("reconnected", (data: any) => {
      if (this.shuttingDown || client !== this.wsClient) return;
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.clearReconnectTimer();
      const wsKey = data?.wsKey || "WS";
      this.emit("log", `[Bybit WS] Stream reconnected: ${wsKey}. Re-verifying subscriptions.`);
      this.subscribeAll();
      this.emit("status", { status: "live", private: this.getPrivateHealth() });
    });

    client.on("close", (data: any) => {
      if (this.shuttingDown || client !== this.wsClient) return;
      this.isConnected = false;
      this.privateAuthenticated = false;
      const wsKey = data?.wsKey || "WS";
      this.emit("log", `[Bybit WS] Stream connection closed: ${wsKey}. Scheduling reconnect with backoff...`);
      this.scheduleReconnect();
    });

    client.on("exception", (err: any) => {
      if (this.shuttingDown || client !== this.wsClient) return;
      this.lastPrivateError = err?.message || JSON.stringify(err);
      this.emit("log", `[Bybit WS Exception] ${this.lastPrivateError}`);
      this.emit("status", { status: "degraded", private: this.getPrivateHealth() });
    });

    client.on("update", (msg: any) => {
      if (this.shuttingDown || client !== this.wsClient) return;
      this.lastMessageTime = Date.now();
      if (!msg || !msg.topic) return;

      const topic: string = msg.topic;
      if (topic.startsWith("kline.")) {
        this.handleKlineMessage(topic, msg.data);
      } else if (topic.startsWith("tickers.")) {
        this.handleTickerMessage(topic, msg.data);
      } else if (topic === "position") {
        this.lastPrivateMessageTime = Date.now();
        this.handlePositionMessage(msg.data);
      } else if (topic === "execution") {
        this.lastPrivateMessageTime = Date.now();
        this.handleExecutionMessage(msg.data);
      } else if (topic === "wallet") {
        this.lastPrivateMessageTime = Date.now();
        this.handleWalletMessage(msg.data);
      }
    });
  }

  public subscribeAll() {
    if (!this.wsClient || this.shuttingDown) return;

    const publicTopics: string[] = [];
    for (const sym of this.subscribedSymbols) {
      publicTopics.push(`kline.1.${sym}`);
      publicTopics.push(`tickers.${sym}`);
    }

    if (publicTopics.length > 0) {
      this.wsClient.subscribeV5(publicTopics, "linear");
      this.emit("log", `[Bybit WS Public] Subscribed to ${this.subscribedSymbols.size} symbols on 1m Kline streams (${publicTopics.length} topics).`);
    }

    if (this.apiKey && this.apiSecret) {
      const privateTopics = ["position", "execution", "wallet"];
      this.wsClient.subscribeV5(privateTopics, "linear");
      this.emit("log", `[Bybit WS Private] Subscribed to private topics: ${privateTopics.join(", ")}`);
    }
  }

  public async addSymbol(symbol: string) {
    if (this.subscribedSymbols.has(symbol)) return;
    this.subscribedSymbols.add(symbol);
    await this.seedCandles(symbol);

    if (this.wsClient && !this.shuttingDown) {
      const topics = [`kline.1.${symbol}`, `tickers.${symbol}`];
      this.wsClient.subscribeV5(topics, "linear");
      this.emit("log", `[Bybit WS Public] Added 1m subscriptions for ${symbol}`);
    }
  }

  public removeSymbol(symbol: string) {
    if (!this.subscribedSymbols.has(symbol)) return;
    this.subscribedSymbols.delete(symbol);
    this.candleBuffers.delete(symbol);

    if (this.wsClient && !this.shuttingDown) {
      const topics = [`kline.1.${symbol}`, `tickers.${symbol}`];
      this.wsClient.unsubscribeV5(topics, "linear");
      this.emit("log", `[Bybit WS Public] Unsubscribed from ${symbol}`);
    }
  }

  public async seedCandles(symbol: string) {
    try {
      const res = await this.restClient.getKline({
        category: "linear",
        symbol,
        interval: "1",
        limit: 120,
      });

      if (res.result?.list && res.result.list.length > 0) {
        const raw = [...res.result.list].reverse();
        const candles: Candle[] = raw.map((k: any) => ({
          time: Math.floor(parseInt(k[0], 10) / 1000),
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5] || "0"),
        }));

        this.candleBuffers.set(symbol, candles);
        this.emit("log", `[Candle Buffer] Seeded ${candles.length} 1m-candles for ${symbol}`);
      }
    } catch (err: any) {
      this.emit("log", `[Candle Buffer Error] Failed to seed candles for ${symbol}: ${err.message}`);
    }
  }

  public getCandleBuffer(symbol: string): Candle[] {
    return this.candleBuffers.get(symbol) || [];
  }

  private handleKlineMessage(topic: string, data: any[]) {
    const parts = topic.split(".");
    const symbol = parts.length >= 3 ? parts[2] : topic.replace(/^kline\.[0-9]+\./, "");
    if (!data || data.length === 0) return;

    for (const item of data) {
      const candleTime = Math.floor(item.start / 1000);
      const open = parseFloat(item.open);
      const high = parseFloat(item.high);
      const low = parseFloat(item.low);
      const close = parseFloat(item.close);
      const volume = parseFloat(item.volume || "0");
      const isConfirmed = Boolean(item.confirm);

      let buffer = this.candleBuffers.get(symbol);
      if (!buffer) {
        buffer = [];
        this.candleBuffers.set(symbol, buffer);
      }

      const lastCandle = buffer[buffer.length - 1];
      if (lastCandle && lastCandle.time === candleTime) {
        lastCandle.high = Math.max(lastCandle.high, high);
        lastCandle.low = Math.min(lastCandle.low, low);
        lastCandle.close = close;
        lastCandle.volume = volume;
      } else if (!lastCandle || candleTime > lastCandle.time) {
        buffer.push({ time: candleTime, open, high, low, close, volume });
        if (buffer.length > 200) buffer.shift();
      }

      const closePrices = buffer.map((c) => c.close);
      if (closePrices.length >= 22) {
        const ema9List = EMA.calculate({ period: 9, values: closePrices });
        const ema21List = EMA.calculate({ period: 21, values: closePrices });
        const rsi14List = RSI.calculate({ period: 14, values: closePrices });

        if (ema9List.length >= 2 && ema21List.length >= 2 && rsi14List.length >= 2) {
          const currentEma9 = ema9List[ema9List.length - 1];
          const prevEma9 = ema9List[ema9List.length - 2];
          const currentEma21 = ema21List[ema21List.length - 1];
          const prevEma21 = ema21List[ema21List.length - 2];
          const currentRsi = rsi14List[rsi14List.length - 1];
          const prevRsi = rsi14List[rsi14List.length - 2];
          const currentCandle = buffer[buffer.length - 1];
          this.emit("kline", {
            symbol,
            candle: currentCandle,
            isConfirmed,
            technicals: {
              ema9: currentEma9,
              prevEma9,
              ema21: currentEma21,
              prevEma21,
              rsi: currentRsi,
              prevRsi,
            },
          } as KlineEventPayload);
        }
      }
    }
  }

  private handleTickerMessage(topic: string, data: any) {
    const symbol = data.symbol || topic.replace("tickers.", "");
    const priceStr = data.lastPrice || data.markPrice;
    if (!priceStr) return;

    const price = parseFloat(priceStr);
    const markPrice = data.markPrice ? parseFloat(data.markPrice) : price;

    if (!isNaN(price)) {
      this.emit("ticker", { symbol, price, markPrice, raw: data } as TickerEventPayload);
    }
  }

  private handlePositionMessage(data: any[]) {
    if (!Array.isArray(data)) return;
    this.emit("position", data);
  }

  private handleExecutionMessage(data: any[]) {
    if (!Array.isArray(data)) return;
    for (const exec of data) this.emit("execution", exec);
  }

  private handleWalletMessage(data: any[]) {
    if (!Array.isArray(data)) return;
    for (const account of data) {
      const coins = account.coin || [];
      const usdt = coins.find((c: any) => c.coin === "USDT");
      if (usdt && usdt.walletBalance !== undefined) this.emit("wallet", usdt.walletBalance);
    }
  }

  public getPrivateHealth() {
    const configured = Boolean(this.apiKey && this.apiSecret);
    const healthy = configured && this.isConnected && this.privateAuthenticated && !this.shuttingDown;
    const status = !configured
      ? "unavailable"
      : this.shuttingDown
        ? "disconnected"
        : healthy
          ? "healthy"
          : this.isConnected
            ? "connecting"
            : this.reconnectTimer
              ? "connecting"
              : "disconnected";
    return {
      healthy,
      status,
      connected: this.isConnected,
      authenticated: this.privateAuthenticated,
      lastMessageAt: this.lastPrivateMessageTime,
      lastError: this.lastPrivateError,
    } as const;
  }

  public close() {
    this.shuttingDown = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.clearReconnectTimer();
    const client = this.wsClient;
    this.wsClient = null;
    this.isConnected = false;
    this.privateAuthenticated = false;
    if (client) client.closeAll();
    this.emit("status", { status: "disconnected", private: this.getPrivateHealth() });
  }
}
