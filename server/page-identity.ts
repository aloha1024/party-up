import { cache } from "react";
import { currentViewer } from "./http";

// React shares this promise only within a Server Component render. API and
// post-mutation reads continue to use the uncached currentViewer directly.
export const currentPageViewer = cache(currentViewer);

export async function pageIdentity() {
  const viewer = await currentPageViewer();
  return viewer.mode === "user" && viewer.user?.mustChangePassword
    ? undefined
    : viewer.token;
}
