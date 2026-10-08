import { Prisma } from "@prisma/client";
import { db } from "./db";
import { AppError } from "./errors";
import { lockUser, requireUser } from "./user-accounts";
import { viewerContext, type Viewer } from "./user-identity";
import { writeTransaction } from "./request-budget";
import { measureTransaction } from "./request-metrics";
import {
  MAX_SAVED_TEMPLATES,
  savedTemplateFieldsSchema,
  savedTemplateIdSchema,
  savedTemplateUpdateSchema,
  savedTemplateVersionSchema,
  type SavedTemplate,
} from "../lib/saved-template";

const select = {
  id: true,
  name: true,
  visibility: true,
  gameName: true,
  hostName: true,
  maxPlayers: true,
  description: true,
  platform: true,
  gameServer: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserReservationTemplateSelect;
type Row = Prisma.UserReservationTemplateGetPayload<{ select: typeof select }>;
function present(row: Row): SavedTemplate {
  return {
    ...row,
    visibility: row.visibility as "PUBLIC" | "INVITE",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
const missing = () =>
  new AppError("NOT_FOUND", "模板不存在或不属于当前账号", 404);
const conflict = () =>
  new AppError(
    "TEMPLATE_CONFLICT",
    "模板已变化，请刷新列表后重新确认；当前输入尚未保存",
    409,
  );

async function read<T>(
  viewer: Viewer,
  run: (tx: Prisma.TransactionClient, userId: string) => Promise<T>,
) {
  const user = requireUser(viewer);
  return measureTransaction(() =>
    db.$transaction(
      async (tx) => {
        const session = await tx.userSession.findFirst({
          where: {
            id: viewer.sessionHash,
            userId: user.id,
            version: viewer.version,
            expiresAt: { gt: new Date() },
            user: {
              isActive: true,
              mustChangePassword: false,
              version: viewer.version,
            },
          },
          select: { id: true },
        });
        if (!session)
          throw new AppError(
            "USER_SESSION",
            "登录或账号状态已变化，请重新登录",
            401,
          );
        return run(tx, user.id);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
async function write<T>(
  viewer: Viewer,
  run: (tx: Prisma.TransactionClient, userId: string) => Promise<T>,
) {
  requireUser(viewer);
  return viewerContext.run(viewer, () =>
    writeTransaction(async (tx) => {
      const user = await lockUser(tx, viewer);
      return run(tx, user.id);
    }),
  );
}

export function listSavedTemplates(viewer: Viewer) {
  return read(viewer, async (tx, userId) => ({
    items: (
      await tx.userReservationTemplate.findMany({
        where: { userId },
        select,
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        take: MAX_SAVED_TEMPLATES,
      })
    ).map(present),
    max: MAX_SAVED_TEMPLATES,
  }));
}
export function getSavedTemplate(viewer: Viewer, input: unknown) {
  return read(viewer, async (tx, userId) => {
    const id = savedTemplateIdSchema.parse(input);
    const row = await tx.userReservationTemplate.findFirst({
      where: { id, userId },
      select,
    });
    if (!row) throw missing();
    return present(row);
  });
}
export function createSavedTemplate(viewer: Viewer, input: unknown) {
  return write(viewer, async (tx, userId) => {
    const data = savedTemplateFieldsSchema.parse(input);
    if (
      (await tx.userReservationTemplate.count({ where: { userId } })) >=
      MAX_SAVED_TEMPLATES
    )
      throw new AppError(
        "TEMPLATE_LIMIT",
        "最多保存 20 个模板，请先删除不再使用的模板",
        409,
      );
    return present(
      await tx.userReservationTemplate.create({
        data: { ...data, userId },
        select,
      }),
    );
  });
}
export function updateSavedTemplate(
  viewer: Viewer,
  inputId: unknown,
  input: unknown,
) {
  return write(viewer, async (tx, userId) => {
    const id = savedTemplateIdSchema.parse(inputId);
    const { version, ...data } = savedTemplateUpdateSchema.parse(input);
    const row = await tx.userReservationTemplate.findFirst({
      where: { id, userId },
      select: { version: true },
    });
    if (!row) throw missing();
    if (row.version !== version) throw conflict();
    const changed = await tx.userReservationTemplate.updateMany({
      where: { id, userId, version },
      data: { ...data, version: { increment: 1 } },
    });
    if (!changed.count) throw conflict();
    return present(
      await tx.userReservationTemplate.findFirstOrThrow({
        where: { id, userId },
        select,
      }),
    );
  });
}
export function deleteSavedTemplate(
  viewer: Viewer,
  inputId: unknown,
  input: unknown,
) {
  return write(viewer, async (tx, userId) => {
    const id = savedTemplateIdSchema.parse(inputId);
    const { version } = savedTemplateVersionSchema.parse(input);
    const row = await tx.userReservationTemplate.findFirst({
      where: { id, userId },
      select: { version: true },
    });
    if (!row) throw missing();
    if (row.version !== version) throw conflict();
    const deleted = await tx.userReservationTemplate.deleteMany({
      where: { id, userId, version },
    });
    if (!deleted.count) throw conflict();
    return { deleted: true as const };
  });
}
