import { Prisma } from "@prisma/client";
import { db } from "./db";
import { measureTransaction } from "./request-metrics";
import { requireAdmin } from "./admin";
import { auditQuerySchema } from "../lib/admin-audit";
export async function listAdminAudit(input: unknown = {}) {
  await requireAdmin();
  const filters = auditQuerySchema.parse(input);
  const where: Prisma.AdminAuditLogWhereInput = {
    ...(filters.action === "all" ? {} : { action: filters.action }),
    ...(filters.q
      ? {
          OR: [
            { actorName: { contains: filters.q } },
            { targetLabel: { contains: filters.q } },
            { targetId: { contains: filters.q } },
          ],
        }
      : {}),
  };
  return measureTransaction(() =>
    db.$transaction(
      async (tx) => {
        const total = await tx.adminAuditLog.count({ where });
        const pageSize = 20;
        const pageCount = Math.max(1, Math.ceil(total / pageSize));
        const page = Math.min(filters.page, pageCount);
        const rows = await tx.adminAuditLog.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            actorId: true,
            actorName: true,
            action: true,
            targetType: true,
            targetId: true,
            targetLabel: true,
            createdAt: true,
          },
        });
        return {
          items: rows.map((row) => ({
            ...row,
            createdAt: row.createdAt.toISOString(),
          })),
          total,
          page,
          pageCount,
          pageSize,
          filters: { ...filters, page },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
