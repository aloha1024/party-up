import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { ClientRequestError, request } from "../lib/client-request";

test("client requests preserve same-origin identity, encode writes once and validate returned data", async (t) => {
  let signal: AbortSignal | undefined;
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (url: string, init: RequestInit) => {
      assert.equal(url, "/api/reservations");
      assert.equal(init.method, "POST");
      assert.equal(init.credentials, "same-origin");
      assert.equal(init.redirect, "error");
      assert.equal(init.cache, "no-store");
      assert.deepEqual(JSON.parse(init.body as string), { gameName: "游戏" });
      signal = init.signal as AbortSignal;
      return Response.json({
        data: { id: "reservation-1", privateField: "ignored" },
      });
    },
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = await request(
    "/api/reservations",
    "POST",
    { gameName: "游戏" },
    {
      schema: z.object({ id: z.string() }),
    },
  );
  assert.deepEqual(result, { id: "reservation-1" });
  t.mock.timers.tick(15001);
  assert.equal(signal?.aborted, false, "successful request clears its timeout");
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("client errors preserve business messages and translate proxy HTML without exposing response content", async (t) => {
  const responses = [
    Response.json({ error: "人数已满" }, { status: 409 }),
    new Response("<html>private proxy details</html>", { status: 502 }),
    new Response("", { status: 401 }),
    new Response("", { status: 403 }),
    new Response("", { status: 404 }),
    new Response("", { status: 429 }),
  ];
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    responses.shift()!,
  );
  await assert.rejects(request("/join", "POST"), {
    message: "人数已满",
    code: "HTTP",
    status: 409,
  });
  await assert.rejects(request("/join", "POST"), (e: unknown) => {
    assert.ok(e instanceof ClientRequestError);
    assert.equal(e.status, 502);
    assert.match(e.message, /服务暂时不可用.*操作可能已生效/);
    assert.doesNotMatch(e.message, /private|html|SyntaxError/);
    return true;
  });
  for (const expected of [
    /登录已失效/,
    /没有权限/,
    /记录不存在/,
    /操作过于频繁/,
  ]) {
    await assert.rejects(request("/admin", "PATCH"), expected);
  }
  assert.equal(
    fetchMock.mock.callCount(),
    6,
    "HTTP failures are never retried",
  );
});

test("malformed success envelopes and invalid typed responses cannot display a success result", async (t) => {
  for (const body of [
    "<html>login page</html>",
    "null",
    "[]",
    "{}",
    '{"error":"unexpected"}',
    '{"data":{"id":12}}',
  ]) {
    const fetchMock = t.mock.method(
      globalThis,
      "fetch",
      async () => new Response(body),
    );
    await assert.rejects(
      request("/create", "POST", {}, { schema: z.object({ id: z.string() }) }),
      (e: unknown) => {
        assert.ok(e instanceof ClientRequestError);
        assert.equal(e.code, "INVALID_RESPONSE");
        assert.match(e.message, /操作可能已生效/);
        assert.doesNotMatch(e.message, /html|JSON|Zod|Unexpected/);
        return true;
      },
    );
    assert.equal(fetchMock.mock.callCount(), 1);
    fetchMock.mock.restore();
  }
});

test("network failures release the timer and never automatically resend a mutation", async (t) => {
  let signal: AbortSignal | undefined;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (_: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      throw new TypeError("Failed to fetch");
    },
  );
  await assert.rejects(request("/delete", "DELETE"), (e: unknown) => {
    assert.ok(e instanceof ClientRequestError);
    assert.equal(e.code, "NETWORK");
    assert.match(e.message, /避免重复提交/);
    return true;
  });
  t.mock.timers.tick(15001);
  assert.equal(signal?.aborted, false);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("a request that never receives headers times out, aborts and sends only once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | undefined;
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    (_: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Promise<Response>((_, reject) => {
        signal!.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    },
  );
  const pending = request("/join", "POST");
  const rejection = assert.rejects(pending, (e: unknown) => {
    assert.ok(e instanceof ClientRequestError);
    assert.equal(e.code, "TIMEOUT");
    assert.match(e.message, /请先刷新页面确认结果/);
    return true;
  });
  t.mock.timers.tick(14999);
  assert.equal(signal?.aborted, false);
  t.mock.timers.tick(1);
  await rejection;
  assert.equal(signal?.aborted, true);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("timeout also bounds an unfinished response body; reads use a reload message", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let bodyStarted = false;
  let signal: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", async (_: string, init: RequestInit) => {
    signal = init.signal as AbortSignal;
    return {
      ok: true,
      status: 200,
      json: () => {
        bodyStarted = true;
        return new Promise(() => {});
      },
    } as Response;
  });
  const pending = request("/list");
  await Promise.resolve();
  assert.equal(bodyStarted, true);
  const rejection = assert.rejects(pending, (e: unknown) => {
    assert.ok(e instanceof ClientRequestError);
    assert.equal(e.code, "TIMEOUT");
    assert.match(e.message, /请稍后重新加载/);
    assert.doesNotMatch(e.message, /操作可能已生效/);
    return true;
  });
  t.mock.timers.tick(15000);
  await rejection;
  assert.equal(signal?.aborted, true);
});

test("client requests retain the server conflict code for a dedicated editor recovery flow", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      {
        error: "预约已被其他人修改",
        code: "EDIT_CONFLICT",
      },
      { status: 409 },
    ),
  );
  await assert.rejects(request("/edit", "PATCH"), (e: unknown) => {
    assert.ok(e instanceof ClientRequestError);
    assert.equal(e.status, 409);
    assert.equal(e.serverCode, "EDIT_CONFLICT");
    assert.equal(e.message, "预约已被其他人修改");
    return true;
  });
});

test("server request id is exposed for support without trusting arbitrary header text", async (t) => {
  const id = "12345678-1234-1234-1234-123456789abc";
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { error: "服务繁忙", code: "BUSY" },
      { status: 503, headers: { "X-Request-ID": id } },
    ),
  );
  await assert.rejects(request("/edit", "PATCH"), (error: unknown) => {
    assert.ok(error instanceof ClientRequestError);
    assert.equal(error.requestId, id);
    assert.ok(error.message.includes(id));
    return true;
  });
});
