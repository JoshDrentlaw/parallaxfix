import { assert, assertEquals } from "@std/assert";
import { createHandler } from "../src/web/server.ts";
import { sampleBriefing } from "./fixtures/briefing.ts";
import { testDatabaseUrl } from "./db_test_guard.ts";

const get = (path: string) => new Request(`http://localhost${path}`);

const DATABASE_URL = testDatabaseUrl();

Deno.test("web: briefings-library routes 503 without a corpus", async () => {
  const handler = createHandler({ databaseUrl: () => undefined });
  assertEquals((await handler(get("/api/topics/x/briefings"))).status, 503);
  assertEquals((await handler(get("/api/briefings/latest"))).status, 503);
  assertEquals((await handler(get("/api/briefings/some-id"))).status, 503);
});

Deno.test({
  name: "web: /api/topics/:id/briefings lists, /api/briefings/:id fetches the full payload",
  ignore: !DATABASE_URL,
  async fn() {
    const { BriefingStore } = await import("../src/briefing/store.ts");
    const store = new BriefingStore(DATABASE_URL!);
    await store.init();
    await store.clear();
    await store.save(sampleBriefing());
    await store.close();

    const handler = createHandler({ databaseUrl: () => DATABASE_URL });

    const list = await (await handler(get("/api/topics/riverside-recall/briefings"))).json();
    assertEquals(list.length, 1);
    assertEquals(list[0].total_claims, 4);

    const full = await (
      await handler(get(`/api/briefings/${encodeURIComponent(list[0].id)}`))
    ).json();
    assertEquals(full.topic_id, "riverside-recall");
    assertEquals(full.narratives.length, 2);

    // Empty for a topic with no saved briefings.
    assertEquals(
      await (await handler(get("/api/topics/no-such-topic/briefings"))).json(),
      [],
    );

    // Unknown id -> 404, not a crash.
    assertEquals((await handler(get("/api/briefings/nope"))).status, 404);
  },
});

Deno.test({
  name: "web: /api/briefings/latest returns one row per topic",
  ignore: !DATABASE_URL,
  async fn() {
    const { BriefingStore } = await import("../src/briefing/store.ts");
    const store = new BriefingStore(DATABASE_URL!);
    await store.init();
    await store.clear();
    await store.save({ ...sampleBriefing(), topic_id: "topic-a" });
    await store.save({
      ...sampleBriefing(),
      topic_id: "topic-b",
      generated_at: new Date("2026-07-08T00:00:00Z"),
    });
    await store.close();

    const handler = createHandler({ databaseUrl: () => DATABASE_URL });
    const latest = await (await handler(get("/api/briefings/latest"))).json();
    assertEquals(latest.length, 2);
    const topics = latest.map((l: { topic_id: string }) => l.topic_id).sort();
    assertEquals(topics, ["topic-a", "topic-b"]);
    assert(latest.every((l: { top_velocity: number }) => l.top_velocity > 0));
  },
});
