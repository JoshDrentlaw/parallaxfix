/**
 * Corpus store (CorpusPort) — Postgres + pgvector.
 *
 * One database holds the append-only event log (the `items` table) and the
 * embedding index (a `vector` column with an HNSW cosine index). Chosen over
 * the SQLite MVP because Parallax Fix is headed for a multi-user hosted
 * deployment: a client-server DB gives concurrent writes, durability, and a
 * single store for app data + vectors.
 *
 * The Corpus owns embeddings (per the bounded-context split): `append` embeds
 * any item that arrives without a vector; `retrieve` embeds the topic query and
 * ranks by cosine distance, then applies the exclude filter.
 */

import postgres from "postgres";
import type {
  CorpusPort,
  EmbeddingPort,
  Item,
  RankedItem,
  RerankEmbeddingPort,
  RetrieveOptions,
  TopicDefinition,
} from "../ports.ts";
import { buildTopicQuery, isExcluded } from "../ingestion/topic.ts";

type Sql = ReturnType<typeof postgres>;
type Json = Parameters<Sql["json"]>[0];

/**
 * Conservative starting floor for retrieval (P1: no result should be presented
 * as a match without clearing some bar). Deliberately loose rather than tight —
 * cutting too aggressively risks a new failure mode (real matches silently
 * dropped) that's just as dishonest as no floor at all. Tune empirically
 * against real queries (see historical-research-plan.md item 1); this has not
 * been tuned against bge-small-en-v1.5's actual similarity distribution.
 */
export const DEFAULT_MIN_SIMILARITY = 0.35;

/**
 * When a rerank embedder is configured, retrieveForAnalysis widens the local-
 * ANN candidate pool by this factor (capped at MAX_RERANK_POOL) before
 * reranking — the cheap local model's job at this stage is "don't miss a
 * real candidate," not "make the final call," so it gets room to be
 * imprecise. The final `k` results returned are still chosen by the rerank
 * score, not the local one.
 */
const RERANK_POOL_MULTIPLIER = 3;
/** Bounds a single run's rerank-tier cost regardless of how high `k` is set. */
const MAX_RERANK_POOL = 500;

/** pgvector text input form: `[0.1,0.2,...]`. */
function vectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

/** pgvector's `::text` cast is a JSON-shaped array literal, e.g. "[0.1,0.2,...]". */
function parseVectorText(v: unknown): number[] | null {
  return typeof v === "string" ? JSON.parse(v) as number[] : null;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function rowToItem(r: Record<string, unknown>): Item {
  return {
    id: r.id as string,
    source: r.source as Item["source"],
    source_id: r.source_id as string,
    author: (r.author as string | null) ?? null,
    text: r.text as string,
    url: r.url as string,
    created_at: r.created_at as Date,
    fetched_at: r.fetched_at as Date,
    engagement: (r.engagement as Record<string, number>) ?? {},
    parent_ref: (r.parent_ref as string | null) ?? null,
    embedding: null,
    raw: (r.raw as Record<string, unknown>) ?? {},
  };
}

export interface PgCorpusOptions {
  databaseUrl: string;
  embedder: EmbeddingPort;
  /**
   * Optional second, higher-quality embedding tier used only to rerank
   * retrieveForAnalysis's (already narrow) candidate pool — never the full
   * corpus. Omit to fall back to local-embedding-only scoring, unchanged
   * from before this existed.
   */
  rerankEmbedder?: RerankEmbeddingPort;
  /** Candidate pool pulled from the ANN index before post-filtering. */
  candidatePool?: number;
  /** Default minimum-similarity floor for retrieve/retrieveForAnalysis (per-call opts override it). */
  minSimilarity?: number;
}

export class PgCorpus implements CorpusPort {
  readonly #sql: Sql;
  readonly #embedder: EmbeddingPort;
  readonly #rerankEmbedder: RerankEmbeddingPort | undefined;
  readonly #pool: number;
  readonly #minSimilarity: number;

  constructor(opts: PgCorpusOptions) {
    this.#sql = postgres(opts.databaseUrl, { onnotice: () => {} });
    this.#embedder = opts.embedder;
    this.#rerankEmbedder = opts.rerankEmbedder;
    this.#pool = opts.candidatePool ?? 200;
    this.#minSimilarity = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  }

  /** Idempotent schema setup: pgvector extension, items table, indexes. */
  async init(): Promise<void> {
    const sql = this.#sql;
    const dims = this.#embedder.dimensions;
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    await sql`
      CREATE TABLE IF NOT EXISTS items (
        id          text PRIMARY KEY,
        source      text NOT NULL,
        source_id   text NOT NULL,
        author      text,
        text        text NOT NULL,
        url         text NOT NULL,
        created_at  timestamptz NOT NULL,
        fetched_at  timestamptz NOT NULL,
        engagement  jsonb NOT NULL DEFAULT '{}'::jsonb,
        parent_ref  text,
        embedding   vector(${sql.unsafe(String(dims))}),
        raw         jsonb NOT NULL DEFAULT '{}'::jsonb,
        ingested_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS items_source_uid ON items (source, source_id)`;
    await sql`
      CREATE INDEX IF NOT EXISTS items_embedding_hnsw
      ON items USING hnsw (embedding vector_cosine_ops)
    `;

    // Additive columns for existing deployments (idempotent — safe to run on
    // every startup, on both a fresh table and a live one). `model` records
    // provenance for the storage-tier embedding above; the analyzed_* trio
    // is the optional, sparse rerank-tier cache (never populated for most
    // rows — only items that actually became a real briefing's candidate).
    // `analyzed_embedding` is deliberately dimension-less: unlike `embedding`,
    // which is sized once at table-creation time to match the configured
    // local embedder, a rerank model can change (or its output dimension can,
    // e.g. Voyage's Matryoshka sizing) without a schema migration — a model
    // mismatch on read is just "stale, needs re-embedding," never corruption.
    await sql`ALTER TABLE items ADD COLUMN IF NOT EXISTS model text`;
    await sql`ALTER TABLE items ADD COLUMN IF NOT EXISTS analyzed_embedding vector`;
    await sql`ALTER TABLE items ADD COLUMN IF NOT EXISTS analyzed_model text`;
    await sql`ALTER TABLE items ADD COLUMN IF NOT EXISTS analyzed_at timestamptz`;
    // Backfill: every row embedded before this column existed was produced by
    // whatever the local embedder was at the time — which, to date, has only
    // ever been the currently configured one. A real future model swap
    // changes this backfill's premise, which is exactly why swaps must be an
    // explicit re-embed (see the comment above), not a casual config edit.
    await sql`
      UPDATE items SET model = ${this.#embedder.model}
      WHERE model IS NULL AND embedding IS NOT NULL
    `;
  }

  /** Append-only insert; duplicates (same stable id) are ignored. */
  async append(items: Item[]): Promise<void> {
    if (items.length === 0) return;

    const needing = items.filter((it) => !it.embedding);
    if (needing.length > 0) {
      const vecs = await this.#embedder.embed(needing.map((it) => it.text));
      needing.forEach((it, i) => (it.embedding = vecs[i]));
    }

    const sql = this.#sql;
    for (const it of items) {
      const emb = it.embedding ? vectorLiteral(it.embedding) : null;
      const model = it.embedding ? this.#embedder.model : null;
      await sql`
        INSERT INTO items (
          id, source, source_id, author, text, url,
          created_at, fetched_at, engagement, parent_ref, embedding, model, raw
        ) VALUES (
          ${it.id}, ${it.source}, ${it.source_id}, ${it.author}, ${it.text}, ${it.url},
          ${it.created_at}, ${it.fetched_at}, ${sql.json(it.engagement as Json)}, ${it.parent_ref},
          ${emb}::vector, ${model}, ${sql.json(it.raw as Json)}
        )
        ON CONFLICT (id) DO NOTHING
      `;
    }
  }

  /**
   * Semantic topic matching: embed the topic, pull the nearest candidates by
   * cosine distance, drop excluded items and anything that doesn't clear the
   * similarity floor (P1: never present a weak nearest-neighbor as a real
   * match), return the top `k` with scores.
   *
   * pgvector's `<=>` is cosine *distance*, so similarity = 1 - distance.
   */
  async retrieve(
    topic: TopicDefinition,
    k: number,
    opts: RetrieveOptions = {},
  ): Promise<RankedItem[]> {
    const floor = opts.minSimilarity ?? this.#minSimilarity;
    const qvec = await this.#embedder.embedQuery(buildTopicQuery(topic));
    const lit = vectorLiteral(qvec);
    const sql = this.#sql;
    const rows = await sql`
      SELECT id, source, source_id, author, text, url,
             created_at, fetched_at, engagement, parent_ref, raw,
             1 - (embedding <=> ${lit}::vector) AS similarity
      FROM items
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> ${lit}::vector
      LIMIT ${this.#pool}
    `;
    return rows
      .map((r) => {
        const row = r as unknown as Record<string, unknown>;
        return { item: rowToItem(row), similarity: Number(row.similarity) };
      })
      .filter((m) => !isExcluded(m.item, topic) && m.similarity >= floor)
      .slice(0, k);
  }

  /**
   * Like `retrieve`, but returns full `Item`s (embeddings populated, for the
   * analysis/clustering stage) paired with their topic similarity, so
   * downstream narratives can carry topic relevance (not just velocity).
   * Excludes are applied before any reranking (a hard keyword negative needs
   * no embedding to decide, and skipping it there is free rerank-cost
   * savings). The similarity floor is applied to whichever score is final —
   * the rerank tier's when configured, the local one otherwise.
   *
   * When a rerank embedder is configured, this pulls a wider local-ANN pool
   * (recall net — the cheap model's job here is "don't miss a candidate"),
   * reranks it with the higher-quality embedder, and returns the top `k` by
   * *that* score. Candidates already carrying a cached, model-matching
   * rerank vector skip re-embedding entirely — the whole point of caching it
   * on the item row is that a recurring story or a popular item never gets
   * sent to the rerank tier twice.
   */
  async retrieveForAnalysis(
    topic: TopicDefinition,
    k: number,
    opts: RetrieveOptions = {},
  ): Promise<RankedItem[]> {
    const floor = opts.minSimilarity ?? this.#minSimilarity;
    const qvec = await this.#embedder.embedQuery(buildTopicQuery(topic));
    const lit = vectorLiteral(qvec);
    const sql = this.#sql;
    const poolSize = this.#rerankEmbedder
      ? Math.min(Math.max(k * RERANK_POOL_MULTIPLIER, k), MAX_RERANK_POOL)
      : k;
    const rows = await sql`
      SELECT id, source, source_id, author, text, url,
             created_at, fetched_at, engagement, parent_ref, raw,
             embedding::text AS embedding,
             analyzed_embedding::text AS analyzed_embedding,
             analyzed_model,
             1 - (embedding <=> ${lit}::vector) AS similarity
      FROM items
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> ${lit}::vector
      LIMIT ${poolSize}
    `;
    const candidates = rows
      .map((r) => {
        const row = r as unknown as Record<string, unknown>;
        const item = rowToItem(row);
        item.embedding = parseVectorText(row.embedding);
        return {
          item,
          similarity: Number(row.similarity),
          analyzedEmbedding: parseVectorText(row.analyzed_embedding),
          analyzedModel: (row.analyzed_model as string | null) ?? null,
        };
      })
      .filter((m) => !isExcluded(m.item, topic));

    if (!this.#rerankEmbedder) {
      return candidates.filter((m) => m.similarity >= floor).slice(0, k);
    }
    const reranked = await this.#rerank(topic, candidates);
    return reranked.filter((m) => m.similarity >= floor).slice(0, k);
  }

  /**
   * Rerank a local-ANN candidate pool with the higher-quality embedder,
   * caching each freshly computed vector back onto its item row so it's
   * never re-embedded (this run, or any future one — see
   * retrieveForAnalysis's doc comment).
   */
  async #rerank(
    topic: TopicDefinition,
    candidates: {
      item: Item;
      similarity: number;
      analyzedEmbedding: number[] | null;
      analyzedModel: string | null;
    }[],
  ): Promise<RankedItem[]> {
    const rerankEmbedder = this.#rerankEmbedder!;
    const qvec = await rerankEmbedder.embedQuery(buildTopicQuery(topic));

    const stale = candidates.filter((c) => c.analyzedModel !== rerankEmbedder.model);
    if (stale.length > 0) {
      const vecs = await rerankEmbedder.embed(stale.map((c) => c.item.text));
      const at = new Date();
      const sql = this.#sql;
      for (let i = 0; i < stale.length; i++) {
        stale[i].analyzedEmbedding = vecs[i];
        await sql`
          UPDATE items
          SET analyzed_embedding = ${vectorLiteral(vecs[i])}::vector,
              analyzed_model = ${rerankEmbedder.model},
              analyzed_at = ${at}
          WHERE id = ${stale[i].item.id}
        `;
      }
    }

    return candidates
      .map((c) => ({ item: c.item, similarity: cosineSimilarity(qvec, c.analyzedEmbedding!) }))
      .sort((a, b) => b.similarity - a.similarity);
  }

  /** Test helper: wipe the corpus. */
  async clear(): Promise<void> {
    await this.#sql`TRUNCATE items`;
  }

  async close(): Promise<void> {
    await this.#sql.end();
  }
}
