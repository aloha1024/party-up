import { UserAccount } from "@/components/user-account";
import Link from "next/link";
import { currentPageViewer } from "@/server/page-identity";
export const dynamic = "force-dynamic";
export default async function Page() {
  const viewer = await currentPageViewer();
  return (
    <>
      <UserAccount />
      {viewer.mode === "user" && !viewer.user?.mustChangePassword && (
        <nav
          aria-label="账号功能"
          className="mx-auto mt-6 flex max-w-xl flex-wrap gap-5 text-lime-300"
        >
          <Link href="/account/templates" prefetch={false}>
            常用组局模板
          </Link>
          <Link href="/account/calendar" prefetch={false}>
            日历订阅
          </Link>
        </nav>
      )}
    </>
  );
}
