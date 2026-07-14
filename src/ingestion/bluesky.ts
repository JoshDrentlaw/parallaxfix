/**
 * Bluesky adapters — two modes over the same source, for two different jobs:
 *
 *   - `BlueskyJetstreamAdapter`: the keystone (free, keyless, open firehose).
 *     Connects to Jetstream (simplified JSON over WebSocket), filters to
 *     `app.bsky.feed.post` create events, and normalizes them. Live-only by
 *     construction — it sees only what streams by while it's connected, so it
 *     cannot reach a multi-year-old post (see historical-research-plan.md item 4).
 *   - `BlueskySearchAdapter`: `app.bsky.feed.searchPosts`, a keyword + date-range
 *     REST search over the AppView's index. Pull-based, historical-capable —
 *     the second adapter mode the plan calls for, used alongside (not instead
 *     of) Jetstream for historical-research runs.
 *
 * Both implement `SourcePort`; the core never sees a WebSocket or an XRPC call.
 *
 * Jetstream docs: https://github.com/bluesky-social/jetstream
 * searchPosts lexicon: https://docs.bsky.app/docs/api/app-bsky-feed-search-posts
 */

import type { Item, SourcePort, TopicDefinition } from "../ports.ts";
import {
  asObject,
  asString,
  type JetstreamCommit,
  type JetstreamEvent,
  normalizeFeedPost,
  stableId,
} from "./normalize.ts";
import { buildTopicQuery, matchesTopic } from "./topic.ts";

/** Public Jetstream instances (pick one; they mirror the same firehose). */
export const JETSTREAM_HOSTS = [
  "jetstream2.us-east.bsky.network",
  "jetstream1.us-east.bsky.network",
  "jetstream2.us-west.bsky.network",
  "jetstream1.us-west.bsky.network",
] as const;

export interface BlueskyOptions {
  /** Jetstream host to connect to. Defaults to a us-east instance. */
  host?: string;
  /** Collections to subscribe to. Defaults to feed posts only. */
  wantedCollections?: string[];
  /** Cancellation: abort to close the socket and end the stream. */
  signal?: AbortSignal;
}

export class BlueskyJetstreamAdapter implements SourcePort {
  readonly name = "bluesky" as const;

  readonly #host: string;
  readonly #collections: string[];
  readonly #signal?: AbortSignal;

  constructor(opts: BlueskyOptions = {}) {
    this.#host = opts.host ?? JETSTREAM_HOSTS[0];
    this.#collections = opts.wantedCollections ?? ["app.bsky.feed.post"];
    this.#signal = opts.signal;
  }

  /** Build the subscribe URL, optionally replaying from `since` via cursor. */
  url(since?: Date): string {
    const params = new URLSearchParams();
    for (const c of this.#collections) params.append("wantedCollections", c);
    // Jetstream cursor is unix microseconds; `since` is ms.
    if (since) params.set("cursor", String(since.getTime() * 1000));
    return `wss://${this.#host}/subscribe?${params.toString()}`;
  }

  async *fetch(topic: TopicDefinition, since?: Date): AsyncIterable<Item> {
    const ws = new WebSocket(this.url(since));

    // Bridge the event-driven socket to an async iterator via a queue.
    const queue: Item[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    let failure: Error | null = null;

    const ping = () => {
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    };

    ws.onmessage = (ev: MessageEvent) => {
      try {
        const data = typeof ev.data === "string" ? ev.data : "";
        if (!data) return;
        const parsed = JSON.parse(data) as JetstreamEvent;
        if (parsed.kind !== "commit") return; // ignore identity/account events
        const item = normalizeFeedPost(parsed as JetstreamCommit);
        if (item && matchesTopic(item, topic)) {
          queue.push(item);
          ping();
        }
      } catch {
        // Untrusted input: drop malformed frames, never break the stream.
      }
    };
    ws.onclose = () => {
      closed = true;
      ping();
    };
    ws.onerror = () => {
      failure = new Error(`Jetstream connection error (${this.#host})`);
      closed = true;
      ping();
    };

    const onAbort = () => {
      try {
        ws.close();
      } catch { /* already closing */ }
    };
    this.#signal?.addEventListener("abort", onAbort, { once: true });

    try {
      while (true) {
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        if (closed) break;
        await new Promise<void>((resolve) => (wake = resolve));
      }
      if (failure && !this.#signal?.aborted) throw failure;
    } finally {
      this.#signal?.removeEventListener("abort", onAbort);
      try {
        ws.close();
      } catch { /* noop */ }
    }
  }
}

// ── BlueskySearchAdapter (app.bsky.feed.searchPosts) ───────────────────────────

/** Public, keyless AppView host — no credentials needed for a basic search. */
export const BSKY_PUBLIC_APPVIEW = "public.api.bsky.app";
const SEARCH_PATH = "/xrpc/app.bsky.feed.searchPosts";

/**
 * One post from `searchPosts`'s response (`app.bsky.feed.defs#postView`,
 * fields we use). `record` carries the same `app.bsky.feed.post` shape
 * Jetstream commits do (text/createdAt/reply), so it reads the same way.
 */
export interface BskySearchPost {
  uri?: string;
  cid?: string;
  author?: { did?: string; handle?: string };
  record?: unknown;
  indexedAt?: string;
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  quoteCount?: number;
}

const AT_URI_RE = /^at:\/\/([^/]+)\/[^/]+\/([^/]+)$/;

/**
 * Normalize a `searchPosts` result into an `Item`. The (did, rkey) pulled from
 * the at:// URI match Jetstream's `stableId` key exactly, so the same
 * real-world post reached via either adapter dedupes to one row (P1: an
 * append-only corpus, not two copies of the same thing).
 */
export function normalizeSearchPost(p: BskySearchPost): Item | null {
  const m = p.uri?.match(AT_URI_RE);
  if (!m) return null;
  const [, did, rkey] = m;

  const record = asObject(p.record);
  const text = asString(record?.text) ?? "";

  const createdAtRaw = asString(record?.createdAt);
  const indexedAtRaw = p.indexedAt;
  const created_at = createdAtRaw && !Number.isNaN(Date.parse(createdAtRaw))
    ? new Date(createdAtRaw)
    : indexedAtRaw && !Number.isNaN(Date.parse(indexedAtRaw))
    ? new Date(indexedAtRaw)
    : new Date();

  const reply = asObject(record?.reply);
  const parent = reply ? asObject(reply.parent) : undefined;
  const parent_ref = parent ? (asString(parent.uri) ?? null) : null;

  const sourceId = `${did}/${rkey}`;
  return {
    id: stableId("bluesky", sourceId),
    source: "bluesky",
    source_id: sourceId,
    // searchPosts (unlike a Jetstream commit) carries the handle directly —
    // no separate DID-doc resolution needed for a readable author.
    author: p.author?.handle ?? p.author?.did ?? did,
    text,
    url: `https://bsky.app/profile/${did}/post/${rkey}`,
    created_at,
    fetched_at: new Date(),
    engagement: {
      likes: p.likeCount ?? 0,
      reposts: p.repostCount ?? 0,
      replies: p.replyCount ?? 0,
      quotes: p.quoteCount ?? 0,
    },
    parent_ref,
    embedding: null,
    raw: p as unknown as Record<string, unknown>,
  };
}

/**
 * Build the `searchPosts` query params — pure and network-free so the
 * date-range/sort behavior is directly testable.
 */
export function bskySearchParams(
  topic: TopicDefinition,
  opts: { sort: "top" | "latest"; since?: Date; until?: Date; limit: number },
): URLSearchParams {
  const params = new URLSearchParams({
    q: buildTopicQuery(topic),
    sort: opts.sort,
    limit: String(opts.limit),
  });
  if (opts.since) params.set("since", opts.since.toISOString());
  if (opts.until) params.set("until", opts.until.toISOString());
  return params;
}

export interface BlueskySearchOptions {
  /** AppView host to query. Defaults to the public, keyless AppView. */
  host?: string;
  /** Optional Bearer token (e.g. an authenticated session) for higher rate limits. */
  accessToken?: string;
  /** "latest" (default) or "top" (engagement-ranked). */
  sort?: "top" | "latest";
  /** Inclusive lower bound on post time — the historical-research use case. */
  since?: Date;
  /** Exclusive upper bound on post time. */
  until?: Date;
  /** Page size, 1-100. */
  limit?: number;
  /** Overall cap across pages, so a broad query can't page forever. */
  maxResults?: number;
}

/**
 * Historical/keyword search over Bluesky via `app.bsky.feed.searchPosts` —
 * the second adapter mode historical-research-plan.md item 4 calls for.
 * Jetstream is fundamentally live-only (it only sees what streams by while
 * connected); this adapter reaches backward instead, at the cost of being a
 * pull-based keyword search rather than a live firehose.
 *
 * NOTE: built against the documented AT Protocol lexicon, not re-verified
 * against the live endpoint from this environment (egress to
 * public.api.bsky.app is blocked by this sandbox's network policy) — confirm
 * the actual response shape and rate limits against a real query before
 * relying on this in production, per the plan's own "don't assume" instruction.
 */
export class BlueskySearchAdapter implements SourcePort {
  readonly name = "bluesky" as const;
  readonly #host: string;
  readonly #accessToken: string | null;
  readonly #sort: "top" | "latest";
  readonly #since: Date | null;
  readonly #until: Date | null;
  readonly #limit: number;
  readonly #maxResults: number;

  constructor(opts: BlueskySearchOptions = {}) {
    this.#host = opts.host ?? BSKY_PUBLIC_APPVIEW;
    this.#accessToken = opts.accessToken ?? Deno.env.get("BLUESKY_ACCESS_TOKEN") ?? null;
    this.#sort = opts.sort ?? "latest";
    this.#since = opts.since ?? null;
    this.#until = opts.until ?? null;
    this.#limit = Math.min(Math.max(opts.limit ?? 100, 1), 100);
    this.#maxResults = opts.maxResults ?? 500;
  }

  async *fetch(topic: TopicDefinition): AsyncIterable<Item> {
    let cursor: string | undefined;
    let yielded = 0;

    do {
      const params = bskySearchParams(topic, {
        sort: this.#sort,
        since: this.#since ?? undefined,
        until: this.#until ?? undefined,
        limit: this.#limit,
      });
      if (cursor) params.set("cursor", cursor);

      const res = await fetch(`https://${this.#host}${SEARCH_PATH}?${params}`, {
        headers: this.#accessToken ? { authorization: `Bearer ${this.#accessToken}` } : {},
      });
      if (!res.ok) throw new Error(`Bluesky search ${res.status} ${res.statusText}`);

      const json = await res.json() as { posts?: BskySearchPost[]; cursor?: string };
      for (const p of json.posts ?? []) {
        const item = normalizeSearchPost(p);
        if (item) {
          yield item;
          if (++yielded >= this.#maxResults) return;
        }
      }
      cursor = json.cursor;
    } while (cursor);
  }
}
