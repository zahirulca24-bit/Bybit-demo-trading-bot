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
    source?: 'auto' | 'manual' | 'external' | 'unknown';
    openingOrderId?: string | null;
    openingOrderLinkId?: string | null;
    closingOrderId?: string | null;
    closingOrderLinkId?: string | null;
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
        exit_audit JSONB,
        source VARCHAR(10) NOT NULL DEFAULT 'unknown',
        opening_order_id VARCHAR(100),
        opening_order_link_id VARCHAR(100),
        closing_order_id VARCHAR(100),
        closing_order_link_id VARCHAR(100)
      );

      ALTER TABLE trades ADD COLUMN IF NOT EXISTS entry_diagnostics JSONB;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS exit_audit JSONB;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS source VARCHAR(10) NOT NULL DEFAULT 'unknown';
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS opening_order_id VARCHAR(100);
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS opening_order_link_id VARCHAR(100);
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS closing_order_id VARCHAR(100);
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS closing_order_link_id VARCHAR(100);
      UPDATE trades SET source = 'unknown' WHERE source IS NULL OR source NOT IN ('auto','manual','external','unknown');

      CREATE TABLE IF NOT EXISTS bot_settings (
        key VARCHAR(100) PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE bot_settings ALTER COLUMN key TYPE VARCHAR(100);

      CREATE TABLE IF NOT EXISTS account_snapshots (
        id SERIAL PRIMARY KEY,
        boundary_ts TIMESTAMPTZ NOT NULL,
        reporting_date VARCHAR(10) NOT NULL,
        timezone VARCHAR(50) NOT NULL,
        wallet_balance NUMERIC(20, 8),
        equity NUMERIC(20, 8),
        available_balance NUMERIC(20, 8),
        captured_at TIMESTAMPTZ NOT NULL,
        source VARCHAR(50) NOT NULL,
        reliable_boundary BOOLEAN NOT NULL DEFAULT FALSE,
        UNIQUE(boundary_ts, timezone)
      );

      CREATE TABLE IF NOT EXISTS report_events (
        event_key VARCHAR(150) PRIMARY KEY,
        event_type VARCHAR(50) NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        reporting_date VARCHAR(10),
        payload JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS report_events_type_time_idx ON report_events(event_type, occurred_at);
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
  source?: 'auto' | 'manual' | 'external' | 'unknown';
  openingOrderId?: string | null;
  openingOrderLinkId?: string | null;
  closingOrderId?: string | null;
  closingOrderLinkId?: string | null;
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
          `INSERT INTO trades (symbol, side, entry_price, size_notional, margin_used, leverage, status, entry_diagnostics, source, opening_order_id, opening_order_link_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', $7, $8, $9, $10)`,
          [
            trade.symbol,
            trade.side,
            trade.entryPrice,
            trade.sizeNotional ?? 1000.0,
            trade.marginUsed ?? 100.0,
            trade.leverage ?? 10,
            trade.entryDiagnostics ? JSON.stringify(trade.entryDiagnostics) : null,
            trade.source || 'unknown',
            trade.openingOrderId || null,
            trade.openingOrderLinkId || null
          ]
        );
      }
    } else {
      // CLOSED
      const closedTime = trade.closedAt ? new Date(trade.closedAt) : new Date();
      // Update existing open or insert if missing
      const updateRes = await pool.query(
        `UPDATE trades 
         SET exit_price = $1, status = 'CLOSED', exit_reason = $2, realized_pnl = $3, closed_at = $4, exit_audit = $5,
             closing_order_id = COALESCE($6, closing_order_id), closing_order_link_id = COALESCE($7, closing_order_link_id),
             source = CASE WHEN source = 'unknown' AND $8 IS NOT NULL THEN $8 ELSE source END
         WHERE symbol = $9 AND status = 'OPEN'`,
        [
          trade.exitPrice ?? 0,
          trade.exitReason || 'Other / Unknown',
          trade.realizedPnl ?? 0,
          closedTime,
          trade.exitAudit ? JSON.stringify(trade.exitAudit) : null,
          trade.closingOrderId || null,
          trade.closingOrderLinkId || null,
          trade.source || null,
          trade.symbol
        ]
      );

      if (updateRes.rowCount === 0) {
        // Insert closed trade directly if no open record was found
        await pool.query(
          `INSERT INTO trades (symbol, side, entry_price, exit_price, size_notional, margin_used, leverage, status, exit_reason, realized_pnl, closed_at, exit_audit, source, closing_order_id, closing_order_link_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'CLOSED', $8, $9, $10, $11, $12, $13, $14)`,
          [
            trade.symbol,
            trade.side,
            trade.entryPrice,
            trade.exitPrice ?? 0,
            trade.sizeNotional ?? 1000.0,
            trade.marginUsed ?? 100.0,
            trade.leverage ?? 10,
            trade.exitReason || 'Other / Unknown',
            trade.realizedPnl ?? 0,
            closedTime,
            trade.exitAudit ? JSON.stringify(trade.exitAudit) : null,
            trade.source || 'external',
            trade.closingOrderId || null,
            trade.closingOrderLinkId || null
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


export async function dbGetReportTrades(startMs: number, endMs: number): Promise<{ ok: boolean; rows: any[]; error?: string }> {
  if (!isConnected || !pool) {
    return { ok: false, rows: [], error: "Persistent database unavailable for report window" };
  }
  try {
    const start = new Date(startMs);
    const end = new Date(endMs);
    const res = await pool.query(
      `SELECT id, symbol, side, entry_price, exit_price, size_notional, margin_used, leverage, status, exit_reason, realized_pnl, opened_at, closed_at, entry_diagnostics, exit_audit, source, opening_order_id, opening_order_link_id, closing_order_id, closing_order_link_id
       FROM trades
       WHERE (opened_at >= $1 AND opened_at < $2)
          OR (closed_at >= $1 AND closed_at < $2)
          OR (opened_at < $2 AND (closed_at IS NULL OR closed_at >= $2))
       ORDER BY COALESCE(closed_at, opened_at) ASC`,
      [start, end]
    );
    return {
      ok: true,
      rows: res.rows.map((row: any) => ({
        id: String(row.id),
        symbol: row.symbol,
        side: row.side,
        entryPrice: Number(row.entry_price),
        exitPrice: row.exit_price == null ? null : Number(row.exit_price),
        sizeNotional: row.size_notional == null ? null : Number(row.size_notional),
        marginUsed: row.margin_used == null ? null : Number(row.margin_used),
        leverage: row.leverage == null ? null : Number(row.leverage),
        status: row.status,
        exitReason: row.exit_reason || "Other / Unknown",
        realizedPnl: row.realized_pnl == null ? null : Number(row.realized_pnl),
        openedAt: row.opened_at ? new Date(row.opened_at).getTime() : null,
        closedAt: row.closed_at ? new Date(row.closed_at).getTime() : null,
        entryDiagnostics: row.entry_diagnostics || null,
        exitAudit: row.exit_audit || null,
        source: row.source || 'unknown',
        openingOrderId: row.opening_order_id || null,
        openingOrderLinkId: row.opening_order_link_id || null,
        closingOrderId: row.closing_order_id || null,
        closingOrderLinkId: row.closing_order_link_id || null,
      }))
    };
  } catch (err: any) {
    console.error("❌ [Database] Report-window query failed:", err.message);
    return { ok: false, rows: [], error: err.message || "Report-window database query failed" };
  }
}


export async function dbSaveAccountSnapshot(snapshot: {
  boundaryMs: number;
  reportingDate: string;
  timezone: string;
  wallet: number | null;
  equity: number | null;
  available: number | null;
  capturedAt: number;
  source: string;
  reliableBoundary: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  if (!isConnected || !pool) return { ok: false, error: "Persistent database unavailable for account snapshot" };
  try {
    await pool.query(
      `INSERT INTO account_snapshots (boundary_ts, reporting_date, timezone, wallet_balance, equity, available_balance, captured_at, source, reliable_boundary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (boundary_ts, timezone) DO UPDATE SET
         reporting_date = EXCLUDED.reporting_date,
         wallet_balance = EXCLUDED.wallet_balance,
         equity = EXCLUDED.equity,
         available_balance = EXCLUDED.available_balance,
         captured_at = EXCLUDED.captured_at,
         source = EXCLUDED.source,
         reliable_boundary = account_snapshots.reliable_boundary OR EXCLUDED.reliable_boundary`,
      [new Date(snapshot.boundaryMs), snapshot.reportingDate, snapshot.timezone, snapshot.wallet, snapshot.equity, snapshot.available, new Date(snapshot.capturedAt), snapshot.source, snapshot.reliableBoundary],
    );
    return { ok: true };
  } catch (err: any) {
    console.error("❌ [Database] Account snapshot save failed:", err.message);
    return { ok: false, error: err.message || "Account snapshot save failed" };
  }
}

export async function dbGetAccountSnapshot(boundaryMs: number, timezone: string): Promise<{ ok: boolean; row: any | null; error?: string }> {
  if (!isConnected || !pool) return { ok: false, row: null, error: "Persistent database unavailable for account snapshot" };
  try {
    const res = await pool.query(
      `SELECT boundary_ts, reporting_date, timezone, wallet_balance, equity, available_balance, captured_at, source, reliable_boundary
       FROM account_snapshots WHERE boundary_ts = $1 AND timezone = $2 LIMIT 1`,
      [new Date(boundaryMs), timezone],
    );
    if (!res.rows.length) return { ok: true, row: null };
    const row = res.rows[0];
    return { ok: true, row: {
      boundaryMs: new Date(row.boundary_ts).getTime(),
      reportingDate: row.reporting_date,
      timezone: row.timezone,
      wallet: row.wallet_balance == null ? null : Number(row.wallet_balance),
      equity: row.equity == null ? null : Number(row.equity),
      available: row.available_balance == null ? null : Number(row.available_balance),
      capturedAt: new Date(row.captured_at).getTime(),
      source: row.source,
      reliableBoundary: Boolean(row.reliable_boundary),
    }};
  } catch (err: any) {
    console.error("❌ [Database] Account snapshot query failed:", err.message);
    return { ok: false, row: null, error: err.message || "Account snapshot query failed" };
  }
}

export async function dbRecordReportEvent(event: {
  eventKey: string;
  eventType: string;
  occurredAt: number;
  reportingDate?: string;
  payload?: Record<string, any>;
}): Promise<{ ok: boolean; inserted: boolean; error?: string }> {
  if (!isConnected || !pool) return { ok: false, inserted: false, error: "Persistent database unavailable for report event" };
  try {
    const res = await pool.query(
      `INSERT INTO report_events (event_key, event_type, occurred_at, reporting_date, payload)
       VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (event_key) DO NOTHING RETURNING event_key`,
      [event.eventKey, event.eventType, new Date(event.occurredAt), event.reportingDate || null, JSON.stringify(event.payload || {})],
    );
    return { ok: true, inserted: res.rows.length > 0 };
  } catch (err: any) {
    console.error("❌ [Database] Report event persistence failed:", err.message);
    return { ok: false, inserted: false, error: err.message || "Report event persistence failed" };
  }
}

export async function dbGetReportEvents(eventType: string, startMs: number, endMs: number): Promise<{ ok: boolean; rows: any[]; error?: string }> {
  if (!isConnected || !pool) return { ok: false, rows: [], error: "Persistent database unavailable for report events" };
  try {
    const res = await pool.query(
      `SELECT event_key, event_type, occurred_at, reporting_date, payload FROM report_events
       WHERE event_type = $1 AND occurred_at >= $2 AND occurred_at < $3 ORDER BY occurred_at ASC`,
      [eventType, new Date(startMs), new Date(endMs)],
    );
    return { ok: true, rows: res.rows.map((row: any) => ({
      eventKey: row.event_key,
      eventType: row.event_type,
      occurredAt: new Date(row.occurred_at).getTime(),
      reportingDate: row.reporting_date,
      payload: row.payload || {},
    })) };
  } catch (err: any) {
    console.error("❌ [Database] Report event query failed:", err.message);
    return { ok: false, rows: [], error: err.message || "Report event query failed" };
  }
}


export async function dbClaimReportDelivery(key: string, leaseMs: number = 120_000, retryDelayMs: number = 300_000): Promise<{ claimed: boolean; persistent: boolean; error?: string }> {
  const now = Date.now();
  if (!isConnected || !pool) {
    const current = await memoryStore.getSettings(key);
    if (current?.status === "sent") return { claimed: false, persistent: false };
    if (current?.status === "sending" && now - Number(current.claimedAt || 0) < leaseMs) return { claimed: false, persistent: false };
    if (current?.status === "failed" && now - Number(current.failedAt || 0) < retryDelayMs) return { claimed: false, persistent: false };
    await memoryStore.saveSettings(key, { status: "sending", claimedAt: now });
    return { claimed: true, persistent: false };
  }
  try {
    const cutoff = now - leaseMs;
    const retryCutoff = now - retryDelayMs;
    const value = JSON.stringify({ status: "sending", claimedAt: now });
    const res = await pool.query(
      `INSERT INTO bot_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
       WHERE bot_settings.value->>'status' <> 'sent'
         AND (bot_settings.value->>'status' <> 'sending' OR COALESCE((bot_settings.value->>'claimedAt')::bigint, 0) < $3)
         AND (bot_settings.value->>'status' <> 'failed' OR COALESCE((bot_settings.value->>'failedAt')::bigint, 0) < $4)
       RETURNING key`,
      [key, value, cutoff, retryCutoff]
    );
    return { claimed: res.rows.length > 0, persistent: true };
  } catch (err: any) {
    console.error("❌ [Database] Report delivery claim failed:", err.message);
    return { claimed: false, persistent: true, error: err.message };
  }
}

export async function dbCompleteReportDelivery(key: string, sent: boolean, metadata: Record<string, any> = {}): Promise<void> {
  const now = Date.now();
  const value = sent
    ? { status: "sent", sentAt: now, ...metadata }
    : { status: "failed", failedAt: now, ...metadata };
  await dbSaveSettings(key, value);
}
