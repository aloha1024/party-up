CREATE TABLE "CalendarSubscription" (
  "userId" TEXT NOT NULL PRIMARY KEY,
  "tokenHash" TEXT,
  "userVersion" INTEGER NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "includeInvites" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "CalendarSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CalendarSubscription_tokenHash_key" ON "CalendarSubscription"("tokenHash");
