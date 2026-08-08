import { assert, assertEquals } from "@std/assert";
import { createHandler } from "../src/web/server.ts";

const get = (path: string) => new Request(`http://localhost${path}`);
const post = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const del = (path: string) => new Request(`http://localhost${path}`, { method: "DELETE" });

const DATABASE_URL = Deno.env.get("DATABASE_URL");

Deno.test("web: Track B fact/tag routes 503 without a corpus", async () => {
  const handler = createHandler({ databaseUrl: () => undefined });
  assertEquals((await handler(get("/api/tags"))).status, 503);
  assertEquals((await handler(get("/api/topics/x/facts"))).status, 503);
  assertEquals((await handler(get("/api/topics/x/tags"))).status, 503);
  assertEquals((await handler(get("/api/topics/x/fact-suggestions"))).status, 503);
});

Deno.test({
  name: "web: Track B — create a tag, create+attach a fact, suggest via shared tag, detach",
  ignore: !DATABASE_URL,
  async fn() {
    const { FactStore } = await import("../src/facts/store.ts");
    const cleanup = new FactStore(DATABASE_URL!);
    await cleanup.init();
    await cleanup.clear();
    await cleanup.close();

    const handler = createHandler({ databaseUrl: () => DATABASE_URL });

    // Create a tag.
    const tagRes = await handler(post("/api/tags", { name: "Data Centers" }));
    assertEquals(tagRes.status, 201);
    const tag = await tagRes.json();
    assertEquals(tag.slug, "data-centers");

    // Re-creating the same slug reuses the row (idempotent), even with a
    // different display name — the slug, not the name, is the identity.
    const tagAgain = await handler(
      post("/api/tags", { name: "Data Centers (again)", slug: "data-centers" }),
    );
    assertEquals((await tagAgain.json()).id, tag.id);
    assertEquals((await (await handler(get("/api/tags"))).json()).length, 1);

    // Tag a topic (creates the topic-tag join; the topic itself lives only as JSON,
    // no row needs to pre-exist).
    await handler(post("/api/topics/riverside-recall/tags", { tagId: tag.id }));
    const topicTags = await (await handler(get("/api/topics/riverside-recall/tags"))).json();
    assertEquals(topicTags.length, 1);
    assertEquals(topicTags[0].id, tag.id);

    // Create a background fact directly on a *different* topic ("data-centers-general"),
    // and tag the fact so it's discoverable via the shared tag.
    const factRes = await handler(
      post("/api/topics/data-centers-general/facts", {
        text: "Hyperscale data centers run roughly 528,000 gal/day of water.",
        source_name: "EESI",
        source_url: "https://example.com/eesi/water-usage",
      }),
    );
    assertEquals(factRes.status, 201);
    const fact = await factRes.json();

    // Not yet suggested for riverside-recall (fact isn't tagged yet).
    const beforeTagging = await (
      await handler(get("/api/topics/riverside-recall/fact-suggestions"))
    ).json();
    assertEquals(beforeTagging, []);

    // Tag the fact via the store directly (no dedicated route — tagging a fact is
    // part of the create flow in the real UI; exercised at the store layer in
    // facts_test.ts). Here we only need it tagged to prove the suggestion route.
    const tagFact = new FactStore(DATABASE_URL!);
    await tagFact.tagFact(fact.id, tag.id);
    await tagFact.close();

    const suggested = await (
      await handler(get("/api/topics/riverside-recall/fact-suggestions"))
    ).json();
    assert(suggested.some((f: { id: string }) => f.id === fact.id));

    // Attach an *existing* fact by id (not just create+attach).
    const attachRes = await handler(
      post("/api/topics/riverside-recall/facts", { factId: fact.id }),
    );
    assertEquals(attachRes.status, 201);
    const attached = await (await handler(get("/api/topics/riverside-recall/facts"))).json();
    assertEquals(attached.length, 1);
    assertEquals(attached[0].id, fact.id);

    // Once attached, it drops out of suggestions for that topic.
    const afterAttach = await (
      await handler(get("/api/topics/riverside-recall/fact-suggestions"))
    ).json();
    assertEquals(afterAttach, []);

    // The original topic still has it attached — detaching is scoped, not global.
    assertEquals(
      (await (await handler(get("/api/topics/data-centers-general/facts"))).json()).length,
      1,
    );

    // Detach from riverside-recall; the fact record itself survives.
    const detachRes = await handler(
      del(`/api/topics/riverside-recall/facts?factId=${fact.id}`),
    );
    assertEquals(detachRes.status, 200);
    assertEquals(await (await handler(get("/api/topics/riverside-recall/facts"))).json(), []);
    assertEquals(
      (await (await handler(get("/api/topics/data-centers-general/facts"))).json()).length,
      1,
      "detaching from one topic doesn't affect another topic's attachment",
    );

    // Untag the topic.
    const untagRes = await handler(
      del(`/api/topics/riverside-recall/tags?tagId=${tag.id}`),
    );
    assertEquals(untagRes.status, 200);
    assertEquals(await (await handler(get("/api/topics/riverside-recall/tags"))).json(), []);
  },
});

Deno.test({
  name: "web: Track B — creating a fact requires text/source_name/source_url",
  ignore: !DATABASE_URL,
  async fn() {
    const handler = createHandler({ databaseUrl: () => DATABASE_URL });
    const res = await handler(post("/api/topics/some-topic/facts", { text: "incomplete" }));
    assertEquals(res.status, 400);
  },
});
