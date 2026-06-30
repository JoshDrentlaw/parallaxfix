/**
 * Ports (hexagonal architecture). The core pipeline depends only on these
 * interfaces; concrete adapters (Bluesky, Reddit, GDELT, RSS, X; SQLite/pgvector;
 * local/hosted embeddings; Claude) implement them and are wired at the edges.
 *
 * Bounded contexts: ingestion / corpus / analysis / briefing.
 * The normalized `Item` is the lingua franca between stages.
 */

export interface Item {
  /** stable hash of (source, source_id) */
  id: string;
  source: "bluesky" | "reddit" | "gdelt" | "rss" | "x";
  source_id: string;
  author: string | null;
  text: string;
  /** permalink to the original — provenance (P3) */
  url: string;
  created_at: Date;
  fetched_at: Date;
  engagement: Record<string, number>;
  parent_ref: string | null;
  embedding: number[] | null;
  /** original payload, for debugging/reprocessing */
  raw: Record<string, unknown>;
}

export interface TopicDefinition {
  id: string;
  keywords: string[];
  entities: string[];
  description: string;
  exclude: string[];
  /** Optional per-topic RSS feed URLs (e.g. a local outlet GDELT misses). */
  feeds?: string[];
}

/** P1 made concrete: what a run did and did not look at. */
export interface CoverageReport {
  topic_id: string;
  run_at: Date;
  /** Sources actually queried this run. */
  sources_queried: string[];
  /** Item count contributed by each queried source. */
  items_per_source: Record<string, number>;
  /** Sources we could not see, with reasons (includes the declared blind spots). */
  sources_unavailable: { source: string; reason: string }[];
  /** [oldest, newest] created_at across the items, or [run_at, run_at] if empty. */
  window: [Date, Date];
}

/** A source of raw events. Knows about a vendor; knows nothing about clustering. */
export interface SourcePort {
  readonly name: Item["source"];
  /**
   * Stream/poll normalized items for a topic. `since` is an optional lower
   * bound on event time (e.g. a firehose cursor or a poll watermark); omit it
   * to start from "now". Lifecycle (cancellation) is owned by the adapter,
   * typically via an AbortSignal passed at construction.
   */
  fetch(topic: TopicDefinition, since?: Date): AsyncIterable<Item>;
}

/** An item plus how close it sits to the topic, for ranked retrieval. */
export interface RankedItem {
  item: Item;
  /** Cosine similarity in [-1, 1]; ~1 = very close in meaning, ~0 = unrelated. */
  similarity: number;
}

/** Storage + retrieval. Knows about Items and vectors; nothing about sources. */
export interface CorpusPort {
  append(items: Item[]): Promise<void>;
  /** semantic topic matching: nearest items to the topic embedding, ranked */
  retrieve(topic: TopicDefinition, k: number): Promise<RankedItem[]>;
}

export interface EmbeddingPort {
  /** Vector length this embedder produces (must match the DB vector column). */
  readonly dimensions: number;
  /** Embed documents/items for storage. */
  embed(texts: string[]): Promise<number[][]>;
  /** Embed a search query; models like bge prepend a retrieval instruction. */
  embedQuery(text: string): Promise<number[]>;
}

export interface LLMPort {
  /** structured per-item extraction (Haiku, batched + cached) */
  extract(prompt: string, items: Item[]): Promise<unknown[]>;
  /** final synthesis (Sonnet/Opus) — description + evidence only, never a verdict (P2) */
  synthesize(prompt: string): Promise<string>;
}
