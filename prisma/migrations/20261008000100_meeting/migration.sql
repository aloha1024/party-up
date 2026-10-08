ALTER TABLE "GameReservation" ADD COLUMN "platform" TEXT NOT NULL DEFAULT '';
ALTER TABLE "GameReservation" ADD COLUMN "gameServer" TEXT NOT NULL DEFAULT '';
ALTER TABLE "GameReservation" ADD COLUMN "meetingCipher" TEXT;
ALTER TABLE "GameReservation" ADD COLUMN "meetingVersion" INTEGER NOT NULL DEFAULT 0;
