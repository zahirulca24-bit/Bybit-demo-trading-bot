import TelegramBot from 'node-telegram-bot-api';

function escapeHtml(text: string | number | undefined | null): string {
  if (text === undefined || text === null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class TelegramNotifier {
  private bot: TelegramBot | null = null;
  private chatId: string | null = null;

  constructor() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (token && chatId) {
      this.bot = new TelegramBot(token, { polling: false });
      this.chatId = chatId;
      console.log("TelegramNotifier initialized");
    } else {
      console.log("Telegram credentials missing. Telegram notifications disabled.");
    }
  }

  async send(message: string): Promise<{ success: boolean; error?: string }> {
    if (this.bot && this.chatId) {
      try {
        await this.bot.sendMessage(this.chatId, message, { parse_mode: 'HTML' });
        return { success: true };
      } catch (err: any) {
        console.error("Failed to send Telegram message:", err.message);
        return { success: false, error: err.message };
      }
    } else {
      return { success: false, error: "Telegram bot token or Chat ID not configured in environment" };
    }
  }

  async sendTestNotification(): Promise<{ success: boolean; error?: string }> {
    return await this.send(
      `🔔 <b>Test Notification from Bybit Trading Engine</b>\n\n` +
      `<b>Status:</b> ✅ Connected &amp; Operational\n` +
      `<b>Time:</b> ${escapeHtml(new Date().toISOString())}\n` +
      `<b>Environment:</b> Bybit Demo Trading`
    );
  }

  async sendTradeExecution(symbol: string, side: string, price: number, qty: string, tp: string, sl: string) {
    const numPrice = typeof price === "number" && !isNaN(price) ? price : 0;
    const msg = `🚨 <b>Trade Executed</b>\n\n` +
      `<b>Symbol:</b> ${escapeHtml(symbol)}\n` +
      `<b>Side:</b> ${escapeHtml(side)}\n` +
      `<b>Entry Price:</b> $${escapeHtml(numPrice.toLocaleString(undefined, { minimumFractionDigits: 2 }))}\n` +
      `<b>Size:</b> ${escapeHtml(qty)}\n` +
      `<b>Take Profit:</b> $${escapeHtml(tp)}\n` +
      `<b>Stop Loss:</b> $${escapeHtml(sl)}\n`;
    await this.send(msg);
  }

  async sendTradeClosed(symbol: string, exitPrice: number, reason: string, pnl: number, pnlPercent: number) {
    const numExitPrice = typeof exitPrice === "number" && !isNaN(exitPrice) ? exitPrice : 0;
    const numPnl = typeof pnl === "number" && !isNaN(pnl) ? pnl : 0;
    const numPnlPercent = typeof pnlPercent === "number" && !isNaN(pnlPercent) ? pnlPercent : 0;
    const emoji = numPnl > 0 ? "✅" : "❌";
    const msg = `${emoji} <b>Trade Closed</b>\n\n` +
      `<b>Symbol:</b> ${escapeHtml(symbol)}\n` +
      `<b>Exit Price:</b> $${escapeHtml(numExitPrice.toLocaleString(undefined, { minimumFractionDigits: 2 }))}\n` +
      `<b>Reason:</b> ${escapeHtml(reason)}\n` +
      `<b>PnL:</b> $${escapeHtml(numPnl.toFixed(2))} (${escapeHtml(numPnlPercent.toFixed(2))}%)`;
    await this.send(msg);
  }

  async sendBotStatus(running: boolean) {
    const msg = running 
      ? `🟢 <b>Bot Started</b>\nScanning markets and executing trades.`
      : `🔴 <b>Bot Stopped</b>\nTrading loop paused.`;
    await this.send(msg);
  }

  async sendScannerSignal(symbol: string, price: number, rsi: number, ema9: number, ema21: number, autoTraded: boolean) {
    const numPrice = typeof price === "number" && !isNaN(price) ? price : 0;
    const numRsi = typeof rsi === "number" && !isNaN(rsi) ? rsi : 50;
    const numEma9 = typeof ema9 === "number" && !isNaN(ema9) ? ema9 : 0;
    const numEma21 = typeof ema21 === "number" && !isNaN(ema21) ? ema21 : 0;
    const msg = `📡 <b>Market Scanner Alert</b>\n\n` +
      `<b>Symbol:</b> #${escapeHtml(symbol)}\n` +
      `<b>Signal:</b> 🚀 Bullish Momentum &amp; EMA Cross\n` +
      `<b>Current Price:</b> $${escapeHtml(numPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }))}\n` +
      `<b>RSI (14):</b> ${escapeHtml(numRsi.toFixed(1))} (Prime 40-65 Zone)\n` +
      `<b>EMA 9:</b> $${escapeHtml(numEma9.toFixed(2))} | <b>EMA 21:</b> $${escapeHtml(numEma21.toFixed(2))}\n` +
      `<b>Auto-Execution:</b> ${autoTraded ? '✅ Market Order Dispatched' : '⏸️ Auto-Trade Disabled'}`;
    await this.send(msg);
  }

  async sendScanner5mSignal(
    symbol: string,
    side: "LONG" | "SHORT",
    grade: "GRADE_A" | "GRADE_B",
    price: number,
    rsi: number,
    ema50: number,
    ema200: number,
    volumeRatio: number,
    reason: string
  ) {
    const numPrice = typeof price === "number" && !isNaN(price) ? price : 0;
    const numRsi = typeof rsi === "number" && !isNaN(rsi) ? rsi : 50;
    const numEma50 = typeof ema50 === "number" && !isNaN(ema50) ? ema50 : 0;
    const numEma200 = typeof ema200 === "number" && !isNaN(ema200) ? ema200 : 0;
    const numVol = typeof volumeRatio === "number" && !isNaN(volumeRatio) ? (volumeRatio * 100).toFixed(0) : "100";
    const sideEmoji = side === "LONG" ? "🟢 <b>5M LONG SIGNAL</b>" : "🔴 <b>5M SHORT SIGNAL</b>";
    const gradeBadge = grade === "GRADE_A" ? "🏆 <b>GRADE_A (High Conviction)</b>" : "⚡ <b>GRADE_B (Moderate Volume)</b>";

    const msg = `⚡ <b>5-Minute Perpetual Scanner Alert</b>\n\n` +
      `<b>Symbol:</b> #${escapeHtml(symbol)}\n` +
      `<b>Signal:</b> ${sideEmoji} [${gradeBadge}]\n` +
      `<b>Price:</b> $${escapeHtml(numPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }))}\n` +
      `<b>RSI (14):</b> ${escapeHtml(numRsi.toFixed(1))}\n` +
      `<b>50 EMA:</b> $${escapeHtml(numEma50.toFixed(2))} | <b>200 EMA:</b> $${escapeHtml(numEma200.toFixed(2))}\n` +
      `<b>Volume:</b> ${escapeHtml(numVol)}% of 20-period avg\n\n` +
      `<b>Analysis:</b> ${escapeHtml(reason)}`;
    await this.send(msg);
  }
}
