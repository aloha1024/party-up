import { existsSync, mkdirSync, closeSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
// Prisma's Windows engine can fail to create a missing file in Unicode paths.
// Create only an empty missing file; never truncate an existing database.
if (existsSync(".env")) process.loadEnvFile(".env");
const url = process.env.DATABASE_URL;
if (!url?.startsWith("file:"))
  throw new Error("DATABASE_URL must be a SQLite file URL");
const path = resolve("prisma", url.slice(5).split("?")[0]);
mkdirSync(dirname(path), { recursive: true });
closeSync(openSync(path, "a"));
