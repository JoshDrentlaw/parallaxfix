import { assert, assertEquals } from "@std/assert";
import { sampleBriefing } from "./fixtures/briefing.ts";
import { testDatabaseUrl } from "./db_test_guard.ts";

const DATABASE_URL = testDatabaseUrl();

Deno.test({
  name: "BriefingStore: save + listForTopic (most recent first) + get by id",
  ignore: !DATABASE_URL,
  async fn() {
    const { BriefingStore } = await import("../src/briefing/store.ts");
    const store = new BriefingStore(DATABASE_URL!);
    try {
      await store.init();
      await store.clear();

      const older = { ...sampleBriefing(), generated_at: new Date("2026-07-01T00:00:00Z") };
      const newer = { ...sampleBriefing(), generated_at: new Date("2026-07-09T18:00:00Z") };
      await store.save(older);
      await store.save(newer);

      const list = await store.listForTopic("riverside-recall");
      assertEquals(list.length, 2);
      assertEquals(list[0].generated_at.toISOString(), newer.generated_at.toISOString());
      assertEquals(list[1].generated_at.toISOString(), older.generated_at.toISOString());
      assertEquals(list[0].narrative_count, 2);
      assertEquals(list[0].total_claims, 4);
      // Top narrative (already velocity-sorted going in) carries its velocity/label.
      assert(list[0].top_velocity !== null && list[0].top_velocity > 0);
      assertEquals(list[0].top_label, "Recall petition reaches signature threshold");

      const fetched = await store.get(list[0].id);
      assert(fetched);
      assertEquals((fetched as { topic_id: string }).topic_id, "riverside-recall");

      assertEquals(await store.get("no-such-id"), null);
    } finally {
      await store.close();
    }
  },
});

Deno.test({
  name: "BriefingStore: saving twice at the same generated_at overwrites, not duplicates",
  ignore: !DATABASE_URL,
  async fn() {
    const { BriefingStore } = await import("../src/briefing/store.ts");
    const store = new BriefingStore(DATABASE_URL!);
    try {
      await store.init();
      await store.clear();

      const b = sampleBriefing();
      await store.save(b);
      await store.save({ ...b, total_items: 999 });

      const list = await store.listForTopic("riverside-recall");
      assertEquals(list.length, 1);
      assertEquals(list[0].total_items, 999);
    } finally {
      await store.close();
    }
  },
});

Deno.test({
  name: "BriefingStore: allNarrativeScores unnests velocity/relevance across every stored briefing",
  ignore: !DATABASE_URL,
  async fn() {
    const { BriefingStore } = await import("../src/briefing/store.ts");
    const store = new BriefingStore(DATABASE_URL!);
    try {
      await store.init();
      await store.clear();

      const a = { ...sampleBriefing(), topic_id: "topic-a" };
      const b = { ...sampleBriefing(), topic_id: "topic-b" };
      await store.save(a);
      await store.save(b);

      const scores = await store.allNarrativeScores();
      // sampleBriefing() has 2 narratives; saved under two different topics.
      assertEquals(scores.length, 4);
      for (const s of scores) {
        assertEquals(typeof s.velocity, "number");
        assertEquals(typeof s.relevance, "number");
      }
      const velocities = scores.map((s) => s.velocity).sort((x, y) => x - y);
      assertEquals(velocities, [5.6, 5.6, 14.2, 14.2]);
    } finally {
      await store.close();
    }
  },
});

Deno.test({
  name: "BriefingStore: latestPerTopic returns one row per topic, the most recent",
  ignore: !DATABASE_URL,
  async fn() {
    const { BriefingStore } = await import("../src/briefing/store.ts");
    const store = new BriefingStore(DATABASE_URL!);
    try {
      await store.init();
      await store.clear();

      const a1 = {
        ...sampleBriefing(),
        topic_id: "topic-a",
        generated_at: new Date("2026-07-01T00:00:00Z"),
      };
      const a2 = {
        ...sampleBriefing(),
        topic_id: "topic-a",
        generated_at: new Date("2026-07-05T00:00:00Z"),
      };
      const b1 = {
        ...sampleBriefing(),
        topic_id: "topic-b",
        generated_at: new Date("2026-07-02T00:00:00Z"),
      };
      await store.save(a1);
      await store.save(a2);
      await store.save(b1);

      const latest = await store.latestPerTopic();
      assertEquals(latest.length, 2);
      const byTopic = Object.fromEntries(latest.map((l) => [l.topic_id, l]));
      assertEquals(byTopic["topic-a"].generated_at.toISOString(), a2.generated_at.toISOString());
      assertEquals(byTopic["topic-b"].generated_at.toISOString(), b1.generated_at.toISOString());
    } finally {
      await store.close();
    }
  },
});
