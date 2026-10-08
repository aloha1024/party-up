import { NextRequest } from "next/server";
import { body } from "@/server/http";
import { respondTemplates } from "@/server/saved-template-http";
import {
  deleteSavedTemplate,
  getSavedTemplate,
  updateSavedTemplate,
} from "@/server/saved-templates";

type Context = { params: Promise<{ id: string }> };
export const GET = (req: NextRequest, context: Context) =>
  respondTemplates(req, async (viewer) =>
    getSavedTemplate(viewer, (await context.params).id),
  );
export const PATCH = (req: NextRequest, context: Context) =>
  respondTemplates(req, async (viewer) =>
    updateSavedTemplate(viewer, (await context.params).id, await body(req)),
  );
export const DELETE = (req: NextRequest, context: Context) =>
  respondTemplates(req, async (viewer) =>
    deleteSavedTemplate(viewer, (await context.params).id, await body(req)),
  );
