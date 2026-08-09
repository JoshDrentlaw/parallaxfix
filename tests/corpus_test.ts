import { assert, assertEquals } from "@std/assert";
import postgres from "postgres";
import type { EmbeddingPort, Item, RerankEmbeddingPort } from "../src/ports.ts";
import { adHocTopic, buildTopicQuery, isExcluded, slugifyTopicId } from "../src/ingestion/topic.ts";
import { testDatabaseUrl } from "./db_test_guard.ts";

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

Deno.test("slugifyTopicId: filesystem-safe slugs", () => {
  assertEquals(slugifyTopicId("Riverside City Council Recall"), "riverside-city-council-recall");
  assertEquals(slugifyTopicId("  ¡Hola! 2026 ??"), "hola-2026");
  assertEquals(slugifyTopicId("already-a-slug"), "already-a-slug");
});

// ── DB-backed integration (gated on DATABASE_URL) ─────────────────────────────

/**
 * Deterministic bag-of-words embedder for tests: hashes each token into a fixed
 * dimension and L2-normalizes. Shared vocabulary → higher cosine similarity, so
 * retrieval ordering is meaningful without downloading a real model.
 */
class FakeEmbedder implements EmbeddingPort {
  readonly dimensions = 384;
  readonly model = "fake-local-v1";

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

/**
 * Fake rerank-tier embedder (RerankEmbeddingPort) — same shape as
 * FakeEmbedder but a distinct hash constant (17 vs 31) so its vectors are
 * genuinely different from the local embedder's, and it tracks every text
 * it's asked to embed so tests can assert on *when* it gets called (never
 * for an excluded item; never twice for the same cached item).
 */
class FakeRerankEmbedder implements RerankEmbeddingPort {
  readonly model: string;
  readonly embedCalls: string[] = [];

  constructor(model = "fake-rerank-v1") {
    this.model = model;
  }

  #vec(text: string): number[] {
    const dims = 16;
    const v = new Array(dims).fill(0);
    for (const tok of text.toLowerCase().split(/\W+/).filter(Boolean)) {
      let h = 0;
      for (let i = 0; i < tok.length; i++) h = (h * 17 + tok.charCodeAt(i)) >>> 0;
      v[h % dims] += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  }

  embed(texts: string[]): Promise<number[][]> {
    this.embedCalls.push(...texts);
    return Promise.resolve(texts.map((t) => this.#vec(t)));
  }
  embedQuery(text: string): Promise<number[]> {
    return Promise.resolve(this.#vec(text));
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const DATABASE_URL = testDatabaseUrl();

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

      const ids = results.map((r) => r.item.id);
      assertEquals(ids.filter((id) => id === "a").length, 1, "dedupe: 'a' appears once");
      assert(!ids.includes("b"), "exclude term 'basketball' filters out 'b'");
      assert(ids.includes("a"), "relevant item retrieved");
      assertEquals(ids[0], "a", "most relevant item ranks first");

      // Scores are attached and ordered by descending similarity.
      assert(
        results[0].similarity >= results[results.length - 1].similarity,
        "ranked by similarity",
      );
      assert(results.every((r) => r.similarity >= -1 && r.similarity <= 1), "similarity in [-1,1]");
    } finally {
      await corpus.close();
    }
  },
});

Deno.test({
  name: "PgCorpus: a similarity floor drops weak matches instead of presenting them as real (P1)",
  ignore: !DATABASE_URL,
  async fn() {
    const { PgCorpus } = await import("../src/corpus/store.ts");
    const corpus = new PgCorpus({ databaseUrl: DATABASE_URL!, embedder: new FakeEmbedder() });
    try {
      await corpus.init();
      await corpus.clear();

      const relevant = item("a", "Wildfire near Riverside forces evacuations");
      const offtopic = item("c", "Quarterly earnings report beats expectations");
      await corpus.append([relevant, offtopic]);

      const topic = adHocTopic(["wildfire", "riverside"]);
      topic.description = "wildfire evacuations near riverside";

      // A permissive floor still returns the off-topic nearest-neighbor.
      const loose = await corpus.retrieve(topic, 10, { minSimilarity: -1 });
      assert(loose.some((r) => r.item.id === "c"), "loose floor still surfaces the weak match");

      // A strict floor drops it — "no strong match" beats a false one (P1).
      const strict = await corpus.retrieve(topic, 10, { minSimilarity: 0.99 });
      assert(!strict.some((r) => r.item.id === "c"), "strict floor drops the weak match");

      // retrieveForAnalysis carries per-item similarity (relevance threading) and
      // applies the same floor.
      const forAnalysis = await corpus.retrieveForAnalysis(topic, 10, { minSimilarity: 0.99 });
      assert(!forAnalysis.items.some((r) => r.item.id === "c"));
      assert(forAnalysis.items.every((r) => typeof r.similarity === "number"));
    } finally {
      await corpus.close();
    }
  },
});

Deno.test({
  name: "PgCorpus: append records model provenance; init() backfills pre-existing rows",
  ignore: !DATABASE_URL,
  async fn() {
    const { PgCorpus } = await import("../src/corpus/store.ts");
    const embedder = new FakeEmbedder();
    const corpus = new PgCorpus({ databaseUrl: DATABASE_URL!, embedder });
    const sql = postgres(DATABASE_URL!, { onnotice: () => {} });
    try {
      await corpus.init();
      await corpus.clear();

      await corpus.append([item("a", "Wildfire near Riverside")]);
      const [row] = await sql`SELECT model FROM items WHERE id = 'a'`;
      assertEquals(row.model, embedder.model, "append() records the embedder's model");

      // Simulate a row from before the `model` column existed.
      await sql`UPDATE items SET model = NULL WHERE id = 'a'`;
      const [nulled] = await sql`SELECT model FROM items WHERE id = 'a'`;
      assertEquals(nulled.model, null);

      // init() is called on every corpus open (see PgCorpus.init doc) — it
      // should backfill, not just create tables.
      await corpus.init();
      const [backfilled] = await sql`SELECT model FROM items WHERE id = 'a'`;
      assertEquals(backfilled.model, embedder.model, "init() backfills a null model");
    } finally {
      await corpus.close();
      await sql.end();
    }
  },
});

Deno.test({
  name: "PgCorpus.retrieveForAnalysis: without a rerank embedder, behavior is unchanged",
  ignore: !DATABASE_URL,
  async fn() {
    const { PgCorpus } = await import("../src/corpus/store.ts");
    const corpus = new PgCorpus({ databaseUrl: DATABASE_URL!, embedder: new FakeEmbedder() });
    try {
      await corpus.init();
      await corpus.clear();
      await corpus.append([item("a", "Wildfire near Riverside forces evacuations")]);

      const topic = adHocTopic(["wildfire", "riverside"]);
      topic.description = "wildfire evacuations near riverside";
      const results = await corpus.retrieveForAnalysis(topic, 10);
      assertEquals(results.items.map((r) => r.item.id), ["a"]);
      assertEquals(results.excluded_count, 0);
      assertEquals(results.excluded_sample, []);
    } finally {
      await corpus.close();
    }
  },
});

Deno.test({
  name: "PgCorpus.retrieveForAnalysis: reranks with the higher-tier embedder, caches the vector, " +
    "never re-embeds a cached (model-matching) item, skips excluded items entirely, and " +
    "re-embeds when the cached model is stale",
  ignore: !DATABASE_URL,
  async fn() {
    const { PgCorpus } = await import("../src/corpus/store.ts");
    const localEmbedder = new FakeEmbedder();
    const rerankEmbedder = new FakeRerankEmbedder();
    const corpus = new PgCorpus({
      databaseUrl: DATABASE_URL!,
      embedder: localEmbedder,
      rerankEmbedder,
      minSimilarity: -1, // isolate reranking from the floor for this test
    });
    const sql = postgres(DATABASE_URL!, { onnotice: () => {} });
    try {
      await corpus.init();
      await corpus.clear();

      const relevant = item("a", "Wildfire near Riverside forces evacuations");
      const excluded = item("b", "Riverside wildfire basketball charity game");
      await corpus.append([relevant, excluded]);

      const topic = { ...adHocTopic(["wildfire", "riverside"]), exclude: ["basketball"] };
      topic.description = "wildfire evacuations near riverside";

      const first = await corpus.retrieveForAnalysis(topic, 10);
      assertEquals(
        first.items.map((r) => r.item.id),
        ["a"],
        "excluded item never reaches the rerank tier",
      );
      assertEquals(
        rerankEmbedder.embedCalls,
        [relevant.text],
        "only the non-excluded candidate is sent",
      );

      // The excluded candidate is reported, not silently dropped (P1: a
      // topic's own exclude list is a self-inflicted coverage gap).
      assertEquals(first.excluded_count, 1);
      assertEquals(first.excluded_sample.length, 1);
      assertEquals(first.excluded_sample[0].matched_term, "basketball");
      assertEquals(first.excluded_sample[0].source, excluded.source);

      // The returned score is the rerank tier's, not the local tier's.
      const [qvec, [avec]] = await Promise.all([
        rerankEmbedder.embedQuery(buildTopicQuery(topic)),
        rerankEmbedder.embed([relevant.text]),
      ]);
      const expected = cosineSimilarity(qvec, avec);
      assert(
        Math.abs(first.items[0].similarity - expected) < 1e-9,
        `similarity should be the rerank score (${expected}), got ${first.items[0].similarity}`,
      );

      // Cached on the row.
      const [cached] = await sql`SELECT analyzed_model FROM items WHERE id = 'a'`;
      assertEquals(cached.analyzed_model, rerankEmbedder.model);

      // A second run reuses the cached vector — no new embed() calls.
      rerankEmbedder.embedCalls.length = 0;
      await corpus.retrieveForAnalysis(topic, 10);
      assertEquals(
        rerankEmbedder.embedCalls,
        [],
        "a cached, model-matching item is never re-embedded",
      );

      // A model change invalidates the cache — re-embeds on the next run.
      const newerRerankEmbedder = new FakeRerankEmbedder("fake-rerank-v2");
      const corpus2 = new PgCorpus({
        databaseUrl: DATABASE_URL!,
        embedder: localEmbedder,
        rerankEmbedder: newerRerankEmbedder,
        minSimilarity: -1,
      });
      try {
        await corpus2.retrieveForAnalysis(topic, 10);
        assertEquals(
          newerRerankEmbedder.embedCalls,
          [relevant.text],
          "a stale (model-mismatched) cached vector is re-embedded",
        );
      } finally {
        await corpus2.close();
      }
    } finally {
      await corpus.close();
      await sql.end();
    }
  },
});
