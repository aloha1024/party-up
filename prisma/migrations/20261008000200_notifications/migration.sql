CREATE TABLE "Notification" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "reservationId" TEXT NOT NULL,
    "recipientHash" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" DATETIME,
    CONSTRAINT "Notification_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "GameReservation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Notification_recipientHash_eventKey_key" ON "Notification"("recipientHash", "eventKey");
CREATE INDEX "Notification_recipientHash_id_idx" ON "Notification"("recipientHash", "id");
CREATE INDEX "Notification_recipientHash_readAt_id_idx" ON "Notification"("recipientHash", "readAt", "id");
CREATE INDEX "Notification_reservationId_idx" ON "Notification"("reservationId");
