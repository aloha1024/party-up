"use client";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  type ReactNode,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { PublicIdentity } from "../lib/user-account";
import {
  getClientIdentity,
  setClientIdentity,
  identityEventSource,
} from "../lib/client-identity";
import { request } from "../lib/client-request";
const Context = createContext<PublicIdentity | undefined>(undefined);
export const useIdentity = () => useContext(Context);
export function IdentityProvider({
  identity,
  children,
}: {
  identity: PublicIdentity;
  children: ReactNode;
}) {
  const [stale, setStale] = useState(false);
  const installed = useRef<string | undefined>(undefined);
  if (
    typeof window !== "undefined" &&
    !stale &&
    installed.current !== identity.scope
  ) {
    setClientIdentity(identity);
    installed.current = identity.scope;
  }
  useEffect(() => {
    const invalidate = () => setStale(true);
    const restored = (e: PageTransitionEvent) => {
      if (e.persisted) invalidate();
    };
    const storage = (e: StorageEvent) => {
      if (e.key === "party-identity-event") invalidate();
    };
    const check = async () => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      const expected = getClientIdentity()?.scope;
      try {
        const next = await request<PublicIdentity>("/api/identity");
        if (expected === getClientIdentity()?.scope && next.scope !== expected)
          invalidate();
      } catch {}
    };
    let channel: BroadcastChannel | undefined;
    try {
      channel = new BroadcastChannel("party-identity");
      channel.onmessage = (e) => {
        if (e.data?.source !== identityEventSource) invalidate();
      };
    } catch {}
    window.addEventListener("storage", storage);
    window.addEventListener("party-identity-stale", invalidate);
    window.addEventListener("focus", check);
    window.addEventListener("pageshow", restored);
    window.addEventListener("online", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      channel?.close();
      window.removeEventListener("storage", storage);
      window.removeEventListener("party-identity-stale", invalidate);
      window.removeEventListener("focus", check);
      window.removeEventListener("pageshow", restored);
      window.removeEventListener("online", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [identity.scope]);
  if (stale)
    return (
      <div className="panel mx-auto my-10 max-w-xl space-y-4 p-6" role="alert">
        <p>身份或登录状态已变化，原页面已关闭。请刷新后核对最新记录。</p>
        <button
          className="field"
          onClick={() => {
            if (navigator.onLine) window.location.reload();
          }}
        >
          刷新页面
        </button>
        <p className="text-sm text-zinc-400">
          离线时不会自动提交。原身份草稿仍保留。
        </p>
      </div>
    );
  return (
    <Context.Provider value={identity}>
      <div key={identity.scope}>{children}</div>
    </Context.Provider>
  );
}
export function AccountNavigation() {
  const identity = useIdentity();
  return (
    <Link
      className="max-w-40 truncate text-sm text-zinc-300"
      prefetch={false}
      href={
        identity?.mode === "user" || identity?.mode === "invalid"
          ? "/account"
          : "/account/login"
      }
    >
      {identity?.mode === "user"
        ? identity.user?.nickname
        : identity?.mode === "invalid"
          ? "重新登录 / 退出"
          : "游客 · 登录 / 注册"}
    </Link>
  );
}
export function RegisteredFeature({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  const identity = useIdentity();
  return identity?.mode === "user" && !identity.user?.mustChangePassword ? (
    children
  ) : (
    <Link className="text-sm text-lime-300" href="/account/login">
      {label}需注册并登录
    </Link>
  );
}
