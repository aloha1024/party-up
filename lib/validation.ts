import { z } from "zod";
const text = (max: number) =>
  z.string().trim().min(1, "不能为空").max(max, `最多 ${max} 个字符`);
export const nickname = text(24)
  .transform((v) => v.normalize("NFKC"))
  .pipe(text(24));
export const joinSchema = z.object({ name: nickname });
export const createSchema = z.object({
  gameName: text(80),
  hostName: nickname,
  scheduledAt: z
    .string()
    .datetime({ offset: true, message: "请选择有效时间" })
    .refine((v) => Date.parse(v) > Date.now(), "预约时间必须是未来时间"),
  maxPlayers: z
    .number()
    .int()
    .min(2, "人数至少为 2")
    .max(100, "人数最多为 100"),
  description: z.string().trim().max(1000, "备注最多 1000 个字符").default(""),
});
