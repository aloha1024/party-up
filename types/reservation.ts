import type { Status } from "@/lib/status";
export type Reservation = {
  id: string;
  gameName: string;
  hostName: string;
  isHost: boolean;
  editVersion: number;
  scheduledAt: string;
  maxPlayers: number;
  description: string;
  status: Status;
  cancellationReason?: string;
  participants: { id: string; name: string; joinedAt: string; isMe: boolean }[];
};

export type ReservationSummary = Pick<
  Reservation,
  "id" | "gameName" | "hostName" | "scheduledAt" | "maxPlayers" | "status"
> & { participantCount: number };
export type ReservationPage = {
  items: ReservationSummary[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  filters: import("../lib/reservation-list").ReservationFilters;
};
