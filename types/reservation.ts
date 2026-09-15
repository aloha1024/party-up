import type { Status } from "@/lib/status";
export type Reservation = {
  id: string;
  gameName: string;
  hostName: string;
  isHost: boolean;
  scheduledAt: string;
  maxPlayers: number;
  description: string;
  status: Status;
  participants: { id: string; name: string; joinedAt: string; isMe: boolean }[];
};
