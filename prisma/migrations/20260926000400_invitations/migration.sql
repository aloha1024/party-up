ALTER TABLE "GameReservation" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'PUBLIC';
ALTER TABLE "GameReservation" ADD COLUMN "inviteVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "GameReservation" ADD COLUMN "inviteHash" TEXT;
ALTER TABLE "GameReservation" ADD COLUMN "inviteCipher" TEXT;
CREATE TABLE "ReservationAccess" (
 "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
 "reservationId" TEXT NOT NULL,
 "tokenHash" TEXT NOT NULL,
 "inviteVersion" INTEGER NOT NULL,
 "hasJoined" BOOLEAN NOT NULL DEFAULT false,
 CONSTRAINT "ReservationAccess_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "GameReservation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ReservationAccess_reservationId_tokenHash_key" ON "ReservationAccess"("reservationId", "tokenHash");
