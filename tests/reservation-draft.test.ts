import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  readDraft,
  saveDraft,
  clearDraft,
  draftMatchesVersion,
  draftMatchesSubmission,
  creationInputFromFields,
} from "../lib/reservation-draft";
import {
  submissionKey,
  readSubmission,
  clearSubmission,
} from "../lib/creation-submission";

function storage(t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(
    globalThis,
    "sessionStorage",
  );
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  });
  t.after(() => {
    clearSubmission();
    if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  });
  clearSubmission();
  return values;
}
const fields = {
  gameName: "Game",
  hostName: "Host",
  date: "2030-01-01",
  time: "20:00",
  maxPlayers: "5",
  description: "unsaved notes",
};
test("drafts preserve incomplete input, are scoped by reservation, and require the original editing version", (t) => {
  storage(t);
  assert.equal(saveDraft({ ...fields, date: "" }), true);
  saveDraft(fields, "one", 2);
  saveDraft({ ...fields, description: "another" }, "two", 4);
  assert.equal(readDraft()?.fields.date, "");
  const draft = readDraft("one")!;
  assert.deepEqual(draft.fields, fields);
  assert.equal(draftMatchesVersion(draft, 2), true);
  assert.equal(draftMatchesVersion(draft, 3), false);
  assert.equal(draftMatchesVersion(draft, undefined), false);
  clearDraft("one");
  assert.equal(readDraft("one"), undefined);
  assert.equal(readDraft("two")?.fields.description, "another");
  assert.equal(readDraft()?.fields.gameName, "Game");
});
test("corrupt drafts are ignored and unavailable storage reports failure without breaking typing", (t) => {
  const values = storage(t);
  values.set("party-reservation-draft:new", "invalid json");
  assert.equal(readDraft(), undefined);
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    get() {
      throw new Error("storage unavailable");
    },
  });
  assert.equal(saveDraft(fields), false);
  assert.equal(readDraft(), undefined);
  assert.doesNotThrow(() => clearDraft());
  const first = submissionKey(fields);
  assert.equal(submissionKey(fields), first);
  assert.throws(
    () => submissionKey({ ...fields, gameName: "other" }),
    /先查看上次创建结果/,
  );
});
test("a persisted pending submission keeps its key and cannot be replaced by changed content until explicitly cleared", (t) => {
  const values = storage(t);
  const key = "a".repeat(64);
  values.set(
    "party-creation",
    JSON.stringify({ payload: JSON.stringify(fields), key }),
  );
  assert.equal(submissionKey(fields), key);
  assert.equal(readSubmission()?.key, key);
  assert.throws(
    () => submissionKey({ ...fields, gameName: "Changed" }),
    /先查看上次创建结果/,
  );
  assert.equal(JSON.parse(values.get("party-creation")!).key, key);
  clearSubmission();
  assert.equal(values.has("party-creation"), false);
  assert.notEqual(submissionKey({ ...fields, gameName: "Changed" }), key);
});

test("confirming an earlier creation distinguishes its original draft from newer local edits even after the start time", () => {
  const expired = { ...fields, date: "2000-01-01" };
  const payload = JSON.stringify(creationInputFromFields(expired));
  assert.equal(draftMatchesSubmission(expired, payload), true);
  assert.equal(
    draftMatchesSubmission(
      { ...expired, description: "new unsaved changes" },
      payload,
    ),
    false,
  );
  assert.equal(
    draftMatchesSubmission({ ...expired, date: "" }, payload),
    false,
  );
});
