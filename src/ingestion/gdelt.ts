/**
 * GDELT adapter — the "coalesce news" half. Open Doc 2.0 query API, no key.
 * Pull-based: one query per fetch, yields article Items.
 *
 * https://api.gdeltproject.org/api/v2/doc/doc
 */

import type { Item, SourcePort, TopicDefinition } from "../ports.ts";
import { buildTopicQuery } from "./topic.ts";
import { stableId } from "./normalize.ts";

const GDELT_DOC_API = "https://api.gdeltproject.org/api/v2/doc/doc";

/** One article from GDELT's ArtList JSON (fields are best-effort/optional). */
export interface GdeltArticle {
  url?: string;
  title?: string;
  domain?: string;
  seendate?: string; // "20260629T120000Z"
  language?: string;
  sourcecountry?: string;
}

/** Parse GDELT's compact "YYYYMMDDTHHMMSSZ" timestamp. */
function parseSeendate(s: string | undefined): Date {
  const m = s?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return new Date();
  const [, y, mo, d, h, mi, se] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se));
}

export function normalizeGdeltArticle(a: GdeltArticle): Item | null {
  const url = a.url;
  if (!url) return null;
  return {
    id: stableId("gdelt", url),
    source: "gdelt",
    source_id: url,
    author: a.domain ?? null, // outlet domain; GDELT has no byline
    text: (a.title ?? "").trim(),
    url,
    created_at: parseSeendate(a.seendate),
    fetched_at: new Date(),
    engagement: {},
    parent_ref: null,
    embedding: null,
    raw: a as unknown as Record<string, unknown>,
  };
}

export interface GdeltOptions {
  maxRecords?: number;
  /** Timespan window, GDELT syntax (e.g. "1d", "12h"). */
  timespan?: string;
}

export class GdeltAdapter implements SourcePort {
  readonly name = "gdelt" as const;
  readonly #maxRecords: number;
  readonly #timespan: string;

  constructor(opts: GdeltOptions = {}) {
    this.#maxRecords = opts.maxRecords ?? 75;
    this.#timespan = opts.timespan ?? "1d";
  }

  async *fetch(topic: TopicDefinition): AsyncIterable<Item> {
    const params = new URLSearchParams({
      query: buildTopicQuery(topic),
      mode: "ArtList",
      format: "json",
      maxrecords: String(this.#maxRecords),
      timespan: this.#timespan,
      sort: "datedesc",
    });
    const res = await fetch(`${GDELT_DOC_API}?${params}`, {
      headers: { "user-agent": "hand-terminal/0.1 (research)" },
    });
    if (!res.ok) throw new Error(`GDELT ${res.status} ${res.statusText}`);

    // GDELT occasionally returns empty body or non-JSON on no results.
    const body = (await res.text()).trim();
    if (!body) return;
    let parsed: { articles?: GdeltArticle[] };
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error("GDELT returned non-JSON (likely a transient API error)");
    }

    for (const a of parsed.articles ?? []) {
      const item = normalizeGdeltArticle(a);
      if (item) yield item;
    }
  }
}
