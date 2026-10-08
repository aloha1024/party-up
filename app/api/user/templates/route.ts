import { NextRequest } from "next/server";
import { body } from "@/server/http";
import { respondTemplates } from "@/server/saved-template-http";
import {
  createSavedTemplate,
  listSavedTemplates,
} from "@/server/saved-templates";

export const GET = (req: NextRequest) =>
  respondTemplates(req, listSavedTemplates);
export const POST = (req: NextRequest) =>
  respondTemplates(req, async (viewer) =>
    createSavedTemplate(viewer, await body(req)),
  );
