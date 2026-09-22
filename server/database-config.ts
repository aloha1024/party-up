// Prisma 6 runs SQLite busy waits on query-engine workers. Keep one connection
// so overlapping transactions queue asynchronously instead of blocking all workers.
// Leave other providers unchanged for a future PostgreSQL migration.
export function databaseUrl(url: string | undefined): string | undefined {
  if (!url?.startsWith("file:")) return url;
  const separator = url.indexOf("?");
  const path = separator < 0 ? url : url.slice(0, separator);
  const params = new URLSearchParams(
    separator < 0 ? "" : url.slice(separator + 1),
  );
  params.set("connection_limit", "1");
  return `${path}?${params.toString()}`;
}
