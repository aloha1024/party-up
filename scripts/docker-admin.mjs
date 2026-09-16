import { PrismaClient } from "@prisma/client";
import { initializeDockerAdmin } from "./docker-admin-bootstrap.mjs";

const db = new PrismaClient();
try {
  await initializeDockerAdmin({
    db,
    configPath: "/app/data/admin-bootstrap.json",
  });
} finally {
  await db.$disconnect();
}
