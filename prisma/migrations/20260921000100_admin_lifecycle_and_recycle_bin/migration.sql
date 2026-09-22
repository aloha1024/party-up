ALTER TABLE "AdminCredential" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "GameReservation" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "GameReservation" ADD COLUMN "cancellationReason" TEXT NOT NULL DEFAULT '';
CREATE INDEX "GameReservation_deletedAt_scheduledAt_idx" ON "GameReservation"("deletedAt", "scheduledAt");
