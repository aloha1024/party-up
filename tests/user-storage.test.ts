import { test } from "node:test";
import assert from "node:assert/strict";
import { setClientIdentity, newClaimKey } from "../lib/client-identity";
import { readDraft, saveDraft, clearDraft } from "../lib/reservation-draft";
import {
  submissionKey,
  readSubmission,
  clearSubmission,
} from "../lib/creation-submission";
import { safeReturnPath, type PublicIdentity } from "../lib/user-account";

test("guest legacy drafts and pending creation keys remain separate from accounts", () => {
  const entries = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => entries.get(k) ?? null,
      setItem: (k: string, v: string) => entries.set(k, v),
      removeItem: (k: string) => entries.delete(k),
    },
  });
  const viewer = (
    mode: "guest" | "user",
    storageKey: string,
  ): PublicIdentity => ({
    mode,
    storageKey,
    scope: storageKey,
    ready: true,
    user: null,
    capabilities: {
      createInvitation: mode === "user",
      copyReservation: mode === "user",
      calendar: mode === "user",
    },
  });
  const fields = {
    gameName: "Legacy guest",
    hostName: "Guest",
    date: "2026-10-01",
    time: "20:00",
    maxPlayers: "4",
    description: "",
  };
  entries.set(
    "party-reservation-draft:new",
    JSON.stringify({ version: 1, fields }),
  );
  entries.set(
    "party-creation",
    JSON.stringify({
      key: "a".repeat(64),
      payload: JSON.stringify({ old: true }),
    }),
  );
  try {
    setClientIdentity(viewer("user", "one"));
    assert.equal(readDraft(), undefined);
    assert.equal(readSubmission(), undefined);
    saveDraft({ ...fields, gameName: "Account one" });
    const first = submissionKey({ account: 1 });
    setClientIdentity(viewer("user", "two"));
    assert.equal(readDraft(), undefined);
    assert.equal(readSubmission(), undefined);
    const second = submissionKey({ account: 2 });
    assert.notEqual(first, second);
    setClientIdentity(viewer("guest", "old"));
    assert.equal(readDraft()!.fields.gameName, "Legacy guest");
    assert.equal(readSubmission()!.key, "a".repeat(64));
    assert.equal(entries.has("party-creation"), false);
    assert.throws(() => submissionKey({ changed: true }), /结果尚未确认/);
    clearDraft();
    clearSubmission();
    setClientIdentity(viewer("user", "one"));
    assert.equal(readDraft()!.fields.gameName, "Account one");
    assert.equal(submissionKey({ account: 1 }), first);
    // Leftover legacy drafts remain owned by the first guest after full linking
    // or cookie replacement, rather than becoming a later guest's draft.
    entries.set(
      "party-reservation-draft:new",
      JSON.stringify({ version: 1, fields }),
    );
    entries.set(
      "party-creation",
      JSON.stringify({ key: "b".repeat(64), payload: "{}" }),
    );
    setClientIdentity(viewer("guest", "new-guest"));
    assert.equal(readDraft(), undefined);
    assert.equal(readSubmission(), undefined);
    assert.equal(entries.has("party-reservation-draft:new"), true);
    assert.match(
      newClaimKey(),
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
  } finally {
    Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

test("account redirects reject external, duplicate and malformed destinations", () => {
  for (const path of [
    "https://example.org",
    "//example.org",
    "/\\example.org",
    ["/", "/account"],
    "/account/login",
    "/\nexample.org",
  ])
    assert.equal(safeReturnPath(path), "/my-reservations");
  assert.equal(safeReturnPath("/reservation/abc?q=1"), "/reservation/abc?q=1");
});
