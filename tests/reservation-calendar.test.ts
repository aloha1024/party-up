import "./support/isolated";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { db } from "../server/db";
import { calendarReservation } from "../server/reservation-calendar";
import {
  reservationCalendar,
  type CalendarReservation,
} from "../lib/reservation-calendar";
import {
  createReservation,
  joinReservation,
  joinWaitlist,
  leaveReservation,
  cancelReservation,
  deleteReservation,
  editReservation,
} from "../server/reservations";
import { ADMIN_COOKIE, createAdminSession } from "../server/admin-auth";
const token = () => randomBytes(32).toString("hex");
const ids: string[] = [];
const actor = { id: 2, username: "calendar-admin" };
const input = () => ({
  gameName: "日历游戏",
  hostName: "Host",
  maxPlayers: 2,
  description: "备注",
  scheduledAt: new Date(Date.now() + 86400000).toISOString(),
});
after(async () => {
  await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});

test("calendar requires current formal membership including a promoted waiter; lifecycle disables export", async () => {
  const host = token(),
    guest = token(),
    waiter = token();
  const data = input();
  const r = await createReservation(data, host);
  ids.push(r.id);
  const calendar = await calendarReservation(r.id, host);
  assert.deepEqual(Object.keys(calendar).sort(), [
    "description",
    "editVersion",
    "gameName",
    "hostName",
    "id",
    "scheduledAt",
    "updatedAt",
  ]);
  for (const value of [undefined, "invalid"])
    await assert.rejects(calendarReservation(r.id, value), {
      code: "IDENTITY_REQUIRED",
    });
  await assert.rejects(calendarReservation(r.id, waiter), {
    code: "FORBIDDEN",
  });
  await joinReservation(r.id, { name: "Guest" }, guest);
  await joinWaitlist(r.id, { name: "Waiter" }, waiter);
  await assert.rejects(calendarReservation(r.id, waiter), {
    code: "FORBIDDEN",
  });
  await leaveReservation(r.id, host);
  await assert.rejects(calendarReservation(r.id, host), { code: "FORBIDDEN" });
  assert.equal((await calendarReservation(r.id, waiter)).id, r.id);
  await editReservation(
    r.id,
    { ...data, gameName: "最新游戏", editVersion: 0 },
    host,
  );
  assert.equal((await calendarReservation(r.id, guest)).gameName, "最新游戏");
  await cancelReservation(r.id, { reason: "取消" }, host);
  await assert.rejects(calendarReservation(r.id, guest), { code: "CANCELLED" });
  await deleteReservation(r.id, actor);
  await assert.rejects(calendarReservation(r.id, guest), { code: "NOT_FOUND" });
  await assert.rejects(calendarReservation("missing", guest), {
    code: "NOT_FOUND",
  });
});

test("calendar rejects the exact start boundary", async (t) => {
  const host = token();
  const r = await createReservation(input(), host);
  ids.push(r.id);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(r.scheduledAt) });
  try {
    await assert.rejects(calendarReservation(r.id, host), { code: "STARTED" });
  } finally {
    t.mock.timers.reset();
  }
});

const fixture: CalendarReservation = {
  id: "calendar-fixture",
  gameName: "游戏🎮".repeat(20),
  hostName: "队长",
  description: "逗号,分号;反斜杠\\换行\r\nBEGIN:VEVENT\r\nATTENDEE:evil\u0000",
  scheduledAt: "2030-01-01T16:00:00.000Z",
  updatedAt: "2029-12-01T00:00:00.000Z",
  editVersion: 2,
};
test("iCalendar is UTF-8 folded, injection-safe, UTC, stable and contains one point event with a display alarm", () => {
  const file = reservationCalendar(
    fixture,
    "https://user:pass@example.test:8443/ignored?q=private",
  );
  assert.ok(file.endsWith("\r\n"));
  for (const line of file.split("\r\n"))
    assert.ok(Buffer.byteLength(line) <= 75);
  assert.equal(Buffer.from(file).toString("utf8"), file);
  const unfolded = file.replace(/\r\n[ \t]/g, "");
  const lines = unfolded.split("\r\n");
  assert.equal(lines.filter((line) => line === "BEGIN:VEVENT").length, 1);
  assert.equal(lines.filter((line) => line.startsWith("ATTENDEE:")).length, 0);
  assert.ok(lines.includes("DTSTART:20300101T160000Z"));
  assert.ok(lines.includes("DTSTAMP:20291201T000000Z"));
  assert.ok(lines.includes("SEQUENCE:2"));
  assert.ok(lines.includes("UID:calendar-fixture@party-up"));
  assert.ok(lines.includes("TRIGGER:-PT15M"));
  assert.ok(lines.includes("ACTION:DISPLAY"));
  assert.ok(
    lines.includes(
      "URL:https://example.test:8443/reservation/calendar-fixture",
    ),
  );
  assert.ok(unfolded.includes("逗号\\,分号\\;反斜杠\\\\换行\\nBEGIN:VEVENT"));
  for (const excluded of [
    "DTEND:",
    "DURATION:",
    "ATTACH:",
    "Cookie",
    "user:pass",
    "q=private",
    "\u0000",
  ])
    assert.equal(file.includes(excluded), false);
  assert.equal(reservationCalendar(fixture, "https://example.test:8443"), file);
  assert.throws(() =>
    reservationCalendar(
      { ...fixture, scheduledAt: "invalid" },
      "https://example.test",
    ),
  );
  assert.throws(() => reservationCalendar(fixture, "javascript:alert(1)"));
});

test(
  "HTTP calendar has private no-store responses, never creates identity, and ignores URL or admin identity overrides",
  { skip: !process.env.TEST_BASE_URL },
  async () => {
    const base = process.env.TEST_BASE_URL!,
      owner = token(),
      other = token();
    const r = await createReservation(input(), owner);
    ids.push(r.id);
    const url = `${base}/api/reservations/${r.id}/calendar`;
    for (const [cookie, expected] of [
      ["", 428],
      ["party_identity=invalid", 428],
      [`party_identity=${other}`, 403],
      [`${ADMIN_COOKIE}=${createAdminSession(1, 0)}`, 428],
      [`party_identity=${owner}`, 200],
    ] as const) {
      const response = await fetch(url + `?token=${owner}`, {
        headers: { Cookie: cookie },
      });
      assert.equal(response.status, expected);
      assert.match(response.headers.get("cache-control") || "", /no-store/);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.ok(response.headers.get("x-request-id"));
      const text = await response.text();
      assert.equal(text.includes(owner), false);
      assert.equal(text.includes("tokenHash"), false);
      assert.equal(text.includes("participants"), false);
      assert.equal(text.includes("waitlist"), false);
      if (expected === 200) assert.equal(JSON.parse(text).data.id, r.id);
    }
    await leaveReservation(r.id, owner);
    assert.equal(
      (await fetch(url, { headers: { Cookie: `party_identity=${owner}` } }))
        .status,
      403,
    );
  },
);
