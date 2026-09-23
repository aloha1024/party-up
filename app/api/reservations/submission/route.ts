import { NextRequest } from "next/server";
import { respond } from "@/server/http";
import { lookupCreation } from "@/server/creation-result";
export const dynamic = "force-dynamic";
export const GET = (req: NextRequest) =>
  respond(req, (token) =>
    lookupCreation(token, req.headers.get("idempotency-key")),
  );
