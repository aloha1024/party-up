CREATE TABLE "UserReservationFavorite" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserReservationFavorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserReservationFavorite_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "GameReservation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "UserReservationFavorite_userId_reservationId_key" ON "UserReservationFavorite"("userId", "reservationId");
CREATE INDEX "UserReservationFavorite_userId_id_idx" ON "UserReservationFavorite"("userId", "id");
