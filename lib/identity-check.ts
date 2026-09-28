import {
  getClientIdentity,
  getClientIdentityRevision,
} from "./client-identity";
import { request } from "./client-request";
import { publicIdentitySchema } from "./user-account";

// One controller per Effect lifetime, separate from identity initialization.
export function createIdentityCheck({
  canCheck,
  invalidate,
}: {
  canCheck: () => boolean;
  invalidate: () => void;
}) {
  let disposed = false;
  let pending:
    | { scope: string | undefined; revision: number; promise: Promise<void> }
    | undefined;

  return {
    check(): Promise<void> {
      if (disposed || !canCheck()) return Promise.resolve();
      const scope = getClientIdentity()?.scope;
      const revision = getClientIdentityRevision();
      if (pending?.revision === revision && pending.scope === scope)
        return pending.promise;
      const entry = { scope, revision, promise: Promise.resolve() };
      pending = entry;
      const isCurrent = () =>
        !disposed &&
        pending === entry &&
        getClientIdentityRevision() === revision &&
        getClientIdentity()?.scope === scope;
      entry.promise = Promise.resolve()
        .then(async () => {
          const next = await request("/api/identity", "GET", undefined, {
            schema: publicIdentitySchema,
            isCurrent,
          });
          if (isCurrent() && next.scope !== scope) {
            disposed = true;
            invalidate();
          }
        })
        // Failed checks do not prove an identity change. Retry only on a new event.
        .catch(() => {})
        .finally(() => {
          if (pending === entry) pending = undefined;
        });
      return entry.promise;
    },
    dispose() {
      disposed = true;
      pending = undefined;
    },
  };
}
