-- CreateTable
CREATE TABLE "GameReservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gameName" TEXT NOT NULL,
    "hostName" TEXT NOT NULL,
    "scheduledAt" DATETIME NOT NULL,
    "maxPlayers" INTEGER NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Participant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reservationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Participant_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "GameReservation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "GameReservation_scheduledAt_idx" ON "GameReservation"("scheduledAt");

-- CreateIndex
CREATE INDEX "Participant_reservationId_joinedAt_idx" ON "Participant"("reservationId", "joinedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Participant_reservationId_nameKey_key" ON "Participant"("reservationId", "nameKey");

-- CreateIndex
CREATE UNIQUE INDEX "Participant_reservationId_tokenHash_key" ON "Participant"("reservationId", "tokenHash");
