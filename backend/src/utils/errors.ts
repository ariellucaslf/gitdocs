export class HttpError extends Error {
  constructor(public statusCode: number, public code: string) { super(code); }
}

export function externalStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') return error.status;
  return undefined;
}

export function retryDelay(error: unknown): number {
  const headers = (error as { response?: { headers?: Record<string, unknown> } })?.response?.headers;
  const retryAfter = headers?.['retry-after'];
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 86400000);
  const reset = Number(headers?.['x-ratelimit-reset']);
  return Number.isFinite(reset) && reset * 1000 > Date.now() ? Math.min(reset * 1000 - Date.now(), 86400000) : 0;
}
