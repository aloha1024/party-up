ALTER TABLE "GameReservation" ADD COLUMN "endedAt" DATETIME;
ALTER TABLE "Participant" ADD COLUMN "checkedInAt" DATETIME;
ALTER TABLE "Participant" ADD COLUMN "attendanceVersion" INTEGER NOT NULL DEFAULT 0;
