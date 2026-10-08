import { z } from "zod";
import { creationInputSchema } from "./validation";

export const MAX_SAVED_TEMPLATES = 20;
export const savedTemplateIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const savedTemplateFieldsSchema = creationInputSchema
  .pick({
    visibility: true,
    gameName: true,
    hostName: true,
    maxPlayers: true,
    description: true,
    platform: true,
    gameServer: true,
  })
  .extend({
    name: z
      .string()
      .trim()
      .min(1, "请填写模板名称")
      .max(40, "模板名称最多 40 字"),
    platform: creationInputSchema.shape.platform.default(""),
    gameServer: creationInputSchema.shape.gameServer.default(""),
  })
  .strict();
export const savedTemplateVersionSchema = z
  .object({
    version: z.number().int().min(0).max(2147483646),
  })
  .strict();
export const savedTemplateUpdateSchema = savedTemplateFieldsSchema.extend(
  savedTemplateVersionSchema.shape,
);
export const savedTemplateSchema = savedTemplateFieldsSchema.extend({
  id: savedTemplateIdSchema,
  version: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const savedTemplateListSchema = z.object({
  items: z.array(savedTemplateSchema).max(MAX_SAVED_TEMPLATES),
  max: z.literal(MAX_SAVED_TEMPLATES),
});
export type SavedTemplateFields = z.infer<typeof savedTemplateFieldsSchema>;
export type SavedTemplate = z.infer<typeof savedTemplateSchema>;
