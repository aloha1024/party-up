"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { Button } from "./ui/button";
import { request } from "@/lib/client-request";
import { ensureBrowserIdentity } from "@/lib/browser-identity";

// Fragments never reach the server. Keep the credential only in this component's
// memory; changing reservations unmounts it and discards the credential.
export function InvitationEntry({
  id,
  gate = false,
  onPendingChange,
}: {
  id: string;
  gate?: boolean;
  onPendingChange?: (value: boolean) => void;
}) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  useEffect(() => {
    onPendingChange?.(pending);
    return () => onPendingChange?.(false);
  }, [pending, onPendingChange]);
  useEffect(() => {
    const capture = () => {
      const params = new URLSearchParams(window.location.hash.slice(1));
      if (params.has("invite")) {
        const values = params.getAll("invite");
        setToken(
          values.length === 1 && /^[a-f0-9]{64}$/.test(values[0])
            ? values[0]
            : "",
        );
        window.history.replaceState(
          window.history.state,
          "",
          window.location.pathname + window.location.search,
        );
      }
    };
    capture();
    window.addEventListener("hashchange", capture);
    return () => window.removeEventListener("hashchange", capture);
  }, [id]);
  if (!gate && !token) return null;
  return (
    <section className="panel space-y-4 p-6" aria-label="接受邀请">
      <h1 className="text-xl font-bold">邀请制预约</h1>
      <p className="text-sm text-zinc-400">
        请通过当前有效邀请链接接受邀请。链接可能已更换；清除浏览器身份后无法找回原授权。接受邀请不会自动报名。
      </p>
      <Button
        disabled={!token || pending}
        onClick={() =>
          start(async () => {
            setError("");
            try {
              if (!navigator.onLine) throw new Error("当前离线，请联网后重试");
              await ensureBrowserIdentity();
              await request(
                `/api/reservations/${id}/invitation/accept`,
                "POST",
                { token },
              );
              setToken("");
              router.refresh();
            } catch (e) {
              setError((e as Error).message);
            }
          })
        }
      >
        {pending ? "正在接受…" : "接受邀请并查看"}
      </Button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

const invitationSchema = z.object({
  path: z.string(),
  version: z.number().int().positive(),
});
export function InvitationManager({
  id,
  onPendingChange,
}: {
  id: string;
  onPendingChange: (value: boolean) => void;
}) {
  const [invitation, setInvitation] =
    useState<z.infer<typeof invitationSchema>>();
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  useEffect(() => {
    onPendingChange(pending);
    return () => onPendingChange(false);
  }, [pending, onPendingChange]);
  async function read() {
    const value = await request(
      `/api/reservations/${id}/invitation`,
      "GET",
      undefined,
      { schema: invitationSchema },
    );
    setInvitation(value);
    return value;
  }
  function run(rotate = false) {
    start(async () => {
      setError("");
      try {
        if (!navigator.onLine) throw new Error("当前离线，请联网后重试");
        if (rotate) {
          if (
            !invitation ||
            !window.confirm(
              "更换后旧链接及尚未加入者的旧授权立即失效，确定更换？",
            )
          )
            return;
          await ensureBrowserIdentity();
          const expectedVersion = invitation.version;
          // Never retry an ambiguous rotation. Re-read before any new rotation.
          setInvitation(undefined);
          await request(`/api/reservations/${id}/invitation`, "POST", {
            expectedVersion,
          });
        }
        const value = await read();
        if (!rotate) {
          try {
            await navigator.clipboard.writeText(
              `邀请你参加预约，接受邀请后可查看及报名：${window.location.origin}${value.path}`,
            );
          } catch {
            /* Manual copy remains available. */
          }
        }
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }
  return (
    <section className="space-y-3" aria-label="邀请管理">
      <div className="flex flex-wrap gap-2">
        <Button disabled={pending} onClick={() => run()}>
          分享邀请
        </Button>
        <Button
          variant="outline"
          disabled={pending || !invitation}
          onClick={() => run(true)}
        >
          更换邀请链接
        </Button>
      </div>
      {invitation && (
        <textarea
          className="field"
          aria-label="当前邀请链接"
          readOnly
          value={
            typeof window === "undefined"
              ? ""
              : `${window.location.origin}${invitation.path}`
          }
        />
      )}
      {error && <p role="alert">{error}。请重新获取当前链接确认结果。</p>}
    </section>
  );
}
