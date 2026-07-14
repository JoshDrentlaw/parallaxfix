/**
 * Reddit adapter — free tier, **non-commercial/research only**, pull-based
 * (poll, no webhooks). Read-only; never posts.
 *
 * Reddit access in 2026 is a degradation ladder, and this adapter walks it:
 *
 *   1. **OAuth** (app-only client_credentials → search endpoint) when
 *      REDDIT_CLIENT_ID/SECRET are configured. Self-service key registration
 *      closed in Nov 2025 (Responsible Builder Policy); credentials issued
 *      before then keep working, new ones need manual approval.
 *   2. **Public RSS** (keyless) otherwise. Reddit's `.rss` listing/search
 *      feeds predate the priced API surface and still work without auth —
 *      unlike the public `.json` mirrors, which started returning 403 in May
 *      2026. The feeds are live (same content as the site, newest-first) but
 *      thinner: no score/comment counts, and they are rate-limited per IP,
 *      so poll gently.
 *   3. **Neither reachable** → `fetch` throws a clear error so the
 *      orchestrator records Reddit as a coverage gap (P1) rather than crash.
 */

import { parseFeed } from "@mikaelporttila/rss";
import type { Item, SourcePort, TopicDefinition } from "../ports.ts";
import { stableId } from "./normalize.ts";

/** Shape of a Reddit listing child's `data` (subset we use). */
export interface RedditPostData {
  id: string;
  name?: string; // fullname, e.g. t3_abc
  author?: string;
  title?: string;
  selftext?: string;
  permalink?: string;
  created_utc?: number; // seconds
  subreddit?: string;
  score?: number;
  num_comments?: number;
  ups?: number;
}

export function normalizeRedditPost(d: RedditPostData): Item | null {
  if (!d.id) return null;
  const text = [d.title, d.selftext].filter(Boolean).join("\n\n").trim();
  const permalink = d.permalink
    ? `https://www.reddit.com${d.permalink}`
    : `https://redd.it/${d.id}`;
  return {
    id: stableId("reddit", d.id),
    source: "reddit",
    source_id: d.id,
    author: d.author ?? null,
    text,
    url: permalink,
    created_at: new Date((d.created_utc ?? 0) * 1000),
    fetched_at: new Date(),
    engagement: {
      score: d.score ?? d.ups ?? 0,
      comments: d.num_comments ?? 0,
    },
    parent_ref: null,
    embedding: null,
    raw: d as unknown as Record<string, unknown>,
  };
}

/** One entry from Reddit's public Atom feeds (parser-agnostic subset). */
export interface RedditFeedEntry {
  /** Atom id — Reddit uses the fullname, e.g. "t3_abc123". */
  id?: string;
  title?: string;
  /** HTML body; Reddit appends a "submitted by /u/x [link] [comments]" footer. */
  contentHtml?: string;
  /** Permalink, e.g. https://www.reddit.com/r/sub/comments/abc123/slug/ */
  link?: string;
  /** Reddit formats it "/u/someuser". */
  authorName?: string;
  published?: Date;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Normalize an entry from the keyless `.rss` surface. Same provenance as the
 * OAuth path (permalink, author, timestamp); engagement is empty because the
 * feeds carry no score/comment counts — absent, not zero.
 */
export function normalizeRedditFeedEntry(e: RedditFeedEntry): Item | null {
  const link = e.link;
  // Fullname "t3_abc123" → "abc123", or recover the id from the permalink.
  const sourceId = e.id?.replace(/^t\d+_/, "") ||
    link?.match(/\/comments\/([a-z0-9]+)/i)?.[1];
  if (!sourceId || !link) return null;

  const body = e.contentHtml ? stripHtml(e.contentHtml) : "";
  const text = [e.title?.trim(), body.replace(/submitted by\s+\/?u\/\S+.*$/i, "").trim()]
    .filter(Boolean)
    .join("\n\n")
    .trim();

  return {
    id: stableId("reddit", sourceId),
    source: "reddit",
    source_id: sourceId,
    author: e.authorName?.replace(/^\/?u\//, "") ?? null,
    text,
    url: link,
    created_at: e.published ?? new Date(),
    fetched_at: new Date(),
    engagement: {},
    parent_ref: null,
    embedding: null,
    raw: e as unknown as Record<string, unknown>,
  };
}

/**
 * Reddit search wants short keyword queries, not the natural-language topic
 * description the embedder uses. OR the keywords/entities (quoting phrases);
 * fall back to the description only when there is nothing else.
 */
export function redditSearchQuery(topic: TopicDefinition): string {
  const terms = [...topic.keywords, ...topic.entities]
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (/\s/.test(t) ? `"${t}"` : t));
  return terms.join(" OR ") || topic.description || topic.id;
}

export interface RedditCredentials {
  clientId: string;
  clientSecret: string;
  userAgent?: string;
}

/** Pull credentials from the environment, or null if unset. */
export function redditCredentialsFromEnv(): RedditCredentials | null {
  const clientId = Deno.env.get("REDDIT_CLIENT_ID");
  const clientSecret = Deno.env.get("REDDIT_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    userAgent: Deno.env.get("REDDIT_USER_AGENT") ?? "parallax-fix/0.1 (research)",
  };
}

/** Reddit search's `sort` values this adapter uses. */
export type RedditSort = "new" | "relevance";
/** Reddit search's `t` (time) window; "all" is the only way past the live-recency default. */
export type RedditTime = "all" | "hour" | "day" | "week" | "month" | "year";

export interface RedditOptions {
  credentials?: RedditCredentials | null;
  limit?: number;
  /**
   * "new" (default) is recency-biased — every result is the newest match,
   * which is exactly why a multi-year-old thread doesn't surface. "relevance"
   * ranks by match quality instead, for historical-research runs (see
   * historical-research-plan.md item 3).
   */
  sort?: RedditSort;
  /** Reddit's `t` time filter. Only meaningful (and only sent) when set explicitly. */
  time?: RedditTime;
}

/**
 * Build the `search`/`.rss` query params shared by both access rungs — pure
 * and network-free so the sort/time behavior is directly testable. `type` is
 * OAuth-only (the public RSS surface has no equivalent param).
 */
export function redditSearchParams(
  topic: TopicDefinition,
  opts: { limit: number; sort: RedditSort; time: RedditTime | null; type?: "link" },
): URLSearchParams {
  const params = new URLSearchParams({
    q: redditSearchQuery(topic),
    limit: String(opts.limit),
    sort: opts.sort,
  });
  if (opts.type) params.set("type", opts.type);
  if (opts.time) params.set("t", opts.time);
  return params;
}

export class RedditAdapter implements SourcePort {
  readonly name = "reddit" as const;
  readonly #creds: RedditCredentials | null;
  readonly #limit: number;
  readonly #userAgent: string;
  readonly #sort: RedditSort;
  readonly #time: RedditTime | null;

  constructor(opts: RedditOptions = {}) {
    this.#creds = opts.credentials ?? redditCredentialsFromEnv();
    this.#limit = opts.limit ?? 50;
    this.#userAgent = this.#creds?.userAgent ?? "parallax-fix/0.1 (research)";
    this.#sort = opts.sort ?? "new";
    this.#time = opts.time ?? null;
  }

  /** Which rung of the access ladder this process will use. */
  mode(): "oauth" | "public-rss" {
    return this.#creds ? "oauth" : "public-rss";
  }

  async #token(creds: RedditCredentials): Promise<string> {
    const basic = btoa(`${creds.clientId}:${creds.clientSecret}`);
    const res = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        "authorization": `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": this.#userAgent,
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`Reddit auth ${res.status} ${res.statusText}`);
    const json = await res.json() as { access_token?: string };
    if (!json.access_token) throw new Error("Reddit auth returned no access_token");
    return json.access_token;
  }

  async *#fetchOauth(creds: RedditCredentials, topic: TopicDefinition): AsyncIterable<Item> {
    const token = await this.#token(creds);
    const params = redditSearchParams(topic, {
      limit: this.#limit,
      sort: this.#sort,
      time: this.#time,
      type: "link",
    });
    const res = await fetch(`https://oauth.reddit.com/search?${params}`, {
      headers: {
        "authorization": `Bearer ${token}`,
        "user-agent": this.#userAgent,
      },
    });
    if (!res.ok) throw new Error(`Reddit search ${res.status} ${res.statusText}`);

    const json = await res.json() as { data?: { children?: { data: RedditPostData }[] } };
    for (const child of json.data?.children ?? []) {
      const item = normalizeRedditPost(child.data);
      if (item) yield item;
    }
  }

  async *#fetchPublicRss(topic: TopicDefinition): AsyncIterable<Item> {
    const params = redditSearchParams(topic, {
      limit: this.#limit,
      sort: this.#sort,
      time: this.#time,
    });
    const res = await fetch(`https://www.reddit.com/search.rss?${params}`, {
      headers: { "user-agent": this.#userAgent },
    });
    if (res.status === 403 || res.status === 429) {
      throw new Error(
        `Reddit public RSS refused (${res.status}) — keyless feeds are rate-limited per IP; ` +
          "back off, or configure REDDIT_CLIENT_ID/SECRET (pre-Nov-2025 OAuth creds still work)",
      );
    }
    if (!res.ok) throw new Error(`Reddit public RSS ${res.status} ${res.statusText}`);

    const feed = await parseFeed(await res.text());
    for (const entry of feed.entries ?? []) {
      const item = normalizeRedditFeedEntry({
        id: entry.id,
        title: entry.title?.value,
        contentHtml: entry.content?.value ?? entry.description?.value,
        link: entry.links?.[0]?.href,
        authorName: entry.author?.name,
        published: entry.published ?? entry.updated,
      });
      if (item) yield item;
    }
  }

  async *fetch(topic: TopicDefinition): AsyncIterable<Item> {
    if (this.#creds) {
      yield* this.#fetchOauth(this.#creds, topic);
    } else {
      yield* this.#fetchPublicRss(topic);
    }
  }
}
