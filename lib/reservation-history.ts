import { z } from "zod";

export const changeFields = [
  "gameName",
  "hostName",
  "description",
  "scheduledAt",
  "maxPlayers",
] as const;
export const historyItemSchema = z.object({
  id: z.number().int().positive(),
  action: z.enum(["EDIT", "CANCEL", "END", "REOPEN"]),
  actorRole: z.enum(["HOST", "ADMIN"]),
  fields: z.array(z.enum(changeFields)),
  scheduledAtBefore: z.string().datetime().nullable(),
  scheduledAtAfter: z.string().datetime().nullable(),
  maxPlayersBefore: z.number().int().nullable(),
  maxPlayersAfter: z.number().int().nullable(),
  createdAt: z.string().datetime(),
});
export const historyPageSchema = z.object({
  items: z.array(historyItemSchema).max(10),
  nextBefore: z.number().int().positive().nullable(),
});
export type HistoryItem = z.infer<typeof historyItemSchema>;
export type HistoryPage = z.infer<typeof historyPageSchema>;

export function mergeHistory<T extends { id: number }>(...groups: T[][]): T[] {
  return [
    ...new Map(groups.flat().map((item) => [item.id, item])).values(),
  ].sort((a, b) => b.id - a.id);
}

// Read backwards from the new head until it overlaps the visible history.
// Publish the merge only once that gap is complete; failures keep the old view.
type OrderedPage<T> = { items: T[]; nextBefore: number | null };
export async function catchUpHistory<T extends { id: number }>(
  latest: OrderedPage<T>,
  existing: OrderedPage<T>,
  load: (before: number) => Promise<OrderedPage<T>>,
): Promise<OrderedPage<T>> {
  const head = existing.items[0]?.id;
  let page = latest;
  let items = latest.items;
  while (
    head !== undefined &&
    page.nextBefore !== null &&
    page.items.at(-1)!.id > head
  ) {
    const before = page.nextBefore;
    page = await load(before);
    if (
      page.items.some((item) => item.id >= before) ||
      (page.nextBefore !== null && page.nextBefore >= before)
    )
      throw new Error("记录分页异常，请重试");
    items = mergeHistory(items, page.items);
  }
  return {
    items: mergeHistory(items, existing.items),
    nextBefore:
      head === undefined || page.nextBefore === null
        ? page.nextBefore
        : existing.nextBefore,
  };
}
