import type { Status } from "@/lib/status";
export type ReservationTemplate = Pick<
  Reservation,
  | "gameName"
  | "hostName"
  | "maxPlayers"
  | "description"
  | "visibility"
  | "platform"
  | "gameServer"
>;
export type Reservation = {
  platform?: string;
  gameServer?: string;
  meeting?: import("../lib/reservation-meeting").Meeting | null;
  visibility?: "PUBLIC" | "INVITE";
  id: string;
  gameName: string;
  hostName: string;
  isHost: boolean;
  editVersion: number;
  endedAt?: string | null;
  scheduledAt: string;
  registrationDeadline?: string | null;
  recruitmentPaused?: boolean;
  maxPlayers: number;
  description: string;
  status: Status;
  cancellationReason?: string;
  participants: {
    checkedInAt?: string | null;
    attendanceVersion?: number;
    id: string;
    name: string;
    joinedAt: string;
    isMe: boolean;
    isHost: boolean;
  }[];
  waitlist: {
    id: number;
    name: string;
    joinedAt: string;
    isMe: boolean;
    isHost: boolean;
  }[];
};

export type ReservationSummary = Pick<
  Reservation,
  | "id"
  | "gameName"
  | "hostName"
  | "scheduledAt"
  | "registrationDeadline"
  | "recruitmentPaused"
  | "maxPlayers"
  | "status"
  | "visibility"
> & { participantCount: number };
export type ReservationPage = {
  items: ReservationSummary[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  filters: import("../lib/reservation-list").ReservationFilters;
};
