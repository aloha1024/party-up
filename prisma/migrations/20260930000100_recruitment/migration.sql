ALTER TABLE "GameReservation" ADD COLUMN "registrationDeadline" DATETIME;
ALTER TABLE "GameReservation" ADD COLUMN "recruitmentPaused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ReservationChange" ADD COLUMN "registrationDeadlineBefore" DATETIME;
ALTER TABLE "ReservationChange" ADD COLUMN "registrationDeadlineAfter" DATETIME;
