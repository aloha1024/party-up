import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { requestMetrics } from "./request-metrics";
import { buildVersion } from "./build-version";

export function slowRequestThreshold(value = process.env.SLOW_REQUEST_MS) {
  if (!value || !/^\d+$/.test(value)) return 1000;
  const threshold = Number(value);
  return threshold >= 100 && threshold <= 60000 ? threshold : 1000;
}

// Only known source files or hexadecimal build chunks can become log locations.
// Ignore function names, exception messages, arbitrary paths and query strings.
export function errorDiagnostics(error: unknown) {
  const errorType = errorCategory(error);
  const version = buildVersion();
  let errorLocation: string | undefined;
  const root = process.cwd().replaceAll("\\", "/") + "/";
  const source =
    /^(?:server\/(?:http|request-body|request-budget|request-log|request-metrics|reservations|reservation-list|reservation-trash|admin|admin-auth|admin-accounts|admin-audit|admin-audit-list|creation-result|db|database-config|rate-limit)\.ts|lib\/(?:validation|reservation-list|reservation-trash|admin-audit)\.ts|\.next\/server\/chunks\/(?:ssr\/)?(?:\[root-of-the-server\]__)?[a-f0-9]+(?:\._)?\.js)$/;
  if (error instanceof Error && typeof error.stack === "string") {
    for (const frame of error.stack.split("\n").slice(1, 21)) {
      if (!/^\s+at /.test(frame)) continue;
      const normalized = frame.replaceAll("\\", "/").trimEnd();
      const start = normalized.lastIndexOf(root);
      if (start < 0) continue;
      const match = /^(.+):(\d{1,7}):(\d{1,7})\)?$/.exec(
        normalized.slice(start + root.length),
      );
      if (!match || !source.test(match[1])) continue;
      errorLocation = `${match[1]}:${match[2]}:${match[3]}`;
      break;
    }
  }
  return {
    errorType,
    version,
    errorFingerprint: createHash("sha256")
      .update(`${version}|${errorType}|${errorLocation ?? "unknown"}`)
      .digest("hex")
      .slice(0, 16),
    ...(errorLocation ? { errorLocation } : {}),
  };
}

// Never include query strings, cookies, submitted values, or exception messages.
export function routeLabel(path: string) {
  return path
    .split("/")
    .map((part, index) =>
      index === 3 &&
      ["reservations", "accounts", "trash"].includes(path.split("/")[2]) &&
      part !== "submission"
        ? ":id"
        : index === 4 &&
            ["reservations", "accounts", "trash"].includes(path.split("/")[3])
          ? ":id"
          : part,
    )
    .join("/");
}
export function requestContext(method: string, pathname: string) {
  const requestId = randomUUID();
  const started = performance.now();
  let finished = false;
  return {
    requestId,
    finish(
      status: number,
      code?: string,
      diagnostic?: string | ReturnType<typeof errorDiagnostics>,
    ) {
      if (finished) return;
      finished = true;
      const elapsed = performance.now() - started;
      const slow = elapsed >= slowRequestThreshold();
      const transactions = requestMetrics();
      const entry = JSON.stringify({
        event: "http_request",
        requestId,
        method,
        route: routeLabel(pathname),
        status,
        code: code || "OK",
        ...(typeof diagnostic === "string"
          ? { errorType: diagnostic }
          : diagnostic),
        durationMs: Math.round(elapsed),
        slow,
        ...transactions,
      });
      if (status >= 500) console.error(entry);
      else if (status >= 400 || slow) console.warn(entry);
      else console.info(entry);
    },
  };
}

// Classify faults without logging ORM messages (which may include submitted data).
export function errorCategory(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError)
    return /^P[0-9]{4}$/.test(error.code) ? `PRISMA_${error.code}` : "PRISMA";
  if (error instanceof Prisma.PrismaClientInitializationError)
    return "PRISMA_INITIALIZATION";
  if (error instanceof Prisma.PrismaClientValidationError)
    return "PRISMA_VALIDATION";
  if (error instanceof TypeError) return "TYPE_ERROR";
  if (error instanceof RangeError) return "RANGE_ERROR";
  return "UNEXPECTED";
}
