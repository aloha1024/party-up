import { PrismaClient } from "@prisma/client";
import { databaseUrl } from "./database-config";
const globalDb = globalThis as unknown as { prisma?: PrismaClient };
export const db =
  globalDb.prisma ??
  new PrismaClient({ datasourceUrl: databaseUrl(process.env.DATABASE_URL) });
if (process.env.NODE_ENV !== "production") globalDb.prisma = db;
