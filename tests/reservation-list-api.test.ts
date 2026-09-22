import "./support/isolated";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../server/db";
const base = process.env.TEST_BASE_URL;
test(
  "HTTP list validates pagination, filters summaries and renders shareable filter pages",
  { skip: !base },
  async () => {
    const q = "http-list-" + randomUUID();
    const ids: string[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        const row = await db.gameReservation.create({
          data: {
            gameName: q,
            hostName: "Host",
            maxPlayers: 3,
            scheduledAt: new Date(Date.now() + (i + 1) * 3600000),
          },
        });
        ids.push(row.id);
      }
      const response = await fetch(
        base + "/api/reservations?q=" + q + "&pageSize=2&page=2",
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const { data } = await response.json();
      assert.equal(data.total, 3);
      assert.equal(data.page, 2);
      assert.deepEqual(
        data.items.map((item: { id: string }) => item.id),
        [ids[2]],
      );
      assert.equal("participants" in data.items[0], false);
      for (const query of [
        "page=-1",
        "page=1&page=2",
        "pageSize=10000",
        "date=2030-02-30",
        "view=unknown",
      ]) {
        assert.equal(
          (await fetch(base + "/api/reservations?" + query)).status,
          400,
        );
      }
      const html = await (
        await fetch(base + "/?q=" + q + "&pageSize=2")
      ).text();
      assert.ok(html.includes('aria-label="筛选预约"'));
      assert.ok(html.includes('aria-label="预约分页"'));
      assert.ok(html.includes("page=2"));
      const invalid = await (await fetch(base + "/?page=-1")).text();
      assert.ok(invalid.includes("筛选条件无效"));
    } finally {
      await db.gameReservation.deleteMany({ where: { id: { in: ids } } });
      await db.$disconnect();
    }
  },
);
