CREATE TABLE "ReservationChange" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "reservationId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "fields" TEXT NOT NULL,
    "scheduledAtBefore" DATETIME,
    "scheduledAtAfter" DATETIME,
    "maxPlayersBefore" INTEGER,
    "maxPlayersAfter" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReservationChange_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "GameReservation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ReservationChange_reservationId_id_idx" ON "ReservationChange"("reservationId", "id");
