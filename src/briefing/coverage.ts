/**
 * CoverageReport assembler — P1 made concrete.
 *
 * Absence of signal is not absence of the thing. Every run states what it
 * queried, how much each source returned, and — prominently — what it could
 * NOT see. The short-video platforms are a *declared* blind spot: they are
 * always reported as unavailable, never silently omitted.
 */

import type { BlindSpotSignal, CoverageReport, Item } from "../ports.ts";

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
  blindSpotSignals: BlindSpotSignal[] = [],
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
    blind_spot_signals: blindSpotSignals.length ? blindSpotSignals : undefined,
  };
}

/**
 * Render a CoverageReport to plain lines (P1, foregrounded). Pure — returns the
 * lines so both the CLI commands and the briefing renderer share one format and
 * can't drift. The blind-spot reference signal augments each blind-spot line
 * (attention, not content), never replacing the "could NOT see" declaration.
 */
export function formatCoverageReport(r: CoverageReport): string[] {
  const out: string[] = [];
  out.push("══ Coverage report (P1) ══════════════════════════════════");
  out.push(`  topic  : ${r.topic_id}`);
  out.push(`  run_at : ${r.run_at.toISOString()}`);
  out.push(
    `  window : ${r.window[0].toISOString().slice(0, 19)} … ${
      r.window[1].toISOString().slice(0, 19)
    }`,
  );
  out.push("  queried:");
  if (r.sources_queried.length === 0) out.push("    (none)");
  for (const s of r.sources_queried) {
    out.push(`    ${s.padEnd(9)} ${r.items_per_source[s] ?? 0} item(s)`);
  }
  out.push("  could NOT see:");
  for (const u of r.sources_unavailable) {
    out.push(`    ${u.source.padEnd(9)} — ${u.reason}`);
    // Circling the empty space: if the reachable web points at this blind spot,
    // surface the pull (attention, NOT content).
    const sig = r.blind_spot_signals?.find((s) => s.platform === u.source);
    if (sig) {
      const by = Object.entries(sig.by_source).map(([s, n]) => `${s} ${n}`).join(", ");
      out.push(
        `              ↳ but ${sig.referencing_items} reachable item(s) reference it ` +
          `(${by}) · ${sig.references_per_hour.toFixed(1)}/h`,
      );
      const top = sig.top_targets[0];
      if (top && top.mentions > 1) {
        out.push(`                ${top.mentions} converge on ↳ ${top.target}`);
      }
    }
  }
  if (r.blind_spot_signals?.length) {
    out.push("    (references = attention, not content; links can be gamed — treat as a lead.)");
  }
  return out;
}
