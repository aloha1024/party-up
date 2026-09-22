import type { TrashFilters } from "../lib/reservation-trash";

export type TrashItem = {
  id: string;
  gameName: string;
  hostName: string;
  deletedAt: string;
  participantCount: number;
};
export type TrashPage = {
  items: TrashItem[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  filters: TrashFilters;
};
