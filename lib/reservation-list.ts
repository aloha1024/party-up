import { z } from "zod";

const dateSchema = z.string().refine((value) => {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}, "请选择有效日期");
const integerInput = z
  .union([z.number(), z.string().regex(/^[1-9]\d*$/)])
  .transform(Number);
export const reservationListSchema = z.object({
  q: z
    .string()
    .trim()
    .transform((value) => value.normalize("NFKC"))
    .pipe(z.string().max(80, "搜索内容最多 80 字"))
    .default(""),
  view: z
    .enum(["all", "upcoming", "started", "cancelled"], {
      error: "预约状态筛选无效",
    })
    .default("all"),
  date: dateSchema.default(""),
  page: integerInput.pipe(z.number().int().min(1).max(100000)).default(1),
  pageSize: integerInput.pipe(z.number().int().min(1).max(48)).default(12),
});
export type ReservationFilters = z.infer<typeof reservationListSchema>;
export type PageSearchParams = Record<string, string | string[] | undefined>;
export function listSearchParams(params: URLSearchParams): PageSearchParams {
  const result: PageSearchParams = {};
  for (const key of ["q", "view", "date", "page", "pageSize"]) {
    const values = params.getAll(key);
    if (values.length) result[key] = values.length === 1 ? values[0] : values;
  }
  return result;
}
export function reservationListUrl(
  path: "/" | "/admin",
  filters: ReservationFilters,
  page = filters.page,
) {
  const query = new URLSearchParams();
  if (filters.q) query.set("q", filters.q);
  if (filters.view !== "all") query.set("view", filters.view);
  if (filters.date) query.set("date", filters.date);
  if (filters.pageSize !== 12) query.set("pageSize", String(filters.pageSize));
  if (page !== 1) query.set("page", String(page));
  return path + (query.size ? "?" + query : "");
}
