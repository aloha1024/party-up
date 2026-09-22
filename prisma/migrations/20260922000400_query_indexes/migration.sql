DROP INDEX "GameReservation_deletedAt_scheduledAt_idx";
CREATE INDEX "GameReservation_deletedAt_scheduledAt_id_idx" ON "GameReservation"("deletedAt", "scheduledAt", "id");
CREATE INDEX "GameReservation_deletedAt_id_idx" ON "GameReservation"("deletedAt" DESC, "id" ASC);
DROP INDEX "AdminAuditLog_action_createdAt_idx";
CREATE INDEX "AdminAuditLog_action_createdAt_id_idx" ON "AdminAuditLog"("action", "createdAt" DESC, "id" DESC);
