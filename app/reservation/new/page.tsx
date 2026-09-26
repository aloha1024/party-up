import { CreateForm } from "@/components/reservation-form";
import { notFound } from "next/navigation";
import { identity } from "@/server/http";
import { AppError } from "@/server/errors";
import { reservationTemplate } from "@/server/reservation-template";
import { reservationTemplateSourceSchema } from "@/lib/reservation-template";
import type { PageSearchParams } from "@/lib/reservation-list";

export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const { from } = await searchParams;
  if (from === undefined) return <CreateForm key="new" />;
  const parsed = reservationTemplateSourceSchema.safeParse(from);
  if (!parsed.success)
    return (
      <p role="alert">来源预约参数无效，请从预约详情页重新点击“再开一局”。</p>
    );
  try {
    const template = await reservationTemplate(parsed.data, await identity());
    return <CreateForm key={`copy:${parsed.data}`} template={template} />;
  } catch (error) {
    if (error instanceof AppError) {
      if (error.status === 404) notFound();
      if (error.status === 403) return <p role="alert">{error.message}</p>;
    }
    throw error;
  }
}
