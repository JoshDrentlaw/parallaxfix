/**
 * Corpus store (CorpusPort) — Postgres + pgvector.
 *
 * One database holds the append-only event log (the `items` table) and the
 * embedding index (a `vector` column with an HNSW cosine index). Chosen over
 * the SQLite MVP because Hand Terminal is headed for a multi-user hosted
 * deployment: a client-server DB gives concurrent writes, durability, and a
 * single store for app data + vectors.
 *
 * The Corpus owns embeddings (per the bounded-context split): `append` embeds
 * any item that arrives without a vector; `retrieve` embeds the topic query and
 * ranks by cosine distance, then applies the exclude filter.
 */

import postgres from "postgres";
import type { CorpusPort, EmbeddingPort, Item, RankedItem, TopicDefinition } from "../ports.ts";
import { buildTopicQuery, isExcluded } from "../ingestion/topic.ts";

type Sql = ReturnType<typeof postgres>;
type Json = Parameters<Sql["json"]>[0];

/** pgvector text input form: `[0.1,0.2,...]`. */
function vectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
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
  /** Candidate pool pulled from the ANN index before post-filtering. */
  candidatePool?: number;
}

export class PgCorpus implements CorpusPort {
  readonly #sql: Sql;
  readonly #embedder: EmbeddingPort;
  readonly #pool: number;

  constructor(opts: PgCorpusOptions) {
    this.#sql = postgres(opts.databaseUrl, { onnotice: () => {} });
    this.#embedder = opts.embedder;
    this.#pool = opts.candidatePool ?? 200;
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
      await sql`
        INSERT INTO items (
          id, source, source_id, author, text, url,
          created_at, fetched_at, engagement, parent_ref, embedding, raw
        ) VALUES (
          ${it.id}, ${it.source}, ${it.source_id}, ${it.author}, ${it.text}, ${it.url},
          ${it.created_at}, ${it.fetched_at}, ${sql.json(it.engagement as Json)}, ${it.parent_ref},
          ${emb}::vector, ${sql.json(it.raw as Json)}
        )
        ON CONFLICT (id) DO NOTHING
      `;
    }
  }

  /**
   * Semantic topic matching: embed the topic, pull the nearest candidates by
   * cosine distance, drop excluded items, return the top `k` with scores.
   *
   * pgvector's `<=>` is cosine *distance*, so similarity = 1 - distance.
   */
  async retrieve(topic: TopicDefinition, k: number): Promise<RankedItem[]> {
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
      .filter((m) => !isExcluded(m.item, topic))
      .slice(0, k);
  }

  /** Test helper: wipe the corpus. */
  async clear(): Promise<void> {
    await this.#sql`TRUNCATE items`;
  }

  async close(): Promise<void> {
    await this.#sql.end();
  }
}
