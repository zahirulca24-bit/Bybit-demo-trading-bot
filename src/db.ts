import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

// Configure Neon to use Node.js WebSocket for serverless driver if needed
neonConfig.webSocketConstructor = ws;

let pool: Pool | null = null;
let isConnected = false;

// In-memory fallback store when DATABASE_URL is missing
class InMemoryStore {
  private trades: any[] = [];
  private settings: Map<string, any> = new Map();

  async init() {
    console.warn("⚠️ [Database] DATABASE_URL is not defined. Falling back to in-memory mock store.");
  }

  async recordTrade(trade: {
    symbol: string;
    side: string;
    entryPrice: number;
    exitPrice?: number;
    sizeNotional?: number;
    marginUsed?: number;
    leverage?: number;
    status: string;
    exitReason?: string;
    realizedPnl?: number;
    closedAt?: number;
    entryDiagnostics?: Record<string, any>;
    exitAudit?: Record<string, any>;
  }) {
    const existingIndex = this.trades.findIndex(t => t.symbol === trade.symbol && t.status === 'OPEN');
    if (trade.status === 'OPEN') {
      if (existingIndex === -1) {
        this.trades.unshift({
          id: Date.now(),
          ...trade,
          opened_at: new Date().toISOString(),
          closed_at: null
        });
      }
    } else {
      // CLOSED
      if (existingIndex !== -1) {
        this.trades[existingIndex] = {
          ...this.trades[existingIndex],
          exit_price: trade.exitPrice,
          status: 'CLOSED',
          exit_reason: trade.exitReason,
          realized_pnl: trade.realizedPnl,
          closed_at: trade.closedAt ? new Date(trade.closedAt).toISOString() : new Date().toISOString(),
          exitAudit: trade.exitAudit
        };
      } else {
        this.trades.unshift({
          id: Date.now(),
          ...trade,
          status: 'CLOSED',
          opened_at: new Date().toISOString(),
          closed_at: trade.closedAt ? new Date(trade.closedAt).toISOString() : new Date().toISOString(),
          exitAudit: trade.exitAudit
        });
      }
    }
  }

  async getClosedTrades() {
    return this.trades.filter(t => t.status === 'CLOSED').sort((a, b) => new Date(b.closed_at || 0).getTime() - new Date(a.closed_at || 0).getTime());
  }

  async getSettings(key: string) {
    return this.settings.get(key) || null;
  }

  async saveSettings(key: string, value: any) {
    this.settings.set(key, value);
  }
}

export const memoryStore = new InMemoryStore();

export async function initDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    await memoryStore.init();
    return false;
  }

  try {
    pool = new Pool({ connectionString });
    // Test connection
    const client = await pool.connect();
    
    // Create tables if not exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(20) NOT NULL,
        side VARCHAR(10) NOT NULL,
        entry_price NUMERIC(16, 6) NOT NULL,
        exit_price NUMERIC(16, 6),
        size_notional NUMERIC(16, 2) DEFAULT 1000.00,
        margin_used NUMERIC(16, 2) DEFAULT 100.00,
        leverage INT DEFAULT 10,
        status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
        exit_reason VARCHAR(50),
        realized_pnl NUMERIC(16, 4),
        opened_at TIMESTAMPTZ DEFAULT NOW(),
        closed_at TIMESTAMPTZ,
        entry_diagnostics JSONB,
        exit_audit JSONB
      );

      ALTER TABLE trades ADD COLUMN IF NOT EXISTS entry_diagnostics JSONB;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS exit_audit JSONB;

      CREATE TABLE IF NOT EXISTS bot_settings (
        key VARCHAR(50) PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    
    client.release();
    isConnected = true;
    console.log("✅ [Database] Connected to Neon PostgreSQL and schemas initialized successfully.");
    return true;
  } catch (err: any) {
    console.error("❌ [Database] Failed to connect or initialize PostgreSQL schema:", err.message);
    console.warn("⚠️ [Database] Falling back to in-memory store due to database connection error.");
    pool = null;
    isConnected = false;
    await memoryStore.init();
    return false;
  }
}

export async function dbRecordTrade(trade: {
  symbol: string;
  side: string;
  entryPrice: number;
  exitPrice?: number;
  sizeNotional?: number;
  marginUsed?: number;
  leverage?: number;
  status: string;
  exitReason?: string;
  realizedPnl?: number;
  closedAt?: number;
  entryDiagnostics?: Record<string, any>;
  exitAudit?: Record<string, any>;
}) {
  if (!isConnected || !pool) {
    await memoryStore.recordTrade(trade);
    return;
  }

  try {
    if (trade.status === 'OPEN') {
      // Check if open trade already exists for symbol
      const check = await pool.query("SELECT id FROM trades WHERE symbol = $1 AND status = 'OPEN'", [trade.symbol]);
      if (check.rows.length === 0) {
        await pool.query(
          `INSERT INTO trades (symbol, side, entry_price, size_notional, margin_used, leverage, status, entry_diagnostics)
           VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', $7)`,
          [
            trade.symbol,
            trade.side,
            trade.entryPrice,
            trade.sizeNotional || 1000.0,
            trade.marginUsed || 100.0,
            trade.leverage || 10,
            trade.entryDiagnostics ? JSON.stringify(trade.entryDiagnostics) : null
          ]
        );
      }
    } else {
      // CLOSED
      const closedTime = trade.closedAt ? new Date(trade.closedAt) : new Date();
      // Update existing open or insert if missing
      const updateRes = await pool.query(
        `UPDATE trades 
         SET exit_price = $1, status = 'CLOSED', exit_reason = $2, realized_pnl = $3, closed_at = $4, exit_audit = $5
         WHERE symbol = $6 AND status = 'OPEN'`,
        [
          trade.exitPrice || 0,
          trade.exitReason || 'Manual',
          trade.realizedPnl || 0,
          closedTime,
          trade.exitAudit ? JSON.stringify(trade.exitAudit) : null,
          trade.symbol
        ]
      );

      if (updateRes.rowCount === 0) {
        // Insert closed trade directly if no open record was found
        await pool.query(
          `INSERT INTO trades (symbol, side, entry_price, exit_price, size_notional, margin_used, leverage, status, exit_reason, realized_pnl, closed_at, exit_audit)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'CLOSED', $8, $9, $10, $11)`,
          [
            trade.symbol,
            trade.side,
            trade.entryPrice,
            trade.exitPrice || 0,
            trade.sizeNotional || 1000.0,
            trade.marginUsed || 100.0,
            trade.leverage || 10,
            trade.exitReason || 'Manual',
            trade.realizedPnl || 0,
            closedTime,
            trade.exitAudit ? JSON.stringify(trade.exitAudit) : null
          ]
        );
      }
    }
  } catch (err: any) {
    console.error("❌ [Database] Error recording trade in PostgreSQL:", err.message);
    await memoryStore.recordTrade(trade);
  }
}

export async function dbGetClosedTrades() {
  if (!isConnected || !pool) {
    return await memoryStore.getClosedTrades();
  }

  try {
    const res = await pool.query(
      `SELECT id, symbol, side, entry_price, exit_price, size_notional, margin_used, leverage, status, exit_reason, realized_pnl, opened_at, closed_at, entry_diagnostics, exit_audit
       FROM trades
       WHERE status = 'CLOSED'
       ORDER BY closed_at DESC`
    );
    return res.rows.map(row => ({
      id: row.id.toString(),
      symbol: row.symbol,
      side: row.side,
      entryPrice: parseFloat(row.entry_price),
      exitPrice: row.exit_price ? parseFloat(row.exit_price) : undefined,
      qty: (parseFloat(row.size_notional) / parseFloat(row.entry_price)).toFixed(3),
      pnl: parseFloat(row.realized_pnl || '0'),
      pnlPercent: row.entry_price && row.exit_price ? ((parseFloat(row.exit_price) - parseFloat(row.entry_price)) / parseFloat(row.entry_price)) * 100 * (row.side === 'Sell' ? -1 : 1) : 0,
      reason: row.exit_reason || 'Unknown / Other',
      entryDiagnostics: row.entry_diagnostics || undefined,
      exitAudit: row.exit_audit || undefined,
      time: row.closed_at ? new Date(row.closed_at).getTime() : Date.now()
    }));
  } catch (err: any) {
    console.error("❌ [Database] Error fetching closed trades from PostgreSQL:", err.message);
    return await memoryStore.getClosedTrades();
  }
}

export async function dbGetSettings(key: string) {
  if (!isConnected || !pool) {
    return await memoryStore.getSettings(key);
  }
  try {
    const res = await pool.query("SELECT value FROM bot_settings WHERE key = $1", [key]);
    if (res.rows.length > 0) {
      return res.rows[0].value;
    }
    return null;
  } catch (err: any) {
    console.error("❌ [Database] Error fetching settings:", err.message);
    return await memoryStore.getSettings(key);
  }
}

export async function dbSaveSettings(key: string, value: any) {
  if (!isConnected || !pool) {
    await memoryStore.saveSettings(key, value);
    return;
  }
  try {
    await pool.query(
      `INSERT INTO bot_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    );
  } catch (err: any) {
    console.error("❌ [Database] Error saving settings:", err.message);
    await memoryStore.saveSettings(key, value);
  }
}
