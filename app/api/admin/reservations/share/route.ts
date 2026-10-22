import { NextRequest } from "next/server";
import { respond } from "@/server/http";
import { adminReservationShare } from "@/server/admin-reservation-share";

export const GET = (req: NextRequest) =>
  respond(req, () => adminReservationShare(), false);
