import Link from "next/link";
import { SavedTemplates } from "@/components/saved-templates";
import { currentPageViewer } from "@/server/page-identity";
import { listSavedTemplates } from "@/server/saved-templates";
import { AppError } from "@/server/errors";

export const dynamic = "force-dynamic";
export default async function Page() {
  const viewer = await currentPageViewer();
  try {
    const listing = await listSavedTemplates(viewer);
    return (
      <SavedTemplates
        key={viewer.scope}
        initialItems={listing.items}
        nickname={viewer.user!.nickname}
      />
    );
  } catch (error) {
    if (error instanceof AppError && error.code === "USER_SESSION")
      return (
        <section className="mx-auto max-w-xl space-y-4">
          <h1 className="text-3xl font-bold">常用组局模板</h1>
          <p role="alert">{error.message}</p>
          <Link className="text-lime-300" href="/account">
            前往个人账号
          </Link>
        </section>
      );
    throw error;
  }
}
