"use client";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Field } from "./reservation-ui";
import { request } from "../lib/client-request";
import {
  MAX_SAVED_TEMPLATES,
  savedTemplateFieldsSchema,
  savedTemplateListSchema,
  savedTemplateSchema,
  type SavedTemplate,
} from "../lib/saved-template";
import { z } from "zod";

type Fields = {
  name: string;
  visibility: "PUBLIC" | "INVITE";
  gameName: string;
  hostName: string;
  maxPlayers: string;
  description: string;
  platform: string;
  gameServer: string;
};
const emptyFields = (nickname: string): Fields => ({
  name: "",
  visibility: "PUBLIC",
  gameName: "",
  hostName: nickname,
  maxPlayers: "5",
  description: "",
  platform: "",
  gameServer: "",
});
const editFields = (item: SavedTemplate): Fields => ({
  name: item.name,
  visibility: item.visibility,
  gameName: item.gameName,
  hostName: item.hostName,
  maxPlayers: String(item.maxPlayers),
  description: item.description,
  platform: item.platform,
  gameServer: item.gameServer,
});

export function SavedTemplates({
  initialItems,
  nickname,
}: {
  initialItems: SavedTemplate[];
  nickname: string;
}) {
  const [items, setItems] = useState(initialItems);
  const [editing, setEditing] = useState<SavedTemplate | null>(null);
  const [fields, setFields] = useState<Fields>(() => emptyFields(nickname));
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => setReady(true), []);
  const change = (name: keyof Fields, value: string) =>
    setFields((previous) => ({ ...previous, [name]: value }));
  const hasChanges =
    JSON.stringify(fields) !==
    JSON.stringify(editing ? editFields(editing) : emptyFields(nickname));
  function begin(item: SavedTemplate | null) {
    if (hasChanges && !window.confirm("当前模板输入尚未保存，确定放弃并切换？"))
      return;
    setEditing(item);
    setFields(item ? editFields(item) : emptyFields(nickname));
    setError("");
    setMessage("");
  }
  async function run(operation: () => Promise<void>) {
    if (pending) return;
    if (!navigator.onLine) {
      setError("当前离线，请联网后再操作");
      return;
    }
    setPending(true);
    setError("");
    setMessage("");
    try {
      await operation();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  async function refresh() {
    await run(async () => {
      const result = await request("/api/user/templates", "GET", undefined, {
        schema: savedTemplateListSchema,
      });
      setItems(result.items);
      setMessage(
        "列表已刷新，当前输入已保留。需要使用新版本时，请重新点击对应模板的编辑按钮。",
      );
    });
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = savedTemplateFieldsSchema.safeParse({
      ...fields,
      maxPlayers: Number(fields.maxPlayers),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    void run(async () => {
      const item = await request(
        editing
          ? `/api/user/templates/${encodeURIComponent(editing.id)}`
          : "/api/user/templates",
        editing ? "PATCH" : "POST",
        { ...parsed.data, ...(editing ? { version: editing.version } : {}) },
        { schema: savedTemplateSchema },
      );
      setItems((current) => [
        item,
        ...current.filter((row) => row.id !== item.id),
      ]);
      setEditing(null);
      setFields(emptyFields(nickname));
      setMessage("模板已保存，可点击使用模板创建预约。");
    });
  }
  function remove(item: SavedTemplate) {
    if (!window.confirm(`删除模板“${item.name}”？已创建的预约不受影响。`))
      return;
    if (
      editing?.id === item.id &&
      hasChanges &&
      !window.confirm("该模板有尚未保存的输入，确定一并放弃？")
    )
      return;
    void run(async () => {
      await request(
        `/api/user/templates/${encodeURIComponent(item.id)}`,
        "DELETE",
        { version: item.version },
        { schema: z.object({ deleted: z.literal(true) }) },
      );
      setItems((current) => current.filter((row) => row.id !== item.id));
      if (editing?.id === item.id) {
        setEditing(null);
        setFields(emptyFields(nickname));
      }
      setMessage("模板已删除。");
    });
  }
  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-3xl font-bold">常用组局模板</h1>
      <p className="text-sm leading-6 text-zinc-400">
        模板仅当前账号可见，最多保存 20
        个，可跨设备使用。只保存组局配置；开玩时间、报名截止、名单和私密集合信息须在新预约中重新设置。
      </p>
      <Link className="text-sm text-lime-300" href="/account">
        返回个人账号
      </Link>
      {error && (
        <p role="alert" className="text-red-300">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm text-lime-300">
          {message}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-zinc-400">
          已保存 {items.length} / {MAX_SAVED_TEMPLATES} 个
        </p>
        <Button
          variant="outline"
          disabled={!ready || pending}
          onClick={() => begin(null)}
        >
          新建模板
        </Button>
        <Button
          variant="outline"
          disabled={!ready || pending}
          onClick={() => void refresh()}
        >
          刷新列表
        </Button>
      </div>
      <ul className="space-y-3">
        {items.map((item) => (
          <li
            key={item.id}
            data-template-id={item.id}
            className="panel space-y-3 p-5"
          >
            <h2 className="break-words font-semibold">{item.name}</h2>
            <p className="break-words text-sm text-zinc-400">
              {item.gameName} · {item.maxPlayers} 人 ·{" "}
              {item.visibility === "INVITE" ? "邀请制" : "公开"}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline">
                <Link
                  prefetch={false}
                  href={`/reservation/new?template=${encodeURIComponent(item.id)}`}
                >
                  使用模板
                </Link>
              </Button>
              <Button
                variant="outline"
                disabled={!ready || pending}
                onClick={() => begin(item)}
              >
                编辑模板
              </Button>
              <Button
                variant="outline"
                disabled={!ready || pending}
                onClick={() => remove(item)}
              >
                删除模板
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {!items.length && (
        <p className="text-sm text-zinc-400">
          暂无模板，在下方保存常用组局配置。
        </p>
      )}
      <form
        aria-label="模板配置"
        className="panel space-y-5 p-6"
        onSubmit={save}
      >
        <h2 className="text-xl font-semibold">
          {editing ? "编辑模板" : "新建模板"}
        </h2>
        <fieldset className="min-w-0 space-y-5" disabled={!ready || pending}>
          <Field title="模板名称">
            <Input
              value={fields.name}
              onChange={(e) => change("name", e.target.value)}
              required
              maxLength={40}
            />
          </Field>
          <Field title="预约可见性">
            <select
              className="field"
              value={fields.visibility}
              onChange={(e) => change("visibility", e.target.value)}
            >
              <option value="PUBLIC">公开预约</option>
              <option value="INVITE">邀请制预约</option>
            </select>
          </Field>
          <Field title="游戏名称">
            <Input
              value={fields.gameName}
              onChange={(e) => change("gameName", e.target.value)}
              required
              maxLength={80}
            />
          </Field>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field title="平台（选填）">
              <Input
                value={fields.platform}
                onChange={(e) => change("platform", e.target.value)}
                maxLength={80}
              />
            </Field>
            <Field title="区服（选填）">
              <Input
                value={fields.gameServer}
                onChange={(e) => change("gameServer", e.target.value)}
                maxLength={80}
              />
            </Field>
            <Field title="发起人昵称">
              <Input
                value={fields.hostName}
                onChange={(e) => change("hostName", e.target.value)}
                required
                maxLength={24}
              />
            </Field>
            <Field title="最大参与人数">
              <Input
                type="number"
                value={fields.maxPlayers}
                onChange={(e) => change("maxPlayers", e.target.value)}
                required
                min={2}
                max={100}
              />
            </Field>
          </div>
          <Field title="备注（选填）">
            <textarea
              className="field min-h-28"
              value={fields.description}
              onChange={(e) => change("description", e.target.value)}
              maxLength={1000}
            />
          </Field>
          <div className="flex flex-wrap gap-3">
            <Button disabled={!editing && items.length >= MAX_SAVED_TEMPLATES}>
              {editing ? "保存修改" : "保存模板"}
            </Button>
            {editing && (
              <Button
                type="button"
                variant="outline"
                onClick={() => begin(null)}
              >
                取消编辑
              </Button>
            )}
          </div>
        </fieldset>
        <p className="text-xs leading-6 text-zinc-500">
          提交结果不明确时请先刷新列表核对，再决定是否重试。刷新列表会保留当前输入。
        </p>
      </form>
    </section>
  );
}
