CREATE TABLE "RosterRemoval" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "reservationId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "entryId" TEXT NOT NULL,
  "targetTokenHash" TEXT NOT NULL,
  "targetName" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "actorRole" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RosterRemoval_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "GameReservation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RosterRemoval_reservationId_kind_entryId_key" ON "RosterRemoval"("reservationId", "kind", "entryId");
CREATE INDEX "RosterRemoval_reservationId_id_idx" ON "RosterRemoval"("reservationId", "id");
CREATE INDEX "RosterRemoval_reservationId_targetTokenHash_id_idx" ON "RosterRemoval"("reservationId", "targetTokenHash", "id");
