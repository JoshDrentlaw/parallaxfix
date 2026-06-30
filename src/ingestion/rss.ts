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
  const text = [e.title?.trim(), e.description ? stripHtml(e.description) : ""]
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
          link: entry.links?.[0]?.href,
          published: entry.published ?? entry.updated,
        }, feedTitle);
        if (item) yield item;
      }
    }
  }
}
