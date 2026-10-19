"use client";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ClientRequestError } from "@/lib/client-request";

export const AdminSessionEndedContext = createContext<
  (message: string) => void
>(() => {});

export function useAdminFeedback(onSessionEnded?: (message: string) => void) {
  const router = useRouter();
  const parentSessionEnded = useContext(AdminSessionEndedContext);
  const [error, setError] = useState("");
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  function checkOnline() {
    if (!navigator.onLine) {
      setError("当前离线，尚未提交操作。请联网后核对状态再操作。");
      return false;
    }
    return true;
  }

  function handleError(cause: unknown) {
    if (!active.current) return;
    // Wrong login/current passwords are also 401, but do not end a valid session.
    if (
      cause instanceof ClientRequestError &&
      cause.code === "HTTP" &&
      ((cause.status === 401 && cause.serverCode === "UNAUTHORIZED") ||
        (cause.status === 403 && cause.serverCode === "FORBIDDEN") ||
        (cause.status === 409 && cause.serverCode === "PASSWORD_CHANGED"))
    ) {
      const message = cause.message + " 请联网后重新登录。";
      setError(message);
      (onSessionEnded ?? parentSessionEnded)(message);
      return;
    }
    const message = cause instanceof Error ? cause.message : "请求失败";
    setError(message + " 本操作不会自动重发，请联网后刷新核对。");
  }

  function refreshAfterSuccess() {
    if (!active.current) return;
    if (navigator.onLine) router.refresh();
    else setError("操作已成功，当前离线，请联网后刷新核对。");
  }

  function refreshStatus() {
    if (!navigator.onLine) {
      // Keep an existing uncertain/success message: checking does not prove the result.
      setError((current) =>
        current.includes("当前离线")
          ? current
          : (current ? current + " " : "") + "当前离线，请联网后刷新核对状态。",
      );
      return;
    }
    router.refresh();
  }

  return {
    error,
    setError,
    checkOnline,
    handleError,
    refreshAfterSuccess,
    refreshStatus,
  };
}
