import type { ZodType } from "zod";

type RequestOptions<T> = {
  schema?: ZodType<T>;
  timeoutMs?: number;
  idempotencyKey?: string;
};
export class ClientRequestError extends Error {
  constructor(
    message: string,
    public readonly code: "HTTP" | "NETWORK" | "TIMEOUT" | "INVALID_RESPONSE",
    public readonly status?: number,
    public readonly serverCode?: string,
  ) {
    super(message);
    this.name = "ClientRequestError";
  }
}

// A failed response does not prove that a mutation was rolled back. Never retry writes here.
export async function request<T = unknown>(
  url: string,
  method = "GET",
  data?: unknown,
  { schema, timeoutMs = 15000, idempotencyKey }: RequestOptions<T> = {},
): Promise<T> {
  const controller = new AbortController();
  const uncertain =
    method !== "GET" && method !== "HEAD"
      ? "操作可能已生效，请先刷新页面确认结果，避免重复提交。"
      : "请稍后重新加载。";
  const invalid = (status?: number) =>
    new ClientRequestError(
      "服务器返回内容异常。" + uncertain,
      "INVALID_RESPONSE",
      status,
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ClientRequestError("请求超时。" + uncertain, "TIMEOUT"));
      controller.abort();
    }, timeoutMs);
  });
  const operation = async (): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
          ...(data === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: data === undefined ? undefined : JSON.stringify(data),
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new ClientRequestError(
        "网络连接中断，暂时无法确认结果。" + uncertain,
        "NETWORK",
      );
    }
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      // Reverse proxies may return HTML; never show raw responses or parsing errors.
      if (response.ok) throw invalid(response.status);
    }
    const envelope =
      result && typeof result === "object" && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : null;
    if (!response.ok) {
      const fallback =
        response.status === 401
          ? "登录已失效，请重新登录。"
          : response.status === 403
            ? "没有权限执行此操作。"
            : response.status === 404
              ? "记录不存在或已被删除。"
              : response.status === 429
                ? "操作过于频繁，请稍后再试。"
                : response.status >= 500
                  ? "服务暂时不可用。"
                  : "操作未完成，请检查输入后重试。";
      const message =
        typeof envelope?.error === "string" && envelope.error.trim()
          ? envelope.error
          : fallback;
      throw new ClientRequestError(
        message + (response.status >= 500 ? uncertain : ""),
        "HTTP",
        response.status,
        typeof envelope?.code === "string" ? envelope.code : undefined,
      );
    }
    if (!envelope || !Object.hasOwn(envelope, "data"))
      throw invalid(response.status);
    if (schema) {
      const parsed = schema.safeParse(envelope.data);
      if (!parsed.success) throw invalid(response.status);
      return parsed.data;
    }
    return envelope.data as T;
  };
  try {
    // Also bounds reading a response body that stops arriving after its headers.
    return await Promise.race([timeout, operation()]);
  } finally {
    clearTimeout(timer);
  }
}
