import { AppError } from "./errors";
import { remainingBudget } from "./request-budget";
export async function readJsonBody(
  req: Request,
  limit = 16384,
  timeoutMs = 2000,
): Promise<unknown> {
  const length = req.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > limit)
    throw new AppError("TOO_LARGE", "请求内容过长", 413);
  const reader = req.body?.getReader();
  if (!reader) throw new SyntaxError("Empty JSON");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          reject(
            new AppError("BODY_TIMEOUT", "请求内容接收超时，请检查网络", 408),
          );
          void reader.cancel().catch(() => {});
        },
        Math.min(timeoutMs, remainingBudget()),
      );
    });
    const read = async () => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > limit) throw new AppError("TOO_LARGE", "请求内容过长", 413);
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return JSON.parse(new TextDecoder().decode(bytes));
    };
    return await Promise.race([read(), timeout]);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}
