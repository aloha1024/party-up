import { test } from "node:test";
import assert from "node:assert/strict";
import { reservationShareText } from "../lib/reservation-share";
import type { Reservation } from "../types/reservation";

const r: Reservation = {
  id: "reservation-test",
  gameName: "Valorant",
  hostName: "Alex",
  isHost: false,
  editVersion: 0,
  scheduledAt: "2030-01-01T12:00:00Z",
  maxPlayers: 2,
  description: "排位\n自带语音",
  status: "OPEN",
  participants: [
    {
      id: "internal-alex",
      name: "Alex#123",
      joinedAt: "2029-01-01T00:00:00Z",
      isMe: false,
    },
    {
      id: "internal-mike",
      name: "Mike",
      joinedAt: "2029-01-02T00:00:00Z",
      isMe: true,
    },
  ],
};
test("share text contains readable roster, time, notes, capacity and link without private identity fields", () => {
  const text = reservationShareText(
    r,
    "https://example.test/reservation/reservation-test",
    new Date("2029-12-01"),
  );
  for (const value of [
    "Valorant",
    "发起人：Alex",
    "2030/01/01 20:00",
    "北京时间 UTC+8",
    "2 / 2 人",
    "已满员",
    "排位\n自带语音",
    "1. Alex#123\n2. Mike",
    "https://example.test/reservation/reservation-test",
  ])
    assert.ok(text.includes(value), value);
  assert.equal(text.includes("internal-alex"), false);
  assert.equal(text.includes("isMe"), false);
});
test("share text handles empty notes and roster and recalculates started status", () => {
  const text = reservationShareText(
    { ...r, description: " ", participants: [] },
    "https://example.test/r",
    new Date("2031-01-01"),
  );
  for (const value of ["备注：无", "暂无报名", "0 / 2 人", "已开始"])
    assert.ok(text.includes(value));
});
