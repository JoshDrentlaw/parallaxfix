import { assert, assertEquals } from "@std/assert";
import type { EmbeddingPort, Item } from "../src/ports.ts";
import { adHocTopic, buildTopicQuery, isExcluded } from "../src/ingestion/topic.ts";

// ── pure helpers (no DB) ──────────────────────────────────────────────────────

function item(id: string, text: string): Item {
  return {
    id,
    source: "bluesky",
    source_id: id,
    author: "did:plc:test",
    text,
    url: `https://bsky.app/profile/did:plc:test/post/${id}`,
    created_at: new Date("2026-06-29T12:00:00.000Z"),
    fetched_at: new Date("2026-06-29T12:00:01.000Z"),
    engagement: {},
    parent_ref: null,
    embedding: null,
    raw: {},
  };
}

Deno.test("isExcluded: drops items hitting an exclude term, case-insensitive", () => {
  const topic = { ...adHocTopic(["riverside"]), exclude: ["basketball"] };
  assert(isExcluded(item("a", "New BASKETBALL arena downtown"), topic));
  assert(!isExcluded(item("b", "Wildfire near Riverside"), topic));
});

Deno.test("buildTopicQuery: joins description + keywords + entities, falls back to id", () => {
  const t = {
    id: "riverside-recall",
    keywords: ["recall"],
    entities: ["Riverside"],
    description: "Recall effort in Riverside",
    exclude: [],
  };
  assertEquals(buildTopicQuery(t), "Recall effort in Riverside recall Riverside");
  assertEquals(
    buildTopicQuery({ ...t, description: "", keywords: [], entities: [] }),
    "riverside-recall",
  );
});

// ── DB-backed integration (gated on DATABASE_URL) ─────────────────────────────

/**
 * Deterministic bag-of-words embedder for tests: hashes each token into a fixed
 * dimension and L2-normalizes. Shared vocabulary → higher cosine similarity, so
 * retrieval ordering is meaningful without downloading a real model.
 */
class FakeEmbedder implements EmbeddingPort {
  readonly dimensions = 384;

  #vec(text: string): number[] {
    const v = new Array(this.dimensions).fill(0);
    for (const tok of text.toLowerCase().split(/\W+/).filter(Boolean)) {
      let h = 0;
      for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
      v[h % this.dimensions] += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  }

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => this.#vec(t)));
  }
  embedQuery(text: string): Promise<number[]> {
    return Promise.resolve(this.#vec(text));
  }
}

const DATABASE_URL = Deno.env.get("DATABASE_URL");

Deno.test({
  name: "PgCorpus: append + dedupe + semantic retrieve + exclude filter",
  ignore: !DATABASE_URL,
  async fn() {
    const { PgCorpus } = await import("../src/corpus/store.ts");
    const corpus = new PgCorpus({ databaseUrl: DATABASE_URL!, embedder: new FakeEmbedder() });
    try {
      await corpus.init();
      await corpus.clear();

      const relevant = item("a", "Wildfire near Riverside forces evacuations");
      const offtopic = item("c", "Quarterly earnings report beats expectations");
      const excluded = item("b", "Riverside wildfire basketball charity game");

      // Append relevant twice to prove dedupe (same id → one row).
      await corpus.append([relevant, structuredClone(relevant), offtopic, excluded]);

      const topic = { ...adHocTopic(["wildfire", "riverside"]), exclude: ["basketball"] };
      topic.description = "wildfire evacuations near riverside";
      const results = await corpus.retrieve(topic, 10);

      const ids = results.map((r) => r.id);
      assertEquals(ids.filter((id) => id === "a").length, 1, "dedupe: 'a' appears once");
      assert(!ids.includes("b"), "exclude term 'basketball' filters out 'b'");
      assert(ids.includes("a"), "relevant item retrieved");
      assertEquals(ids[0], "a", "most relevant item ranks first");
    } finally {
      await corpus.close();
    }
  },
});
