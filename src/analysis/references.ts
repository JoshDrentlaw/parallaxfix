/**
 * Blind-spot reference signal — circling the empty space.
 *
 * There is no way into TikTok/Instagram, but the reachable sources (Reddit,
 * news, RSS, Bluesky) constantly *point at* them. We harvest those pointers and
 * measure the pull: how many items reference a blind spot, whether they
 * converge on the same target, and how fast it's accelerating.
 *
 * Honesty rules (load-bearing):
 *   - This is meta-signal about ATTENTION, never content. A referenced video is
 *     never an `Item` we saw, never a `Claim`. It augments the blind-spot
 *     declaration (P1), never replaces it.
 *   - References come from ingested text — untrusted, and link-spam can game the
 *     signal. Convergence + distinct-source counts mitigate; they don't cure.
 *   - We record raw URLs and do NOT resolve share-links (resolving would touch
 *     the platform); staying strictly read-only.
 *
 * Pure and deterministic.
 */

import type { BlindSpotReference, BlindSpotSignal, Item } from "../ports.ts";

/** host (sans leading "www.") → platform. Covers the common share domains. */
const HOST_PLATFORM: Record<string, string> = {
  "tiktok.com": "tiktok",
  "vm.tiktok.com": "tiktok",
  "vt.tiktok.com": "tiktok",
  "m.tiktok.com": "tiktok",
  "instagram.com": "instagram",
  "instagr.am": "instagram",
  "ig.me": "instagram",
  "l.instagram.com": "instagram",
};

/** Bare-mention words → platform (precise; deliberately excludes ambiguous terms). */
const MENTION_PLATFORM: [RegExp, string][] = [
  [/\btiktok\b/i, "tiktok"],
  [/\binstagram\b/i, "instagram"],
];

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const HOUR_MS = 3_600_000;

function platformForHost(host: string): string | null {
  const h = host.toLowerCase().replace(/^www\./, "");
  return HOST_PLATFORM[h] ?? null;
}

/** Canonical target: host (sans www) + path, no query/fragment, no trailing slash. */
function normalizeTarget(u: URL): string {
  const host = u.host.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "");
  return `${host}${path}`;
}

/**
 * Extract blind-spot references from one item's text. Links (specific targets)
 * are kept distinct from bare mentions; an item that links a platform does not
 * also emit a weaker mention for that same platform.
 */
export function extractBlindSpotRefs(item: Item): BlindSpotReference[] {
  const refs: BlindSpotReference[] = [];
  const linkedPlatforms = new Set<string>();

  for (const raw of item.text.match(URL_RE) ?? []) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    const platform = platformForHost(url.host);
    if (!platform) continue;
    linkedPlatforms.add(platform);
    refs.push({
      platform,
      target: normalizeTarget(url),
      kind: "link",
      item_id: item.id,
      source: item.source,
      url: item.url,
      created_at: item.created_at,
    });
  }

  for (const [re, platform] of MENTION_PLATFORM) {
    if (linkedPlatforms.has(platform)) continue; // the link already counts
    if (re.test(item.text)) {
      refs.push({
        platform,
        target: null,
        kind: "mention",
        item_id: item.id,
        source: item.source,
        url: item.url,
        created_at: item.created_at,
      });
    }
  }

  return refs;
}

/** References/hour over the recent window (mirrors velocity scoring for sources). */
function referencesPerHour(times: Date[], now: Date, windowHours: number): number {
  if (times.length === 0) return 0;
  const cutoff = now.getTime() - windowHours * HOUR_MS;
  const recent = times.filter((t) => t.getTime() >= cutoff);
  if (recent.length === 0) return 0;
  const oldest = Math.min(...recent.map((t) => t.getTime()));
  const spanHours = Math.max((now.getTime() - oldest) / HOUR_MS, 1);
  return recent.length / spanHours;
}

export interface BlindSpotOptions {
  /** Which platforms to look for. */
  platforms?: string[];
  now?: Date;
  windowHours?: number;
  /** Max top targets to surface per platform. */
  topN?: number;
}

/**
 * Aggregate references across items into one signal per platform. Returns a
 * signal only for platforms that were actually referenced.
 */
export function summarizeBlindSpotSignals(
  items: Item[],
  opts: BlindSpotOptions = {},
): BlindSpotSignal[] {
  const platforms = opts.platforms ?? ["tiktok", "instagram"];
  const now = opts.now ?? new Date();
  const windowHours = opts.windowHours ?? 24;
  const topN = opts.topN ?? 5;

  const refsByPlatform = new Map<string, BlindSpotReference[]>();
  for (const it of items) {
    for (const ref of extractBlindSpotRefs(it)) {
      if (!platforms.includes(ref.platform)) continue;
      (refsByPlatform.get(ref.platform) ?? refsByPlatform.set(ref.platform, []).get(ref.platform)!)
        .push(ref);
    }
  }

  const signals: BlindSpotSignal[] = [];
  for (const platform of platforms) {
    const refs = refsByPlatform.get(platform);
    if (!refs || refs.length === 0) continue;

    const items_ = new Set<string>();
    const by_source: Record<string, number> = {};
    const seenItemSource = new Set<string>(); // dedupe per (item, source) for by_source
    const targetCounts = new Map<string, number>();
    let links = 0;
    let mentions = 0;

    for (const r of refs) {
      items_.add(r.item_id);
      if (!seenItemSource.has(r.item_id)) {
        seenItemSource.add(r.item_id);
        by_source[r.source] = (by_source[r.source] ?? 0) + 1;
      }
      if (r.kind === "link") {
        links++;
        if (r.target) targetCounts.set(r.target, (targetCounts.get(r.target) ?? 0) + 1);
      } else {
        mentions++;
      }
    }

    const top_targets = [...targetCounts.entries()]
      .map(([target, mentions]) => ({ target, mentions }))
      .sort((a, b) => b.mentions - a.mentions)
      .slice(0, topN);

    const times = refs.map((r) => r.created_at);
    const oldest = Math.min(...times.map((t) => t.getTime()));
    const newest = Math.max(...times.map((t) => t.getTime()));

    signals.push({
      platform,
      referencing_items: items_.size,
      by_source,
      links,
      mentions,
      top_targets,
      references_per_hour: referencesPerHour(times, now, windowHours),
      window: [new Date(oldest), new Date(newest)],
    });
  }

  return signals;
}
