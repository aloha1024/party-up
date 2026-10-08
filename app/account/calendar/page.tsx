import Link from "next/link";
import { currentPageViewer } from "@/server/page-identity";
import { calendarSettings } from "@/server/calendar-subscription";
import { CalendarSubscription } from "@/components/calendar-subscription";

export const dynamic = "force-dynamic";
export default async function Page() {
  const viewer = await currentPageViewer();
  if (viewer.mode !== "user" || viewer.user?.mustChangePassword)
    return (
      <section className="panel space-y-4 p-6">
        <h1 className="text-2xl font-bold">日历订阅</h1>
        <p>请登录普通用户账号并完成密码修改后使用。</p>
        <Link
          className="underline"
          href="/account/login?returnTo=%2Faccount%2Fcalendar"
        >
          登录账号
        </Link>
      </section>
    );
  return (
    <CalendarSubscription
      key={viewer.scope}
      initial={await calendarSettings(viewer)}
    />
  );
}
