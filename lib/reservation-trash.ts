import { reservationListSchema } from "./reservation-list";

export const reservationTrashSchema = reservationListSchema.omit({
  view: true,
});
export type TrashFilters = ReturnType<typeof reservationTrashSchema.parse>;

export function reservationTrashUrl(
  filters: TrashFilters,
  page = filters.page,
) {
  const query = new URLSearchParams();
  if (filters.q) query.set("q", filters.q);
  if (filters.date) query.set("date", filters.date);
  if (filters.pageSize !== 12) query.set("pageSize", String(filters.pageSize));
  if (page !== 1) query.set("page", String(page));
  return "/admin/trash" + (query.size ? "?" + query : "");
}
