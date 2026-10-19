-- Existing reservations and roster entries share version zero and remain confirmed.
ALTER TABLE "GameReservation" ADD COLUMN "scheduleVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Participant" ADD COLUMN "acceptedScheduleVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Participant" ADD COLUMN "scheduleConfirmedAt" DATETIME;
ALTER TABLE "WaitlistEntry" ADD COLUMN "acceptedScheduleVersion" INTEGER NOT NULL DEFAULT 0;
