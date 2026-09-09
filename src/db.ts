import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;
let pool: Pool | null = null;
let isConnected = false;
let persistentDbConfigured = false;

export interface PersistedTradeInput {
  symbol: string; side: string;
  entryPrice?: number | null; exitPrice?: number | null;
  submittedQty?: number | string | null; actualQty?: number | string | null;
  sizeNotional?: number | null; marginUsed?: number | null; leverage?: number | null;
  status: string; exitReason?: string | null; realizedPnl?: number | null;
  openedAt?: number | null; closedAt?: number | null;
  entryDiagnostics?: Record<string, any> | null; exitAudit?: Record<string, any> | null;
  source?: 'auto' | 'manual' | 'external' | 'unknown';
  openingOrderId?: string | null; openingOrderLinkId?: string | null;
  closingOrderId?: string | null; closingOrderLinkId?: string | null;
}

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
}
export function normalizeStoredTrade(row: any) {
  return {
    id: String(row.id), symbol: String(row.symbol || ''), side: String(row.side || ''),
    entryPrice: finiteOrNull(row.entry_price ?? row.entryPrice), exitPrice: finiteOrNull(row.exit_price ?? row.exitPrice),
    submittedQty: finiteOrNull(row.submitted_qty ?? row.submittedQty), actualQty: finiteOrNull(row.actual_qty ?? row.actualQty),
    qty: finiteOrNull(row.actual_qty ?? row.actualQty), sizeNotional: finiteOrNull(row.size_notional ?? row.sizeNotional),
    marginUsed: finiteOrNull(row.margin_used ?? row.marginUsed), leverage: finiteOrNull(row.leverage), status: String(row.status || ''),
    exitReason: row.exit_reason ?? row.exitReason ?? null, realizedPnl: finiteOrNull(row.realized_pnl ?? row.realizedPnl),
    openedAt: row.opened_at instanceof Date ? row.opened_at.getTime() : row.opened_at ? new Date(row.opened_at).getTime() : finiteOrNull(row.openedAt),
    closedAt: row.closed_at instanceof Date ? row.closed_at.getTime() : row.closed_at ? new Date(row.closed_at).getTime() : finiteOrNull(row.closedAt),
    entryDiagnostics: row.entry_diagnostics ?? row.entryDiagnostics ?? null, exitAudit: row.exit_audit ?? row.exitAudit ?? null,
    source: row.source || 'unknown', openingOrderId: row.opening_order_id ?? row.openingOrderId ?? null,
    openingOrderLinkId: row.opening_order_link_id ?? row.openingOrderLinkId ?? null,
    closingOrderId: row.closing_order_id ?? row.closingOrderId ?? null, closingOrderLinkId: row.closing_order_link_id ?? row.closingOrderLinkId ?? null,
  };
}

class InMemoryStore {
  private trades: any[] = []; private settings = new Map<string, any>(); private nextId = 1;
  async init() { console.warn('⚠️ [Database] DATABASE_URL not configured. Using intentional non-persistent metadata mode.'); }
  async recordTrade(trade: PersistedTradeInput) {
    const openId = trade.openingOrderId || null, openLink = trade.openingOrderLinkId || null;
    if (trade.status === 'OPEN') {
      const existing = this.trades.find(r => (openId && r.openingOrderId === openId) || (openLink && r.openingOrderLinkId === openLink));
      if (existing) return { ok: true, id: String(existing.id) };
      if (!openId && !openLink) return { ok: false, error: 'Open metadata requires stable order identity' };
      const row = { id: this.nextId++, ...trade, entryPrice: finiteOrNull(trade.entryPrice), exitPrice: null, submittedQty: finiteOrNull(trade.submittedQty), actualQty: finiteOrNull(trade.actualQty), sizeNotional: finiteOrNull(trade.sizeNotional), marginUsed: finiteOrNull(trade.marginUsed), leverage: finiteOrNull(trade.leverage), realizedPnl: null, openedAt: trade.openedAt ?? Date.now(), closedAt: null, openingOrderId: openId, openingOrderLinkId: openLink };
      this.trades.unshift(row); return { ok: true, id: String(row.id) };
    }
    const match = this.trades.find(r => (openId && r.openingOrderId === openId) || (trade.closingOrderId && r.closingOrderId === trade.closingOrderId));
    if (match) { Object.assign(match, { ...trade, entryPrice: finiteOrNull(trade.entryPrice) ?? match.entryPrice, exitPrice: finiteOrNull(trade.exitPrice), submittedQty: finiteOrNull(trade.submittedQty) ?? match.submittedQty, actualQty: finiteOrNull(trade.actualQty) ?? match.actualQty, sizeNotional: finiteOrNull(trade.sizeNotional) ?? match.sizeNotional, marginUsed: finiteOrNull(trade.marginUsed) ?? match.marginUsed, realizedPnl: finiteOrNull(trade.realizedPnl), status: 'CLOSED', closedAt: trade.closedAt ?? Date.now() }); return { ok: true, id: String(match.id) }; }
    const row = { id: this.nextId++, ...trade, entryPrice: finiteOrNull(trade.entryPrice), exitPrice: finiteOrNull(trade.exitPrice), submittedQty: finiteOrNull(trade.submittedQty), actualQty: finiteOrNull(trade.actualQty), sizeNotional: finiteOrNull(trade.sizeNotional), marginUsed: finiteOrNull(trade.marginUsed), leverage: finiteOrNull(trade.leverage), realizedPnl: finiteOrNull(trade.realizedPnl), openedAt: trade.openedAt ?? null, closedAt: trade.closedAt ?? Date.now() };
    this.trades.unshift(row); return { ok: true, id: String(row.id) };
  }
  async updateOpenFill(openingOrderId: string, actualQty: number, avgEntryPrice: number, actualNotional: number) { const row = this.trades.find(r => r.openingOrderId === openingOrderId && r.status === 'OPEN'); if (!row) return false; row.actualQty = actualQty; row.entryPrice = avgEntryPrice; row.sizeNotional = actualNotional; row.marginUsed = row.leverage && row.leverage > 0 ? actualNotional / row.leverage : null; return true; }
  async getTrades() { return this.trades.map(normalizeStoredTrade); }
  async getClosedTrades() { return (await this.getTrades()).filter(r => r.status === 'CLOSED').sort((a,b) => (b.closedAt || 0) - (a.closedAt || 0)); }
  async getSettings(key: string) { return this.settings.get(key) ?? null; }
  async saveSettings(key: string, value: any) { this.settings.set(key, value); }
}
export const memoryStore = new InMemoryStore();

export async function initDatabase() {
  const connectionString = process.env.DATABASE_URL; persistentDbConfigured = Boolean(connectionString);
  if (!connectionString) { await memoryStore.init(); return false; }
  try {
    pool = new Pool({ connectionString }); const client = await pool.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY, symbol VARCHAR(20) NOT NULL, side VARCHAR(10) NOT NULL,
        entry_price NUMERIC(24,12), exit_price NUMERIC(24,12), submitted_qty NUMERIC(24,12), actual_qty NUMERIC(24,12),
        size_notional NUMERIC(24,8), margin_used NUMERIC(24,8), leverage NUMERIC(12,4), status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
        exit_reason VARCHAR(100), realized_pnl NUMERIC(24,8), opened_at TIMESTAMPTZ, closed_at TIMESTAMPTZ,
        entry_diagnostics JSONB, exit_audit JSONB, source VARCHAR(10) NOT NULL DEFAULT 'unknown',
        opening_order_id VARCHAR(100), opening_order_link_id VARCHAR(100), closing_order_id VARCHAR(100), closing_order_link_id VARCHAR(100)
      );
      ALTER TABLE trades ALTER COLUMN entry_price DROP NOT NULL;
      ALTER TABLE trades ALTER COLUMN size_notional DROP DEFAULT;
      ALTER TABLE trades ALTER COLUMN margin_used DROP DEFAULT;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS submitted_qty NUMERIC(24,12);
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS actual_qty NUMERIC(24,12);
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS entry_diagnostics JSONB; ALTER TABLE trades ADD COLUMN IF NOT EXISTS exit_audit JSONB;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS source VARCHAR(10) NOT NULL DEFAULT 'unknown';
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS opening_order_id VARCHAR(100); ALTER TABLE trades ADD COLUMN IF NOT EXISTS opening_order_link_id VARCHAR(100);
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS closing_order_id VARCHAR(100); ALTER TABLE trades ADD COLUMN IF NOT EXISTS closing_order_link_id VARCHAR(100);
      UPDATE trades SET source='unknown' WHERE source IS NULL OR source NOT IN ('auto','manual','external','unknown');
      CREATE UNIQUE INDEX IF NOT EXISTS trades_opening_order_id_unique ON trades(opening_order_id) WHERE opening_order_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS trades_opening_order_link_id_unique ON trades(opening_order_link_id) WHERE opening_order_link_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS trades_closing_order_id_idx ON trades(closing_order_id);
      CREATE TABLE IF NOT EXISTS bot_settings (key VARCHAR(100) PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW());
      ALTER TABLE bot_settings ALTER COLUMN key TYPE VARCHAR(100);
      CREATE TABLE IF NOT EXISTS account_snapshots (id SERIAL PRIMARY KEY, boundary_ts TIMESTAMPTZ NOT NULL, reporting_date VARCHAR(10) NOT NULL, timezone VARCHAR(50) NOT NULL, wallet_balance NUMERIC(20,8), equity NUMERIC(20,8), available_balance NUMERIC(20,8), captured_at TIMESTAMPTZ NOT NULL, source VARCHAR(50) NOT NULL, reliable_boundary BOOLEAN NOT NULL DEFAULT FALSE, UNIQUE(boundary_ts, timezone));
      CREATE TABLE IF NOT EXISTS report_events (event_key VARCHAR(150) PRIMARY KEY, event_type VARCHAR(50) NOT NULL, occurred_at TIMESTAMPTZ NOT NULL, reporting_date VARCHAR(10), payload JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE INDEX IF NOT EXISTS report_events_type_time_idx ON report_events(event_type, occurred_at);
    `);
    client.release(); isConnected = true; console.log('✅ [Database] Connected to Neon PostgreSQL and schemas initialized successfully.'); return true;
  } catch (err: any) {
    console.error('❌ [Database] PostgreSQL unavailable:', err.message); console.error('❌ [Database] Persistent DB configured; refusing ephemeral trade-write fallback.'); pool = null; isConnected = false; return false;
  }
}

export async function dbRecordTrade(trade: PersistedTradeInput): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!persistentDbConfigured) return memoryStore.recordTrade(trade);
  if (!isConnected || !pool) return { ok: false, error: 'Persistent database unavailable' };
  try {
    if (trade.status === 'OPEN') {
      if (!trade.openingOrderId && !trade.openingOrderLinkId) return { ok: false, error: 'Open trade requires stable unique order identity' };
      const openedAt = trade.openedAt ? new Date(trade.openedAt) : new Date();
      const res = await pool.query(`INSERT INTO trades (symbol,side,entry_price,submitted_qty,actual_qty,size_notional,margin_used,leverage,status,opened_at,entry_diagnostics,source,opening_order_id,opening_order_link_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'OPEN',$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING RETURNING id`, [trade.symbol,trade.side,finiteOrNull(trade.entryPrice),finiteOrNull(trade.submittedQty),finiteOrNull(trade.actualQty),finiteOrNull(trade.sizeNotional),finiteOrNull(trade.marginUsed),finiteOrNull(trade.leverage),openedAt,trade.entryDiagnostics?JSON.stringify(trade.entryDiagnostics):null,trade.source||'unknown',trade.openingOrderId||null,trade.openingOrderLinkId||null]);
      if (res.rows[0]?.id) return { ok:true,id:String(res.rows[0].id) };
      const existing = trade.openingOrderId ? await pool.query('SELECT id FROM trades WHERE opening_order_id=$1 LIMIT 1',[trade.openingOrderId]) : await pool.query('SELECT id FROM trades WHERE opening_order_link_id=$1 LIMIT 1',[trade.openingOrderLinkId]);
      return existing.rows[0]?.id ? {ok:true,id:String(existing.rows[0].id)} : {ok:false,error:'Stable open identity could not be persisted'};
    }
    const closedAt = trade.closedAt ? new Date(trade.closedAt) : new Date();
    if (trade.openingOrderId) {
      const updated = await pool.query(`UPDATE trades SET entry_price=COALESCE($1,entry_price),exit_price=$2,actual_qty=COALESCE($3,actual_qty),size_notional=COALESCE($4,size_notional),margin_used=COALESCE($5,margin_used),leverage=COALESCE($6,leverage),status='CLOSED',exit_reason=$7,realized_pnl=$8,closed_at=$9,closing_order_id=$10,closing_order_link_id=$11,exit_audit=$12,source=CASE WHEN source='unknown' THEN COALESCE($13,source) ELSE source END WHERE opening_order_id=$14 RETURNING id`, [finiteOrNull(trade.entryPrice),finiteOrNull(trade.exitPrice),finiteOrNull(trade.actualQty),finiteOrNull(trade.sizeNotional),finiteOrNull(trade.marginUsed),finiteOrNull(trade.leverage),trade.exitReason||null,finiteOrNull(trade.realizedPnl),closedAt,trade.closingOrderId||null,trade.closingOrderLinkId||null,trade.exitAudit?JSON.stringify(trade.exitAudit):null,trade.source||null,trade.openingOrderId]);
      if (updated.rows[0]?.id) return {ok:true,id:String(updated.rows[0].id)};
    }
    const inserted = await pool.query(`INSERT INTO trades (symbol,side,entry_price,exit_price,submitted_qty,actual_qty,size_notional,margin_used,leverage,status,exit_reason,realized_pnl,opened_at,closed_at,entry_diagnostics,exit_audit,source,opening_order_id,opening_order_link_id,closing_order_id,closing_order_link_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'CLOSED',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) ON CONFLICT DO NOTHING RETURNING id`, [trade.symbol,trade.side,finiteOrNull(trade.entryPrice),finiteOrNull(trade.exitPrice),finiteOrNull(trade.submittedQty),finiteOrNull(trade.actualQty),finiteOrNull(trade.sizeNotional),finiteOrNull(trade.marginUsed),finiteOrNull(trade.leverage),trade.exitReason||null,finiteOrNull(trade.realizedPnl),trade.openedAt?new Date(trade.openedAt):null,closedAt,trade.entryDiagnostics?JSON.stringify(trade.entryDiagnostics):null,trade.exitAudit?JSON.stringify(trade.exitAudit):null,trade.source||'external',trade.openingOrderId||null,trade.openingOrderLinkId||null,trade.closingOrderId||null,trade.closingOrderLinkId||null]);
    return inserted.rows[0]?.id ? {ok:true,id:String(inserted.rows[0].id)} : {ok:false,error:'Closed metadata row already exists or could not be inserted'};
  } catch (err:any) { console.error('❌ [Database] Trade metadata persistence failed:',err.message); return {ok:false,error:err.message}; }
}

export async function dbUpdateOpenTradeFill(openingOrderId:string, actualQty:number, avgEntryPrice:number, actualNotional:number):Promise<boolean>{
  if (!(openingOrderId && Number.isFinite(actualQty) && actualQty>0 && Number.isFinite(avgEntryPrice) && avgEntryPrice>0 && Number.isFinite(actualNotional) && actualNotional>0)) return false;
  if (!persistentDbConfigured) return memoryStore.updateOpenFill(openingOrderId,actualQty,avgEntryPrice,actualNotional);
  if (!isConnected || !pool) return false;
  try { const res=await pool.query(`UPDATE trades SET actual_qty=$1,entry_price=$2,size_notional=$3,margin_used=CASE WHEN leverage>0 THEN $3/leverage ELSE NULL END WHERE opening_order_id=$4 AND status='OPEN'`,[actualQty,avgEntryPrice,actualNotional,openingOrderId]); return (res.rowCount||0)>0; } catch(err:any){ console.error('❌ [Database] Fill update failed:',err.message); return false; }
}

export async function dbGetClosedTrades(){ if(!persistentDbConfigured) return memoryStore.getClosedTrades(); if(!isConnected||!pool) return []; try { const res=await pool.query(`SELECT * FROM trades WHERE status='CLOSED' ORDER BY closed_at DESC`); return res.rows.map(normalizeStoredTrade); } catch(err:any){ console.error('❌ [Database] Closed metadata query failed:',err.message); return []; } }
export async function dbGetTradeMetadata(startMs:number,endMs:number):Promise<{ok:boolean;rows:any[];error?:string}>{ if(!persistentDbConfigured){const rows=(await memoryStore.getTrades()).filter(r=>{const t=r.closedAt??r.openedAt??0;return t>=startMs&&t<endMs});return{ok:true,rows};} if(!isConnected||!pool)return{ok:false,rows:[],error:'Persistent database unavailable'}; try{const res=await pool.query(`SELECT * FROM trades WHERE (opened_at >= $1 AND opened_at < $2) OR (closed_at >= $1 AND closed_at < $2) ORDER BY COALESCE(closed_at,opened_at) DESC`,[new Date(startMs),new Date(endMs)]);return{ok:true,rows:res.rows.map(normalizeStoredTrade)}}catch(err:any){return{ok:false,rows:[],error:err.message}} }
export async function dbGetSettings(key:string){ if(!persistentDbConfigured)return memoryStore.getSettings(key); if(!isConnected||!pool)return null; try{const res=await pool.query('SELECT value FROM bot_settings WHERE key=$1',[key]);return res.rows[0]?.value??null}catch(err:any){console.error('❌ [Database] Error fetching settings:',err.message);return null} }
export async function dbSaveSettings(key:string,value:any){ if(!persistentDbConfigured)return memoryStore.saveSettings(key,value); if(!isConnected||!pool)return; try{await pool.query(`INSERT INTO bot_settings (key,value,updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=$2,updated_at=NOW()`,[key,JSON.stringify(value)])}catch(err:any){console.error('❌ [Database] Error saving settings:',err.message)} }

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
