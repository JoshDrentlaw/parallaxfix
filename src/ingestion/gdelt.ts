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

/** Format a Date into GDELT's `STARTDATETIME`/`ENDDATETIME` form: "YYYYMMDDHHMMSS" (UTC). */
export function toGdeltDatetime(d: Date): string {
  const p = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
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

/**
 * Default `timespan` when no explicit range is given. Widened from the
 * original "1d" (a live-monitoring default that made GDELT structurally unable
 * to reach a multi-year-old story — see historical-research-plan.md item 2).
 * "3months" is GDELT's documented practical ceiling for the relative-window
 * form; anything older needs explicit `startDatetime`/`endDatetime` instead.
 * NOTE: not re-verified against the live DOC 2.0 API in this environment
 * (egress to api.gdeltproject.org is blocked by this sandbox's network
 * policy) — re-check actual archive depth/behavior against real queries
 * before relying on it, per the plan's own "don't assume" instruction.
 */
const DEFAULT_TIMESPAN = "3months";

export interface GdeltOptions {
  maxRecords?: number;
  /** Timespan window, GDELT syntax (e.g. "1d", "12h", "3months"). Ignored if startDatetime/endDatetime are set. */
  timespan?: string;
  /** Explicit range start, GDELT "YYYYMMDDHHMMSS" (use `toGdeltDatetime`). Mutually exclusive with `timespan`. */
  startDatetime?: string;
  /** Explicit range end, GDELT "YYYYMMDDHHMMSS" (use `toGdeltDatetime`). Required if `startDatetime` is set. */
  endDatetime?: string;
}

/**
 * Build the DOC 2.0 query params for a fetch — pure and network-free so the
 * widened-default / explicit-range behavior is directly testable.
 */
export function gdeltQueryParams(topic: TopicDefinition, opts: GdeltOptions = {}): URLSearchParams {
  const maxRecords = opts.maxRecords ?? 75;
  const params = new URLSearchParams({
    query: buildTopicQuery(topic),
    mode: "ArtList",
    format: "json",
    maxrecords: String(maxRecords),
    sort: "datedesc",
  });
  // GDELT's DOC API treats timespan and an explicit start/end range as
  // mutually exclusive; an explicit range wins when both are supplied.
  if (opts.startDatetime && opts.endDatetime) {
    params.set("startdatetime", opts.startDatetime);
    params.set("enddatetime", opts.endDatetime);
  } else {
    params.set("timespan", opts.timespan ?? DEFAULT_TIMESPAN);
  }
  return params;
}

export class GdeltAdapter implements SourcePort {
  readonly name = "gdelt" as const;
  readonly #opts: GdeltOptions;

  constructor(opts: GdeltOptions = {}) {
    this.#opts = opts;
  }

  async *fetch(topic: TopicDefinition): AsyncIterable<Item> {
    const params = gdeltQueryParams(topic, this.#opts);
    const res = await fetch(`${GDELT_DOC_API}?${params}`, {
      headers: { "user-agent": "parallax-fix/0.1 (research)" },
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
