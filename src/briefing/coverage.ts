/**
 * CoverageReport assembler — P1 made concrete.
 *
 * Absence of signal is not absence of the thing. Every run states what it
 * queried, how much each source returned, and — prominently — what it could
 * NOT see. The short-video platforms are a *declared* blind spot: they are
 * always reported as unavailable, never silently omitted.
 */

import type { CoverageReport, Item } from "../ports.ts";

/** Always-unavailable sources. The thing under investigation may live exactly here. */
export const DECLARED_BLIND_SPOTS: { source: string; reason: string }[] = [
  { source: "tiktok", reason: "no automated access — closed to automated ingestion" },
  { source: "instagram", reason: "no automated access — closed to automated ingestion" },
];

export interface SourceResult {
  source: string;
  /** Items the source returned this run (empty if it was queried but found nothing). */
  items: Item[];
  /** If set, the source could not be queried this run; goes to sources_unavailable. */
  unavailable?: string;
}

/**
 * Build the report from per-source results. The declared blind spots are always
 * appended to `sources_unavailable`; a source that errored is moved from
 * `sources_queried` into `sources_unavailable` with its reason.
 */
export function assembleCoverageReport(
  topicId: string,
  results: SourceResult[],
  runAt: Date = new Date(),
): CoverageReport {
  const sources_queried: string[] = [];
  const items_per_source: Record<string, number> = {};
  const sources_unavailable: { source: string; reason: string }[] = [];
  let oldest: Date | null = null;
  let newest: Date | null = null;

  for (const r of results) {
    if (r.unavailable) {
      sources_unavailable.push({ source: r.source, reason: r.unavailable });
      continue;
    }
    sources_queried.push(r.source);
    items_per_source[r.source] = r.items.length;
    for (const it of r.items) {
      if (!oldest || it.created_at < oldest) oldest = it.created_at;
      if (!newest || it.created_at > newest) newest = it.created_at;
    }
  }

  // Declared blind spots are reported every run (P1), de-duped against any
  // source that already reported itself unavailable.
  for (const bs of DECLARED_BLIND_SPOTS) {
    if (!sources_unavailable.some((u) => u.source === bs.source)) {
      sources_unavailable.push(bs);
    }
  }

  return {
    topic_id: topicId,
    run_at: runAt,
    sources_queried,
    items_per_source,
    sources_unavailable,
    window: [oldest ?? runAt, newest ?? runAt],
  };
}
