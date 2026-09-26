import { z } from "zod";
const text = (max: number) =>
  z.string().trim().min(1, "不能为空").max(max, `最多 ${max} 个字符`);
export const nickname = text(24)
  .transform((v) => v.normalize("NFKC"))
  .pipe(text(24));
export const joinSchema = z.object({ name: nickname });
export const creationInputSchema = z.object({
  visibility: z.enum(["PUBLIC", "INVITE"]).default("PUBLIC"),
  gameName: text(80),
  hostName: nickname,
  scheduledAt: z.string().datetime({ offset: true, message: "请选择有效时间" }),
  maxPlayers: z
    .number()
    .int()
    .min(2, "人数至少为 2")
    .max(100, "人数最多为 100"),
  description: z.string().trim().max(1000, "备注最多 1000 个字符").default(""),
});

export const createSchema = creationInputSchema.extend({
  scheduledAt: creationInputSchema.shape.scheduledAt.refine(
    (v) => Date.parse(v) > Date.now(),
    "预约时间必须是未来时间",
  ),
});

export const editSchema = createSchema.omit({ visibility: true }).extend({
  visibility: z.never().optional(),
  editVersion: z
    .number({ error: "缺少有效的预约版本，请刷新编辑页面" })
    .int("预约版本无效，请刷新编辑页面")
    .min(0, "预约版本无效，请刷新编辑页面")
    .max(Number.MAX_SAFE_INTEGER, "预约版本无效，请刷新编辑页面"),
});

// Preserve the pre-invitation public submission fingerprint, including key order.
export function creationFingerprint(data: z.infer<typeof creationInputSchema>) {
  const { visibility, ...legacy } = data;
  return JSON.stringify(
    visibility === "INVITE" ? { ...legacy, visibility } : legacy,
  );
}
