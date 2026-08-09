import { assert, assertEquals } from "@std/assert";

const DATABASE_URL = Deno.env.get("DATABASE_URL");

Deno.test({
  name: "FactStore: create + attach a fact, retrieve it via factsForTopic",
  ignore: !DATABASE_URL,
  async fn() {
    const { FactStore } = await import("../src/facts/store.ts");
    const facts = new FactStore(DATABASE_URL!);
    try {
      await facts.init();
      await facts.clear();

      const fact = await facts.createFact({
        text: "Hyperscale data centers run roughly 528,000 gal/day of water.",
        source_name: "EESI",
        source_url: "https://example.com/eesi/water-usage",
        as_of: new Date("2026-01-01T00:00:00Z"),
      });
      assert(fact.id);

      // Not attached to any topic yet.
      assertEquals(await facts.factsForTopic("data-centers"), []);

      await facts.attachFactToTopic("data-centers", fact.id);
      const attached = await facts.factsForTopic("data-centers");
      assertEquals(attached.length, 1);
      assertEquals(attached[0].text, fact.text);

      // The same fact can attach to a second topic without duplicating the row.
      await facts.attachFactToTopic("another-topic", fact.id);
      assertEquals((await facts.factsForTopic("another-topic"))[0].id, fact.id);
      assertEquals((await facts.listAllFacts()).length, 1, "one canonical fact row, not two");

      await facts.detachFactFromTopic("data-centers", fact.id);
      assertEquals(await facts.factsForTopic("data-centers"), []);
      // Detaching from one topic doesn't touch the other attachment or the fact itself.
      assertEquals((await facts.factsForTopic("another-topic")).length, 1);
    } finally {
      await facts.close();
    }
  },
});

Deno.test({
  name: "FactStore: getFact/getTag are indexed single-row lookups, not a full-table scan",
  ignore: !DATABASE_URL,
  async fn() {
    const { FactStore } = await import("../src/facts/store.ts");
    const facts = new FactStore(DATABASE_URL!);
    try {
      await facts.init();
      await facts.clear();

      const fact = await facts.createFact({
        text: "Some durable fact.",
        source_name: "Source",
        source_url: "https://example.com/source",
        as_of: new Date("2026-01-01T00:00:00Z"),
      });
      const tag = await facts.createTag("some-tag", "Some Tag");

      assertEquals((await facts.getFact(fact.id))?.id, fact.id);
      assertEquals(await facts.getFact("no-such-id"), null);
      assertEquals((await facts.getTag(tag.id))?.id, tag.id);
      assertEquals(await facts.getTag("no-such-id"), null);
    } finally {
      await facts.close();
    }
  },
});

Deno.test({
  name: "FactStore: createTag is idempotent by slug",
  ignore: !DATABASE_URL,
  async fn() {
    const { FactStore } = await import("../src/facts/store.ts");
    const facts = new FactStore(DATABASE_URL!);
    try {
      await facts.init();
      await facts.clear();

      const first = await facts.createTag("data-centers", "Data Centers", "Hyperscale facilities");
      const second = await facts.createTag("data-centers", "Data Centers (dup attempt)", null);
      assertEquals(first.id, second.id, "same slug reuses the existing row");
      assertEquals((await facts.listTags()).length, 1);
    } finally {
      await facts.close();
    }
  },
});

Deno.test({
  name: "FactStore: suggestFactsForTopic surfaces facts sharing a tag, excludes already-attached",
  ignore: !DATABASE_URL,
  async fn() {
    const { FactStore } = await import("../src/facts/store.ts");
    const facts = new FactStore(DATABASE_URL!);
    try {
      await facts.init();
      await facts.clear();

      const tag = await facts.createTag("water-usage", "Water Usage");
      const factA = await facts.createFact({
        text: "Cooling-tower systems consume more water than air-cooled ones.",
        source_name: "EPA",
        source_url: "https://example.com/epa/cooling",
        as_of: new Date("2026-01-01T00:00:00Z"),
      });
      const factB = await facts.createFact({
        text: "Irrelevant fact with no shared tag.",
        source_name: "Nowhere",
        source_url: "https://example.com/nowhere",
        as_of: new Date("2026-01-01T00:00:00Z"),
      });
      await facts.tagFact(factA.id, tag.id);
      await facts.tagTopic("topic-x", tag.id);

      const suggested = await facts.suggestFactsForTopic("topic-x");
      const ids = suggested.map((f) => f.id);
      assert(ids.includes(factA.id), "shares a tag with the topic");
      assert(!ids.includes(factB.id), "no shared tag — not suggested");

      // Once attached, it drops out of suggestions.
      await facts.attachFactToTopic("topic-x", factA.id);
      assertEquals(
        (await facts.suggestFactsForTopic("topic-x")).map((f) => f.id),
        [],
        "already-attached facts aren't suggested again",
      );

      await facts.untagTopic("topic-x", tag.id);
      assertEquals(await facts.tagsForTopic("topic-x"), []);
    } finally {
      await facts.close();
    }
  },
});
