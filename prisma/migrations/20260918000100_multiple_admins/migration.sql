CREATE TABLE "new_AdminCredential" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "username" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
  "sessionVersion" INTEGER NOT NULL DEFAULT 0,
  "bootstrapFingerprint" TEXT NOT NULL DEFAULT '',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AdminCredential" ("id", "username", "passwordHash", "mustChangePassword", "sessionVersion", "bootstrapFingerprint", "createdAt", "updatedAt")
SELECT "id", "username", "passwordHash", "mustChangePassword", "sessionVersion", "bootstrapFingerprint", "createdAt", "updatedAt" FROM "AdminCredential";
DROP TABLE "AdminCredential";
ALTER TABLE "new_AdminCredential" RENAME TO "AdminCredential";
CREATE UNIQUE INDEX "AdminCredential_username_key" ON "AdminCredential"("username");
