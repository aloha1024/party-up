CREATE TABLE "UserReservationTemplate" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "visibility" TEXT NOT NULL DEFAULT 'PUBLIC',
  "gameName" TEXT NOT NULL,
  "hostName" TEXT NOT NULL,
  "maxPlayers" INTEGER NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "platform" TEXT NOT NULL DEFAULT '',
  "gameServer" TEXT NOT NULL DEFAULT '',
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "UserReservationTemplate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "UserReservationTemplate_userId_updatedAt_id_idx" ON "UserReservationTemplate"("userId", "updatedAt", "id");
