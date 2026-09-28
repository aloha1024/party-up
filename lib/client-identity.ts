import type { PublicIdentity } from "./user-account";
let current: PublicIdentity | undefined;
let revision = 0;
export const identityEventSource = `${Date.now()}:${Math.random()}`;
export function newClaimKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const getClientIdentity = () => current;
// Local lifetime marker only; never sent to the server or persisted.
export const getClientIdentityRevision = () => revision;
export function bindLegacyGuest(storageKey: string) {
  try {
    const owner = sessionStorage.getItem("party-legacy-guest");
    if (!owner && storageKey)
      sessionStorage.setItem("party-legacy-guest", storageKey);
    return !owner || owner === storageKey;
  } catch {
    return false;
  }
}
function legacyOwner() {
  try {
    return sessionStorage.getItem("party-legacy-guest");
  } catch {
    return null;
  }
}
export function setClientIdentity(value: PublicIdentity) {
  if (value.mode === "guest") {
    bindLegacyGuest(value.storageKey);
    // A fresh guest may have typed before the cookie handshake. Bind that draft
    // to the new identity without reusing an older guest's legacy storage.
    if (current?.mode === "anonymous") {
      try {
        for (const key of Object.keys(sessionStorage)) {
          if (
            !key.startsWith("party-reservation-draft:") ||
            !key.endsWith(":identity:anonymous")
          )
            continue;
          const target = key.replace(
            /:identity:anonymous$/,
            `:identity:${value.storageKey}`,
          );
          if (!sessionStorage.getItem(target)) {
            sessionStorage.setItem(target, sessionStorage.getItem(key)!);
            sessionStorage.removeItem(key);
          }
        }
      } catch {}
    }
  }
  if (current?.scope !== value.scope) revision++;
  current = value;
}
export function scopedStorageKey(base: string) {
  return current && (current.mode !== "anonymous" || !!legacyOwner())
    ? `${base}:identity:${current.storageKey}`
    : base;
}
export function legacyStorageAllowed() {
  if (current && current.mode !== "guest" && current.mode !== "anonymous")
    return false;
  const owner = legacyOwner();
  return !owner || owner === current?.storageKey;
}
export function notifyIdentityChanged() {
  try {
    const channel = new BroadcastChannel("party-identity");
    channel.postMessage({ source: identityEventSource });
    channel.close();
  } catch {}
  try {
    localStorage.setItem(
      "party-identity-event",
      `${Date.now()}:${Math.random()}`,
    );
  } catch {}
}
export function rejectStaleIdentity() {
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event("party-identity-stale"));
}
