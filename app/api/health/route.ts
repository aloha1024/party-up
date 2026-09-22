import { db } from "@/server/db";
import { healthStatus } from "@/lib/health";
export const dynamic = "force-dynamic";
export async function GET() {
  const status = await healthStatus(() => db.$queryRaw`SELECT 1`);
  return Response.json(
    { status: status === 200 ? "ok" : "unavailable" },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
