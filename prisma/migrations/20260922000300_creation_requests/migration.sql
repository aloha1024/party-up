CREATE TABLE "CreationRequest" (
"id" TEXT NOT NULL PRIMARY KEY, "ownerTokenHash" TEXT NOT NULL, "key" TEXT NOT NULL,
"inputHash" TEXT NOT NULL, "reservationId" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "CreationRequest_ownerTokenHash_key_key" ON "CreationRequest"("ownerTokenHash", "key");
CREATE UNIQUE INDEX "CreationRequest_reservationId_key" ON "CreationRequest"("reservationId");
