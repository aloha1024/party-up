export async function healthStatus(
  probe: () => Promise<unknown>,
  timeoutMs = 2000,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    return 200;
  } catch {
    return 503;
  } finally {
    clearTimeout(timer);
  }
}
