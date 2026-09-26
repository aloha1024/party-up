CREATE TABLE "WaitlistEntry" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "reservationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WaitlistEntry_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "GameReservation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WaitlistEntry_reservationId_nameKey_key" ON "WaitlistEntry"("reservationId", "nameKey");
CREATE UNIQUE INDEX "WaitlistEntry_reservationId_tokenHash_key" ON "WaitlistEntry"("reservationId", "tokenHash");
CREATE INDEX "WaitlistEntry_reservationId_id_idx" ON "WaitlistEntry"("reservationId", "id");
