export const POSITION_STATE_UNAVAILABLE = "POSITION_STATE_UNAVAILABLE";
export const WALLET_STATE_UNAVAILABLE = "WALLET_STATE_UNAVAILABLE";
export const ORDERBOOK_STATE_UNAVAILABLE = "ORDERBOOK_STATE_UNAVAILABLE";
export const INSTRUMENT_STATE_UNAVAILABLE = "INSTRUMENT_STATE_UNAVAILABLE";
export const POSITION_MODE_UNAVAILABLE = "POSITION_MODE_UNAVAILABLE";
export const LEVERAGE_STATE_UNAVAILABLE = "LEVERAGE_STATE_UNAVAILABLE";
export const QTY_BELOW_MIN = "QTY_BELOW_MIN";
export const QTY_ABOVE_MAX_MARKET = "QTY_ABOVE_MAX_MARKET";
export const MIN_NOTIONAL_NOT_MET = "MIN_NOTIONAL_NOT_MET";
export const INVALID_QTY_STEP = "INVALID_QTY_STEP";
export const REQUESTED_QTY_EXCEEDS_APPROVED = "REQUESTED_QTY_EXCEEDS_APPROVED";

export type PositionLoadResult =
  | { ok: true; positions: any[] }
  | { ok: false; positions: null; error: string; reason: typeof POSITION_STATE_UNAVAILABLE };

export interface InstrumentConstraints {
  qtyStep: number;
  qtyStepText: string;
  minQty: number;
  maxMarketQty: number;
  minNotional: number;
  tickSize: number;
  tickSizeText: string;
}

export type RiskLoadResult<T, R extends string> =
  | { ok: true; value: T }
  | { ok: false; error: string; reason: R };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : String(error || fallback);
}

function isSuccessResponse(response: any): boolean {
  return response?.retCode === 0;
}

function responseError(response: any, fallback: string): string {
  return String(response?.retMsg || fallback);
}

export async function fetchOpenPositions(bybit: any): Promise<PositionLoadResult> {
  try {
    const response = await bybit.getPositionInfo({ category: "linear", settleCoin: "USDT" });
    if (!isSuccessResponse(response) || !Array.isArray(response?.result?.list)) {
      return {
        ok: false,
        positions: null,
        reason: POSITION_STATE_UNAVAILABLE,
        error: responseError(response, "Position response did not contain a valid list"),
      };
    }
    return {
      ok: true,
      positions: response.result.list.filter((position: any) => Number(position?.size || 0) > 0),
    };
  } catch (error) {
    return {
      ok: false,
      positions: null,
      reason: POSITION_STATE_UNAVAILABLE,
      error: errorMessage(error, "Position state unavailable"),
    };
  }
}

export async function fetchUnifiedAvailableBalance(
  bybit: any,
): Promise<RiskLoadResult<number, typeof WALLET_STATE_UNAVAILABLE>> {
  try {
    const response = await bybit.getWalletBalance({ accountType: "UNIFIED", coin: "USDT" });
    const account = response?.result?.list?.[0];
    const available = Number(account?.totalAvailableBalance);
    if (!isSuccessResponse(response) || !account || !Number.isFinite(available) || available < 0) {
      return {
        ok: false,
        reason: WALLET_STATE_UNAVAILABLE,
        error: responseError(response, "Unified totalAvailableBalance is unavailable"),
      };
    }
    return { ok: true, value: available };
  } catch (error) {
    return {
      ok: false,
      reason: WALLET_STATE_UNAVAILABLE,
      error: errorMessage(error, "Unified wallet availability unavailable"),
    };
  }
}

export async function fetchTopOfBook(
  bybit: any,
  symbol: string,
): Promise<RiskLoadResult<{ bid: number; ask: number }, typeof ORDERBOOK_STATE_UNAVAILABLE>> {
  try {
    const response = await bybit.getOrderbook({ category: "linear", symbol, limit: 1 });
    const bid = Number(response?.result?.b?.[0]?.[0]);
    const ask = Number(response?.result?.a?.[0]?.[0]);
    if (!isSuccessResponse(response) || !(bid > 0) || !(ask > 0) || ask < bid) {
      return {
        ok: false,
        reason: ORDERBOOK_STATE_UNAVAILABLE,
        error: responseError(response, "Valid top-of-book bid/ask unavailable"),
      };
    }
    return { ok: true, value: { bid, ask } };
  } catch (error) {
    return {
      ok: false,
      reason: ORDERBOOK_STATE_UNAVAILABLE,
      error: errorMessage(error, "Orderbook unavailable"),
    };
  }
}

export function parseInstrumentConstraints(
  instrument: any,
): RiskLoadResult<InstrumentConstraints, typeof INSTRUMENT_STATE_UNAVAILABLE> {
  const qtyStepText = String(instrument?.lotSizeFilter?.qtyStep ?? "");
  const tickSizeText = String(instrument?.priceFilter?.tickSize ?? "");
  const constraints: InstrumentConstraints = {
    qtyStep: Number(qtyStepText),
    qtyStepText,
    minQty: Number(instrument?.lotSizeFilter?.minOrderQty),
    maxMarketQty: Number(instrument?.lotSizeFilter?.maxMktOrderQty),
    minNotional: Number(instrument?.lotSizeFilter?.minNotionalValue),
    tickSize: Number(tickSizeText),
    tickSizeText,
  };
  if (
    !(constraints.qtyStep > 0) ||
    !(constraints.minQty > 0) ||
    !(constraints.maxMarketQty > 0) ||
    !(constraints.minNotional > 0) ||
    !(constraints.tickSize > 0) ||
    constraints.minQty > constraints.maxMarketQty
  ) {
    return {
      ok: false,
      reason: INSTRUMENT_STATE_UNAVAILABLE,
      error: "Instrument filters missing or invalid (qtyStep/minQty/maxMktOrderQty/minNotionalValue/tickSize)",
    };
  }
  return { ok: true, value: constraints };
}

export async function fetchInstrumentConstraints(
  bybit: any,
  symbol: string,
): Promise<RiskLoadResult<InstrumentConstraints, typeof INSTRUMENT_STATE_UNAVAILABLE>> {
  try {
    const response = await bybit.getInstrumentsInfo({ category: "linear", symbol });
    const instrument = response?.result?.list?.[0];
    if (!isSuccessResponse(response) || !instrument) {
      return {
        ok: false,
        reason: INSTRUMENT_STATE_UNAVAILABLE,
        error: responseError(response, "Instrument info unavailable"),
      };
    }
    return parseInstrumentConstraints(instrument);
  } catch (error) {
    return {
      ok: false,
      reason: INSTRUMENT_STATE_UNAVAILABLE,
      error: errorMessage(error, "Instrument info unavailable"),
    };
  }
}

function decimalPlaces(text: string): number {
  const value = text.trim().toLowerCase();
  if (!value) return 0;
  if (value.includes("e-")) {
    const [mantissa, exponentText] = value.split("e-");
    const exponent = Number(exponentText);
    const fraction = mantissa.split(".")[1]?.length || 0;
    return Number.isFinite(exponent) ? exponent + fraction : fraction;
  }
  return value.split(".")[1]?.length || 0;
}

function quantizeNumber(value: number, step: number, mode: "floor" | "ceil" | "round"): number {
  const ratio = value / step;
  const epsilon = 1e-10;
  const units = mode === "floor"
    ? Math.floor(ratio + epsilon)
    : mode === "ceil"
      ? Math.ceil(ratio - epsilon)
      : Math.round(ratio);
  return units * step;
}

function formatByStep(value: number, stepText: string): string {
  return value.toFixed(decimalPlaces(stepText));
}

function stepAligned(value: number, step: number): boolean {
  if (!(step > 0) || !Number.isFinite(value)) return false;
  const units = value / step;
  return Math.abs(units - Math.round(units)) <= 1e-8;
}

export type QuantityValidationResult =
  | { ok: true; qty: number; qtyText: string; actualNotional: number }
  | { ok: false; reason: string; error: string };

export function calculateApprovedQuantity(
  approvedNotional: number,
  executionPrice: number,
  constraints: InstrumentConstraints,
): QuantityValidationResult {
  if (!(approvedNotional > 0) || !(executionPrice > 0)) {
    return { ok: false, reason: INSTRUMENT_STATE_UNAVAILABLE, error: "Approved notional or execution price is invalid" };
  }
  const rawQty = approvedNotional / executionPrice;
  const qty = quantizeNumber(rawQty, constraints.qtyStep, "floor");
  const actualNotional = qty * executionPrice;
  if (!(qty > 0) || qty + 1e-12 < constraints.minQty) {
    return { ok: false, reason: QTY_BELOW_MIN, error: "Risk-approved quantity is below minQty; refusing to round upward" };
  }
  if (qty - 1e-12 > constraints.maxMarketQty) {
    return { ok: false, reason: QTY_ABOVE_MAX_MARKET, error: "Risk-approved quantity exceeds max market quantity" };
  }
  if (actualNotional + 1e-9 < constraints.minNotional) {
    return { ok: false, reason: MIN_NOTIONAL_NOT_MET, error: "Risk-approved quantity is below minNotional; refusing to round upward" };
  }
  if (actualNotional > approvedNotional + Math.max(1e-8, approvedNotional * 1e-10)) {
    return { ok: false, reason: REQUESTED_QTY_EXCEEDS_APPROVED, error: "Quantization increased exposure above approved notional" };
  }
  return {
    ok: true,
    qty,
    qtyText: formatByStep(qty, constraints.qtyStepText),
    actualNotional,
  };
}

export function validateFinalRequestedQuantity(
  requestedQty: string | number | undefined,
  approved: { qty: number; actualNotional: number },
  executionPrice: number,
  approvedNotional: number,
  constraints: InstrumentConstraints,
): QuantityValidationResult {
  if (requestedQty === undefined || requestedQty === null || requestedQty === "") {
    return {
      ok: true,
      qty: approved.qty,
      qtyText: formatByStep(approved.qty, constraints.qtyStepText),
      actualNotional: approved.actualNotional,
    };
  }
  const qty = Number(requestedQty);
  if (!(qty > 0) || !Number.isFinite(qty)) {
    return { ok: false, reason: INVALID_QTY_STEP, error: "Requested quantity must be a positive finite number" };
  }
  if (!stepAligned(qty, constraints.qtyStep)) {
    return { ok: false, reason: INVALID_QTY_STEP, error: "Requested quantity is not aligned to qtyStep" };
  }
  if (qty + 1e-12 < constraints.minQty) {
    return { ok: false, reason: QTY_BELOW_MIN, error: "Requested quantity is below minQty" };
  }
  if (qty - 1e-12 > constraints.maxMarketQty) {
    return { ok: false, reason: QTY_ABOVE_MAX_MARKET, error: "Requested quantity exceeds max market quantity" };
  }
  const actualNotional = qty * executionPrice;
  if (actualNotional + 1e-9 < constraints.minNotional) {
    return { ok: false, reason: MIN_NOTIONAL_NOT_MET, error: "Requested quantity is below minNotional" };
  }
  if (
    qty > approved.qty + Math.max(1e-12, constraints.qtyStep * 1e-8) ||
    actualNotional > approvedNotional + Math.max(1e-8, approvedNotional * 1e-10)
  ) {
    return {
      ok: false,
      reason: REQUESTED_QTY_EXCEEDS_APPROVED,
      error: "Requested quantity exceeds the risk-approved quantity/notional",
    };
  }
  return { ok: true, qty, qtyText: formatByStep(qty, constraints.qtyStepText), actualNotional };
}

export function quantizePrice(
  value: number,
  tickSize: number,
  tickSizeText: string,
  mode: "floor" | "ceil" | "round" = "round",
): string {
  if (!(value > 0) || !(tickSize > 0)) throw new Error("Invalid price or tickSize");
  return formatByStep(quantizeNumber(value, tickSize, mode), tickSizeText);
}

export function quantizeProtectivePrices(
  side: "Buy" | "Sell",
  takeProfit: number,
  stopLoss: number,
  constraints: InstrumentConstraints,
): { takeProfit: string; stopLoss: string } {
  return side === "Buy"
    ? {
        takeProfit: quantizePrice(takeProfit, constraints.tickSize, constraints.tickSizeText, "floor"),
        stopLoss: quantizePrice(stopLoss, constraints.tickSize, constraints.tickSizeText, "ceil"),
      }
    : {
        takeProfit: quantizePrice(takeProfit, constraints.tickSize, constraints.tickSizeText, "ceil"),
        stopLoss: quantizePrice(stopLoss, constraints.tickSize, constraints.tickSizeText, "floor"),
      };
}

export async function ensureOneWayPositionMode(
  bybit: any,
  symbol: string,
): Promise<RiskLoadResult<true, typeof POSITION_MODE_UNAVAILABLE>> {
  try {
    const response = await bybit.switchPositionMode({ category: "linear", symbol, mode: 0 });
    const message = String(response?.retMsg || "").toLowerCase();
    if (isSuccessResponse(response) || message.includes("not modified") || message.includes("already")) {
      return { ok: true, value: true };
    }
    return { ok: false, reason: POSITION_MODE_UNAVAILABLE, error: responseError(response, "Unable to enforce one-way position mode") };
  } catch (error) {
    const message = errorMessage(error, "Unable to enforce one-way position mode");
    const normalized = message.toLowerCase();
    if (normalized.includes("not modified") || normalized.includes("already")) return { ok: true, value: true };
    return { ok: false, reason: POSITION_MODE_UNAVAILABLE, error: message };
  }
}

export async function ensureConfiguredLeverage(
  bybit: any,
  symbol: string,
  leverage: number,
): Promise<RiskLoadResult<true, typeof LEVERAGE_STATE_UNAVAILABLE>> {
  try {
    const response = await bybit.setLeverage({
      category: "linear",
      symbol,
      buyLeverage: String(leverage),
      sellLeverage: String(leverage),
    });
    const message = String(response?.retMsg || "").toLowerCase();
    if (isSuccessResponse(response) || message.includes("not modified") || message.includes("already")) {
      return { ok: true, value: true };
    }
    return { ok: false, reason: LEVERAGE_STATE_UNAVAILABLE, error: responseError(response, "Unable to enforce leverage") };
  } catch (error) {
    const message = errorMessage(error, "Unable to enforce leverage");
    const normalized = message.toLowerCase();
    if (normalized.includes("not modified") || normalized.includes("already")) return { ok: true, value: true };
    return { ok: false, reason: LEVERAGE_STATE_UNAVAILABLE, error: message };
  }
}

export function mergePositionUpdates(current: any[], updates: any[]): any[] {
  const keyOf = (position: any) => `${String(position?.symbol || "")}:${Number(position?.positionIdx ?? 0)}`;
  const merged = new Map<string, any>();
  for (const position of current || []) {
    if (!position?.symbol || Number(position?.size || 0) <= 0) continue;
    merged.set(keyOf(position), { ...position });
  }
  for (const update of updates || []) {
    if (!update?.symbol) continue;
    const key = keyOf(update);
    const previous = merged.get(key) || {};
    if (Object.prototype.hasOwnProperty.call(update, "size") && Number(update.size || 0) <= 0) {
      merged.delete(key);
      continue;
    }
    const next = { ...previous, ...update };
    if (Number(next.size || 0) > 0) merged.set(key, next);
  }
  return [...merged.values()];
}

export interface OrderFillSnapshot {
  confirmed: boolean;
  filledQty: number;
  avgFillPrice: number | null;
  executions: any[];
  error?: string;
}

export async function fetchOrderFillSnapshot(bybit: any, symbol: string, orderId: string): Promise<OrderFillSnapshot> {
  try {
    const response = await bybit.getExecutionList({ category: "linear", symbol, orderId, limit: 100 });
    if (!isSuccessResponse(response) || !Array.isArray(response?.result?.list)) {
      return { confirmed: false, filledQty: 0, avgFillPrice: null, executions: [], error: responseError(response, "Execution status unavailable") };
    }
    const executions = response.result.list.filter((item: any) =>
      String(item?.orderId || "") === String(orderId) &&
      String(item?.execType || "Trade") === "Trade" &&
      Number(item?.execQty || 0) > 0 &&
      Number(item?.execPrice || 0) > 0
    );
    const filledQty = executions.reduce((sum: number, item: any) => sum + Number(item.execQty), 0);
    const filledNotional = executions.reduce((sum: number, item: any) => sum + Number(item.execQty) * Number(item.execPrice), 0);
    return {
      confirmed: filledQty > 0,
      filledQty,
      avgFillPrice: filledQty > 0 ? filledNotional / filledQty : null,
      executions,
    };
  } catch (error) {
    return { confirmed: false, filledQty: 0, avgFillPrice: null, executions: [], error: errorMessage(error, "Execution status unavailable") };
  }
}
