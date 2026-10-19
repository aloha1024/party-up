import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  creationInputFromFields,
  type ReservationFields,
} from "../lib/reservation-draft";
import {
  reservationFieldLabels,
  validateReservationForm,
} from "../lib/reservation-form-validation";
import { createSchema, creationFingerprint } from "../lib/validation";

const now = Date.parse("2030-05-01T10:00:00.000Z");
const fields: ReservationFields = {
  visibility: "PUBLIC",
  gameName: "Game",
  platform: "PC",
  gameServer: "Asia",
  date: "2030-05-02",
  time: "20:00",
  deadline: "",
  hostName: "Host",
  maxPlayers: "5",
  description: "Notes",
};

function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now });
}

test("form validation reports all invalid controls without depending on issue order", (t) => {
  clock(t);
  const invalid = {
    ...fields,
    visibility: "OTHER",
    gameName: " ",
    platform: "p".repeat(81),
    gameServer: "s".repeat(81),
    date: "",
    time: "",
    deadline: "not-a-time",
    hostName: "　",
    maxPlayers: "1.5",
    description: "d".repeat(1001),
  } as unknown as ReservationFields;
  const { parsed, fieldErrors } = validateReservationForm(invalid);
  assert.equal(parsed.success, false);
  assert.deepEqual(
    Object.keys(fieldErrors).sort(),
    Object.keys(reservationFieldLabels).sort(),
  );
  for (const message of Object.values(fieldErrors)) {
    assert.equal(typeof message, "string");
    assert.ok(message.length > 0);
  }
  assert.equal(fieldErrors.date, "请选择预约日期");
  assert.equal(fieldErrors.time, "请选择开玩时间");
  assert.equal(fieldErrors.deadline, "请选择有效的报名截止时间");
  assert.equal(fieldErrors.maxPlayers, "请输入有效的整数人数");
});

test("missing or invalid date and time point to their controls; past combinations identify both", (t) => {
  clock(t);
  assert.deepEqual(
    validateReservationForm({ ...fields, date: "" }).fieldErrors,
    { date: "请选择预约日期" },
  );
  assert.deepEqual(
    validateReservationForm({ ...fields, time: "" }).fieldErrors,
    { time: "请选择开玩时间" },
  );
  assert.deepEqual(
    validateReservationForm({ ...fields, date: "invalid" }).fieldErrors,
    { date: "请选择有效的预约日期" },
  );
  for (const time of ["17:59", "18:00"]) {
    const result = validateReservationForm({
      ...fields,
      date: "2030-05-01",
      time,
    });
    assert.equal(result.parsed.success, false);
    assert.deepEqual(result.fieldErrors, {
      date: "预约时间必须是未来时间",
      time: "预约时间必须是未来时间",
    });
  }
  const future = validateReservationForm({
    ...fields,
    date: "2030-05-01",
    time: "18:01",
  });
  assert.equal(future.parsed.success, true);
  assert.deepEqual(future.fieldErrors, {});
});

test("malformed draft dates and times cannot bypass native input constraints through Date normalization", (t) => {
  clock(t);
  for (const date of [
    "2031-02-29",
    "2032-02-30",
    "2031-04-31",
    "2030-13-01",
    "2030-1-1",
    "0000-01-01",
  ]) {
    assert.deepEqual(validateReservationForm({ ...fields, date }).fieldErrors, {
      date: "请选择有效的预约日期",
    });
  }
  assert.deepEqual(
    validateReservationForm({ ...fields, date: "2032-02-29" }).fieldErrors,
    {},
  );
  for (const time of ["24:00", "20:60", "8:00", "20:00:30"]) {
    assert.deepEqual(validateReservationForm({ ...fields, time }).fieldErrors, {
      time: "请选择有效的开玩时间",
    });
  }
  for (const deadline of [
    "2030-02-31T19:00",
    "2030-05-02T24:00",
    "2030-05-02T19:00:60",
    "2030-05-02T19:00:30.500",
  ]) {
    assert.deepEqual(
      validateReservationForm({ ...fields, deadline }).fieldErrors,
      {
        deadline: "请选择有效的报名截止时间",
      },
    );
  }
});

test("deadline errors remain local to the cutoff and enforce the existing time boundaries", (t) => {
  clock(t);
  for (const deadline of ["", "2030-05-02T19:00", "2030-05-02T20:00"]) {
    const result = validateReservationForm({ ...fields, deadline });
    assert.equal(result.parsed.success, true);
    assert.deepEqual(result.fieldErrors, {});
  }
  assert.deepEqual(
    validateReservationForm({ ...fields, deadline: "2030-05-02T20:01" })
      .fieldErrors,
    { deadline: "报名截止时间不能晚于开玩时间" },
  );
  for (const deadline of ["2030-05-01T17:59", "2030-05-01T18:00"]) {
    const result = validateReservationForm({ ...fields, deadline });
    assert.equal(result.parsed.success, true);
    assert.deepEqual(result.fieldErrors, {
      deadline: "报名截止时间必须是未来时间",
    });
  }
  assert.deepEqual(
    validateReservationForm({ ...fields, deadline: "invalid" }).fieldErrors,
    { deadline: "请选择有效的报名截止时间" },
  );
});

test("editing can retain an expired cutoff but cannot replace it with another expired value", (t) => {
  clock(t);
  const original = {
    scheduledAt: "2030-05-02T12:00:00.000Z",
    registrationDeadline: "2030-05-01T09:59:59.123Z",
    participants: [{}],
  };
  const unchanged = validateReservationForm(
    { ...fields, deadline: "2030-05-01T17:59:59" },
    original,
  );
  assert.equal(unchanged.parsed.success, true);
  assert.deepEqual(unchanged.fieldErrors, {});
  if (!unchanged.parsed.success) assert.fail("Expected valid unchanged cutoff");
  assert.equal(
    unchanged.parsed.data.registrationDeadline,
    original.registrationDeadline,
  );
  assert.deepEqual(
    validateReservationForm(
      { ...fields, deadline: "2030-05-01T17:59:58" },
      original,
    ).fieldErrors,
    { deadline: "报名截止时间必须是未来时间" },
  );
  assert.deepEqual(
    validateReservationForm({ ...fields, deadline: "" }, original).fieldErrors,
    {},
  );
});

test("capacity handles empty, non-integer, range and current-roster errors without relying on native validation", (t) => {
  clock(t);
  for (const maxPlayers of ["", " "]) {
    assert.deepEqual(
      validateReservationForm({ ...fields, maxPlayers }).fieldErrors,
      { maxPlayers: "请填写最大参与人数" },
    );
  }
  for (const maxPlayers of [
    "2.5",
    "NaN",
    "Infinity",
    "invalid",
    "0x5",
    "0b10",
    " 3",
    "+3",
  ]) {
    assert.deepEqual(
      validateReservationForm({ ...fields, maxPlayers }).fieldErrors,
      { maxPlayers: "请输入有效的整数人数" },
    );
  }
  for (const maxPlayers of ["-1", "0", "1"]) {
    assert.deepEqual(
      validateReservationForm({ ...fields, maxPlayers }).fieldErrors,
      { maxPlayers: "人数至少为 2" },
    );
  }
  assert.deepEqual(
    validateReservationForm({ ...fields, maxPlayers: "101" }).fieldErrors,
    { maxPlayers: "人数最多为 100" },
  );
  for (const maxPlayers of ["2", "100", "2.0", "2e0", "1e2"]) {
    const result = validateReservationForm({ ...fields, maxPlayers });
    assert.equal(result.parsed.success, true);
    assert.deepEqual(result.fieldErrors, {});
  }
  const original = {
    scheduledAt: "2030-05-02T12:00:00.000Z",
    participants: [{}, {}, {}],
  };
  const tooSmall = validateReservationForm(
    { ...fields, maxPlayers: "2" },
    original,
  );
  assert.equal(tooSmall.parsed.success, true);
  assert.deepEqual(tooSmall.fieldErrors, {
    maxPlayers: "人数上限不能小于当前报名人数",
  });
  assert.deepEqual(
    validateReservationForm({ ...fields, maxPlayers: "3" }, original)
      .fieldErrors,
    {},
  );
});

test("nickname normalization still uses the request schema and validates the expanded result", (t) => {
  clock(t);
  const originalFields = { ...fields, hostName: "  Ａ　Ｂ  " };
  const result = validateReservationForm(originalFields);
  assert.equal(result.parsed.success, true);
  assert.deepEqual(result.fieldErrors, {});
  if (!result.parsed.success) assert.fail("Expected a valid normalized name");
  assert.equal(result.parsed.data.hostName, "A B");
  assert.equal(originalFields.hostName, "  Ａ　Ｂ  ");
  assert.deepEqual(
    validateReservationForm({ ...fields, hostName: "㍿".repeat(7) })
      .fieldErrors,
    { hostName: "最多 24 个字符" },
  );
});

test("unchanged API timestamps keep seconds and milliseconds without moving a cutoff equal to the start", (t) => {
  clock(t);
  const timestamp = "2030-05-02T12:00:37.456Z";
  const original = {
    scheduledAt: timestamp,
    registrationDeadline: timestamp,
    participants: [{}],
  };
  const result = validateReservationForm(
    { ...fields, deadline: "2030-05-02T20:00:37" },
    original,
  );
  assert.equal(result.parsed.success, true);
  assert.deepEqual(result.fieldErrors, {});
  if (!result.parsed.success) assert.fail("Expected preserved timestamps");
  assert.equal(result.parsed.data.scheduledAt, timestamp);
  assert.equal(result.parsed.data.registrationDeadline, timestamp);
  assert.deepEqual(
    validateReservationForm(
      { ...fields, time: "19:00", deadline: "2030-05-02T20:00:37" },
      original,
    ).fieldErrors,
    { deadline: "报名截止时间不能晚于开玩时间" },
  );
});

test("successful validation preserves the existing normalized payload and fingerprint without mutating fields", (t) => {
  clock(t);
  const original = Object.freeze({
    scheduledAt: "2030-05-02T12:00:00.000Z",
    registrationDeadline: null,
    participants: Object.freeze([{}]),
  });
  for (const visibility of ["PUBLIC", "INVITE"] as const) {
    for (const deadline of [undefined, "", "2030-05-02T19:00:00"]) {
      const immutableFields = Object.freeze({
        ...fields,
        visibility,
        deadline,
        gameName: "  Game  ",
        hostName: "  Ｈost  ",
        platform: "  PC  ",
        gameServer: "  Asia  ",
        description: "  Notes  ",
      });
      const before = JSON.stringify({ immutableFields, original });
      const expected = createSchema.parse(
        creationInputFromFields(immutableFields, original),
      );
      const result = validateReservationForm(immutableFields, original);
      assert.equal(result.parsed.success, true);
      assert.deepEqual(result.fieldErrors, {});
      if (!result.parsed.success) assert.fail("Expected valid fields");
      assert.deepEqual(result.parsed.data, expected);
      assert.equal(
        creationFingerprint(result.parsed.data),
        creationFingerprint(expected),
      );
      assert.equal(JSON.stringify({ immutableFields, original }), before);
    }
  }
});
