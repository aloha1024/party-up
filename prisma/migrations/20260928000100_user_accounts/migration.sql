CREATE TABLE "User" (
 "id" TEXT NOT NULL PRIMARY KEY, "username" TEXT NOT NULL, "nickname" TEXT NOT NULL,
 "passwordHash" TEXT NOT NULL, "identityKey" TEXT NOT NULL, "recoveryHash" TEXT,
 "isActive" BOOLEAN NOT NULL DEFAULT true, "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
 "version" INTEGER NOT NULL DEFAULT 0, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE UNIQUE INDEX "User_identityKey_key" ON "User"("identityKey");
CREATE TABLE "UserSession" (
 "id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "version" INTEGER NOT NULL,
 "expiresAt" DATETIME NOT NULL,
 FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "UserSession_userId_idx" ON "UserSession"("userId");
CREATE INDEX "UserSession_expiresAt_idx" ON "UserSession"("expiresAt");
CREATE TABLE "GuestIdentity" ("hash" TEXT NOT NULL PRIMARY KEY, "version" INTEGER NOT NULL DEFAULT 0, "retired" BOOLEAN NOT NULL DEFAULT false);
CREATE TABLE "GuestClaim" (
 "id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "guestHash" TEXT NOT NULL,
 "key" TEXT NOT NULL, "inputHash" TEXT NOT NULL, "result" TEXT NOT NULL,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GuestClaim_userId_key_key" ON "GuestClaim"("userId", "key");
CREATE INDEX "GuestClaim_guestHash_idx" ON "GuestClaim"("guestHash");
