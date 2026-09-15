-- Old reservations have no trustworthy creator credential; leave ownership unset.
ALTER TABLE "GameReservation" ADD COLUMN "hostTokenHash" TEXT;
