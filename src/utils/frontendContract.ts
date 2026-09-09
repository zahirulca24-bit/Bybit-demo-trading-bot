export interface ApiErrorShape { message?: string }
export interface ApiEnvelope { success?: boolean; error?: string | ApiErrorShape; message?: string; [key: string]: unknown }

export function extractApiError(payload: unknown, fallback = "Request failed"): string {
  if (!payload || typeof payload !== "object") return fallback;
  const data = payload as ApiEnvelope;
  if (data.error && typeof data.error === "object" && typeof data.error.message === "string" && data.error.message.trim()) return data.error.message;
  if (typeof data.error === "string" && data.error.trim()) return data.error;
  if (typeof data.message === "string" && data.message.trim()) return data.message;
  return fallback;
}

export async function apiRequest<T extends ApiEnvelope>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  let payload: ApiEnvelope = {};
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok || payload.success === false) throw new Error(extractApiError(payload, `${response.status} ${response.statusText || "Request failed"}`));
  return payload as T;
}

export const QUICK_TEST_REQUESTED_QTY = "0.001";

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
}

export function buildFreshAccountSnapshot(balancePayload: any, positionsPayload: any) {
  const walletBalance = finite(balancePayload?.balance);
  if (walletBalance === null || !Array.isArray(positionsPayload?.positions)) return null;
  const values = positionsPayload.positions.map((p: any) => finite(p?.unrealisedPnl ?? p?.unrealizedPnl));
  if (values.some((v: number | null) => v === null)) return null;
  const unrealizedPnl = values.reduce((sum: number, value: number | null) => sum + (value as number), 0);
  return { walletBalance, positions: positionsPayload.positions, unrealizedPnl, estimatedEquity: walletBalance + unrealizedPnl };
}
