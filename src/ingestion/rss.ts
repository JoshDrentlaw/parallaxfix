/**
 * RSS/Atom adapter — per-outlet feeds, including local papers GDELT misses.
 * Pull-based: fetch each configured feed, normalize entries to Items.
 *
 * Feeds come from the adapter options or `topic.feeds`. With none configured,
 * `fetch` throws so the orchestrator records RSS as a coverage gap (P1).
 */

import { parseFeed } from "@mikaelporttila/rss";
import type { Item, SourcePort, TopicDefinition } from "../ports.ts";
import { stableId } from "./normalize.ts";

/** Minimal, parser-agnostic shape we normalize from. */
export interface RssEntryLike {
  id?: string;
  title?: string;
  description?: string;
  /**
   * Full article body, when the feed provides one (RSS `content:encoded` /
   * Atom `<content>`) — distinct from `description`, which by RSS/Atom
   * convention is a short teaser. Preferred over `description` when present:
   * many publishers (NPR, ProPublica, and plenty of smaller/nonprofit
   * newsrooms among them) syndicate the full piece here, and using only the
   * teaser was leaving that on the table for no reason — not every feed
   * offers it (most paywalled outlets keep this field empty on purpose), so
   * this is a strict improvement, never a regression.
   */
  content?: string;
  link?: string;
  published?: Date;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

export function normalizeRssEntry(e: RssEntryLike, feedTitle: string): Item | null {
  const url = e.link;
  if (!url) return null;
  const sourceId = e.id || url;
  const body = e.content || e.description;
  const text = [e.title?.trim(), body ? stripHtml(body) : ""]
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return {
    id: stableId("rss", sourceId),
    source: "rss",
    source_id: sourceId,
    author: feedTitle || null, // outlet name carries provenance (P3)
    text,
    url,
    created_at: e.published ?? new Date(),
    fetched_at: new Date(),
    engagement: {},
    parent_ref: null,
    embedding: null,
    raw: e as unknown as Record<string, unknown>,
  };
}

/** Result of checking a candidate feed URL before it's added to a topic. */
export type FeedValidationResult =
  | {
    ok: true;
    title: string;
    entryCount: number;
    /** A few recent entries, so a human can eyeball that this is the right feed. */
    preview: { title: string; link: string; published: string | null }[];
  }
  | { ok: false; reason: string };

export interface ValidateFeedOptions {
  /** How many entries to include in the preview. */
  previewCount?: number;
  /** Abort the fetch after this many ms. */
  timeoutMs?: number;
}

/**
 * Fetch + parse a candidate feed URL and report back what a human needs to
 * decide whether it's the right feed: valid RSS/Atom, has entries, a title,
 * and a preview. Never throws — every failure mode (bad URL, unreachable,
 * non-2xx, not XML, no entries) comes back as a structured `{ ok: false,
 * reason }`, the same "say so plainly" spirit as the rest of the app (P1).
 */
export async function validateRssFeed(
  url: string,
  opts: ValidateFeedOptions = {},
): Promise<FeedValidationResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "only http(s) feed URLs are supported" };
  }

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "user-agent": "parallax-fix/0.1 (research)" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch (err) {
    return {
      ok: false,
      reason: `could not reach the feed (${err instanceof Error ? err.message : err})`,
    };
  }
  if (!res.ok) {
    await res.body?.cancel();
    return { ok: false, reason: `feed returned ${res.status} ${res.statusText}` };
  }

  const xml = await res.text();
  let feed: Awaited<ReturnType<typeof parseFeed>>;
  try {
    feed = await parseFeed(xml);
  } catch {
    return { ok: false, reason: "response is not valid RSS/Atom XML" };
  }

  const entries = feed.entries ?? [];
  if (entries.length === 0) {
    return { ok: false, reason: "feed parsed but has no entries" };
  }

  return {
    ok: true,
    title: feed.title?.value ?? url,
    entryCount: entries.length,
    preview: entries.slice(0, opts.previewCount ?? 3).map((e) => ({
      title: e.title?.value ?? "(untitled)",
      link: e.links?.[0]?.href ?? "",
      published: (e.published ?? e.updated)?.toISOString() ?? null,
    })),
  };
}

export interface RssOptions {
  feeds?: string[];
}

export class RssAdapter implements SourcePort {
  readonly name = "rss" as const;
  readonly #feeds: string[];

  constructor(opts: RssOptions = {}) {
    this.#feeds = opts.feeds ?? [];
  }

  async *fetch(topic: TopicDefinition): AsyncIterable<Item> {
    const feeds = this.#feeds.length ? this.#feeds : (topic.feeds ?? []);
    if (feeds.length === 0) throw new Error("no RSS feeds configured for this topic");

    for (const feedUrl of feeds) {
      let xml: string;
      try {
        const res = await fetch(feedUrl, {
          headers: { "user-agent": "parallax-fix/0.1 (research)" },
        });
        if (!res.ok) continue; // one bad feed shouldn't sink the rest
        xml = await res.text();
      } catch {
        continue;
      }

      let feed;
      try {
        feed = await parseFeed(xml);
      } catch {
        continue;
      }

      const feedTitle = feed.title?.value ?? feedUrl;
      for (const entry of feed.entries ?? []) {
        const item = normalizeRssEntry({
          id: entry.id,
          title: entry.title?.value,
          description: entry.description?.value,
          content: entry.content?.value,
          link: entry.links?.[0]?.href,
          published: entry.published ?? entry.updated,
        }, feedTitle);
        if (item) yield item;
      }
    }
  }
}
