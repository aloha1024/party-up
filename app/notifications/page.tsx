import { randomUUID } from "node:crypto";
import Link from "next/link";
import { z } from "zod";
import { pageIdentity } from "@/server/page-identity";
import { listNotifications } from "@/server/notifications";
import { Notifications } from "@/components/notifications";
export const dynamic = "force-dynamic";
const schema = z.object({
  page: z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(z.number().int().max(100000))
    .default(1),
  unread: z.enum(["all", "unread"]).default("all"),
});
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parsed = schema.safeParse(await searchParams);
  if (!parsed.success)
    return (
      <p>
        提醒筛选无效。<Link href="/notifications">重新查看</Link>
      </p>
    );
  const token = await pageIdentity();
  return (
    <Notifications
      listing={await listNotifications(token, parsed.data)}
      unread={parsed.data.unread}
      sample={randomUUID()}
    />
  );
}
