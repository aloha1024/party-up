import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

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
  return {
    requestId,
    finish(status: number, code?: string, errorType?: string) {
      const entry = JSON.stringify({
        event: "http_request",
        requestId,
        method,
        route: routeLabel(pathname),
        status,
        code: code || "OK",
        ...(errorType ? { errorType } : {}),
        durationMs: Math.round(performance.now() - started),
      });
      if (status >= 500) console.error(entry);
      else if (status >= 400) console.warn(entry);
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
