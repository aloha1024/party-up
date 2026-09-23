// IndexedDB serializes readwrite transactions across tabs, including on HTTP.
// Store no identity token: this database is only a mutex for the HttpOnly cookie handshake.
export async function withIdentityLock(
  operation: () => Promise<void>,
): Promise<void> {
  if (navigator.locks) {
    await navigator.locks.request("party-identity", operation);
    return;
  }
  return new Promise((resolve, reject) => {
    let database: IDBDatabase | undefined;
    let transaction: IDBTransaction | undefined;
    let settled = false;
    let finished = false;
    let started = false;
    let failure: unknown;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      database?.close();
      if (error) reject(error);
      else resolve();
    };
    const unavailable = () =>
      new Error("浏览器无法协调报名身份，请允许本站存储或使用 HTTPS 后重试");
    const timer = setTimeout(() => {
      finish(new Error("正在等待其他标签页初始化身份，请稍后重试"));
      try {
        transaction?.abort();
      } catch {}
    }, 60000);
    try {
      const opening = indexedDB.open("party-identity-lock", 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore("mutex");
      opening.onerror = () => finish(unavailable());
      opening.onblocked = () => finish(unavailable());
      opening.onsuccess = () => {
        database = opening.result;
        if (settled) {
          database.close();
          return;
        }
        database.onversionchange = () => {
          database?.close();
        };
        try {
          transaction = database.transaction("mutex", "readwrite");
          transaction.onabort = () => finish(failure || unavailable());
          transaction.onerror = () => finish(failure || unavailable());
          transaction.oncomplete = () => finish(failure);
          const store = transaction.objectStore("mutex");
          // IDB transactions auto-commit when idle. Queue one request at a time
          // until the network handshake finishes; the next tab then rechecks the cookie.
          const keepAlive = () => {
            if (finished || settled) return;
            const read = store.get("lock");
            read.onsuccess = () => {
              if (!started && !settled) {
                started = true;
                // Bound queueing only; each network request already has its own timeout.
                // Releasing an active handshake here could let a late cookie replace another tab's identity.
                clearTimeout(timer);
                void operation().then(
                  () => {
                    finished = true;
                  },
                  (error) => {
                    failure = error;
                    finished = true;
                  },
                );
              }
              keepAlive();
            };
          };
          keepAlive();
        } catch {
          finish(unavailable());
        }
      };
    } catch {
      finish(unavailable());
    }
  });
}
