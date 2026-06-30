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
  /**
   * Circling the empty space: how hard the *reachable* sources point at a blind
   * spot (TikTok/Instagram). Attention, not content — it augments the blind-spot
   * declaration, never replaces it. Present only for platforms with references.
   */
  blind_spot_signals?: BlindSpotSignal[];
}

/**
 * One reachable item pointing at a blind-spot platform — a link to a specific
 * target, or a bare textual mention. This is meta-evidence about *attention*,
 * never content we saw.
 */
export interface BlindSpotReference {
  /** "tiktok" | "instagram". */
  platform: string;
  /** Normalized URL of the referenced item (links), or null for a bare mention. */
  target: string | null;
  kind: "link" | "mention";
  /** The reachable item doing the referencing — provenance (P3). */
  item_id: string;
  source: Item["source"];
  url: string;
  created_at: Date;
}

/** Aggregated blind-spot pull for one platform on a topic. */
export interface BlindSpotSignal {
  platform: string;
  /** Distinct reachable items referencing it. */
  referencing_items: number;
  by_source: Record<string, number>;
  /** Reference counts split by kind. */
  links: number;
  mentions: number;
  /** Convergence: most-pointed-at targets (a shared video = a focal point). */
  top_targets: { target: string; mentions: number }[];
  /** Recent references/hour — is the blind-spot conversation accelerating? */
  references_per_hour: number;
  /** [oldest, newest] reference time, or [now, now] if none. */
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

/** A narrative cluster — items grouped by semantic similarity. */
export interface Cluster {
  id: string;
  item_ids: string[];
  /** Mean (then normalized) embedding of the cluster's items. */
  centroid: number[];
  /** Short LLM-generated description; empty until labeled. */
  label: string;
  first_seen: Date;
  /** Items/hour over the recent window — the "is it happening?" signal (P5). */
  velocity: number;
  size: number;
}

/** Evidence type for an extracted claim (P4: separate verifiable from asserted). */
export type EvidenceType = "primary_record" | "reported" | "opinion" | "unsourced";

/** A discrete factual assertion pulled from the corpus, with its evidence type. */
export interface Claim {
  id: string;
  text: string;
  cluster_id: string;
  evidence_type: EvidenceType;
  supporting_item_ids: string[];
  /** Where a human could check it (e.g. "FEC.gov"); null if none suggested. */
  verify_hint: string | null;
}

/** What the LLM returns per item before we assign ids / link to clusters. */
export interface ExtractedClaim {
  text: string;
  evidence_type: EvidenceType;
  verify_hint: string | null;
}

export interface LLMPort {
  /**
   * Per-item claim extraction (Haiku, batched + prompt-cached). Returns the
   * claims found in each input item, index-aligned with `items` (empty array
   * for items with no checkable claim). Ingested text is untrusted data, never
   * instructions.
   */
  extractClaims(items: Item[]): Promise<ExtractedClaim[][]>;
  /** Short neutral narrative label for a cluster, from representative texts. */
  labelCluster(texts: string[]): Promise<string>;
  /** Final synthesis (Sonnet/Opus) — description + evidence only, never a verdict (P2). */
  synthesize(prompt: string): Promise<string>;
}
