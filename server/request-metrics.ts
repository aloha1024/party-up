import { AsyncLocalStorage } from "node:async_hooks";

type RequestMetrics = {
  transactionAttempts: number;
  transactionRetries: number;
  transactionMs: number;
  busy: boolean;
};
const metrics = new AsyncLocalStorage<RequestMetrics>();
export function withRequestMetrics<T>(run: () => T): T {
  return metrics.run(
    {
      transactionAttempts: 0,
      transactionRetries: 0,
      transactionMs: 0,
      busy: false,
    },
    run,
  );
}
export function requestMetrics() {
  const current = metrics.getStore();
  return current
    ? { ...current, transactionMs: Math.round(current.transactionMs) }
    : undefined;
}
export function recordRetry() {
  const current = metrics.getStore();
  if (current) current.transactionRetries++;
}
export function recordBusy() {
  const current = metrics.getStore();
  if (current) current.busy = true;
}
// Wall time of each transaction call includes its queue wait and execution.
export async function measureTransaction<T>(run: () => Promise<T>): Promise<T> {
  const current = metrics.getStore();
  if (!current) return run();
  current.transactionAttempts++;
  const started = performance.now();
  try {
    return await run();
  } finally {
    current.transactionMs += performance.now() - started;
  }
}
