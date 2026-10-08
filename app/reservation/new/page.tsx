import { CreateForm } from "@/components/reservation-form";
import { notFound } from "next/navigation";
import { pageIdentity, currentPageViewer } from "@/server/page-identity";
import { AppError } from "@/server/errors";
import { reservationTemplate } from "@/server/reservation-template";
import { reservationTemplateSourceSchema } from "@/lib/reservation-template";
import type { PageSearchParams } from "@/lib/reservation-list";
import { getSavedTemplate } from "@/server/saved-templates";
import { savedTemplateIdSchema } from "@/lib/saved-template";

export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const { from, template: savedId } = await searchParams;
  if (savedId !== undefined) {
    const parsed = savedTemplateIdSchema.safeParse(savedId);
    if (!parsed.success || from !== undefined)
      return (
        <p role="alert">
          模板来源参数无效，请从常用组局模板重新选择；不能同时指定再开一局来源。
        </p>
      );
    try {
      const saved = await getSavedTemplate(
        await currentPageViewer(),
        parsed.data,
      );
      const {
        visibility,
        gameName,
        hostName,
        maxPlayers,
        description,
        platform,
        gameServer,
      } = saved;
      return (
        <CreateForm
          key={`saved:${saved.id}:${saved.version}`}
          templateMode="saved"
          template={{
            visibility,
            gameName,
            hostName,
            maxPlayers,
            description,
            platform,
            gameServer,
          }}
        />
      );
    } catch (error) {
      if (error instanceof AppError) {
        if (error.status === 404) notFound();
        if (error.status === 401 || error.status === 403)
          return <p role="alert">{error.message}</p>;
      }
      throw error;
    }
  }
  if (from === undefined) return <CreateForm key="new" />;
  const parsed = reservationTemplateSourceSchema.safeParse(from);
  if (!parsed.success)
    return (
      <p role="alert">来源预约参数无效，请从预约详情页重新点击“再开一局”。</p>
    );
  try {
    const template = await reservationTemplate(
      parsed.data,
      await pageIdentity(),
    );
    return <CreateForm key={`copy:${parsed.data}`} template={template} />;
  } catch (error) {
    if (error instanceof AppError) {
      if (error.status === 404) notFound();
      if (error.status === 403) return <p role="alert">{error.message}</p>;
    }
    throw error;
  }
}
