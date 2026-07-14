/**
 * Application services — the composition layer between the drivers (CLI, web)
 * and the ports. Wires adapters to the corpus and the analysis/briefing
 * stages, reports progress through a callback, and returns structured
 * results. No presentation here: the CLI prints, the web layer serializes,
 * both call these.
 *
 * This module pulls in the heavy dependencies (postgres, transformers.js);
 * drivers import it lazily so `status`/`listen` stay light.
 */

import type { Briefing, Item, LLMPort, SourcePort, TopicDefinition } from "./ports.ts";
import type { CoverageReport } from "./ports.ts";
import { PgCorpus } from "./corpus/store.ts";
import { LocalEmbedder } from "./corpus/embed.ts";
import { GdeltAdapter, toGdeltDatetime } from "./ingestion/gdelt.ts";
import { RedditAdapter } from "./ingestion/reddit.ts";
import { RssAdapter } from "./ingestion/rss.ts";
import { clusterItems } from "./analysis/cluster.ts";
import { extractClaims } from "./analysis/claims.ts";
import { summarizeBlindSpotSignals } from "./analysis/references.ts";
import { assembleCoverageReport, type SourceResult } from "./briefing/coverage.ts";
import { assembleBriefing, synthesizeBriefing } from "./briefing/synthesize.ts";

export interface PipelineContext {
  databaseUrl: string;
  /** Human-readable progress lines; the CLI prints them, the web UI may stream them. */
  onProgress?: (message: string) => void;
}

function corpusFor(ctx: PipelineContext): PgCorpus {
  return new PgCorpus({ databaseUrl: ctx.databaseUrl, embedder: new LocalEmbedder() });
}

export interface GatherOptions {
  /**
   * Explicit historical window. Setting either bound switches GDELT to an
   * explicit startdatetime/enddatetime range (instead of its default rolling
   * timespan) and Reddit to `sort=relevance&t=all` (instead of `sort=new`) —
   * a recency-biased default can't reach a multi-year-old story by
   * construction (see historical-research-plan.md).
   */
  since?: Date;
  until?: Date;
}

/**
 * Poll the pull-based sources (Reddit/GDELT/RSS), store what they return, and
 * assemble the CoverageReport (P1) — including the blind-spot reference signal.
 * An unreachable source is a reported gap, never a crash.
 */
export async function gatherSources(
  topic: TopicDefinition,
  ctx: PipelineContext,
  opts: GatherOptions = {},
): Promise<CoverageReport> {
  const progress = ctx.onProgress ?? (() => {});
  const corpus = corpusFor(ctx);
  await corpus.init();

  const historical = Boolean(opts.since || opts.until);
  const adapters: SourcePort[] = [
    historical
      ? new GdeltAdapter({
        startDatetime: toGdeltDatetime(opts.since ?? new Date(0)),
        endDatetime: toGdeltDatetime(opts.until ?? new Date()),
      })
      : new GdeltAdapter(),
    historical ? new RedditAdapter({ sort: "relevance", time: "all" }) : new RedditAdapter(),
    new RssAdapter({ feeds: topic.feeds }),
  ];
  if (historical) {
    progress(
      `historical mode: GDELT ${toGdeltDatetime(opts.since ?? new Date(0))}–${
        toGdeltDatetime(opts.until ?? new Date())
      }, Reddit sort=relevance&t=all`,
    );
  }

  const results: SourceResult[] = [];
  try {
    for (const adapter of adapters) {
      try {
        const items: Item[] = [];
        for await (const item of adapter.fetch(topic)) items.push(item);
        await corpus.append(items);
        results.push({ source: adapter.name, items });
        progress(`${adapter.name}: ${items.length} item(s)`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        results.push({ source: adapter.name, items: [], unavailable: reason });
        progress(`${adapter.name}: unavailable — ${reason}`);
      }
    }
  } finally {
    await corpus.close();
  }

  // Circle the blind spots: measure how hard the gathered, reachable items
  // point at TikTok/Instagram (a known unknown made visible).
  const allItems = results.flatMap((r) => r.items);
  const signals = summarizeBlindSpotSignals(allItems);
  return assembleCoverageReport(topic.id, results, new Date(), signals);
}

export interface BriefOptions {
  /** Retrieval depth — how many stored items to analyze. */
  k?: number;
  now?: Date;
  /** Minimum-similarity floor for retrieval; omit to use the corpus's default (P1). */
  minSimilarity?: number;
}

/**
 * The Phase-4 briefing over the stored corpus: retrieve → cluster (P5) →
 * label + evidence-tagged claims (P4, needs ANTHROPIC_API_KEY) → coverage from
 * what the corpus actually holds (P1) → assemble with provenance (P3) →
 * optional synthesis prose (P2-constrained). Without a key the full structure
 * is still returned — labels and prose omitted rather than faked.
 */
export async function briefTopic(
  topic: TopicDefinition,
  ctx: PipelineContext,
  opts: BriefOptions = {},
): Promise<Briefing> {
  const progress = ctx.onProgress ?? (() => {});
  const k = opts.k ?? 200;
  const now = opts.now ?? new Date();

  const corpus = corpusFor(ctx);
  let ranked: import("./ports.ts").RankedItem[];
  try {
    ranked = await corpus.retrieveForAnalysis(topic, k, { minSimilarity: opts.minSimilarity });
  } finally {
    await corpus.close();
  }
  const items = ranked.map((r) => r.item);
  const similarityById = new Map(ranked.map((r) => [r.item.id, r.similarity]));
  if (items.length === 0) {
    // P1: "nothing cleared the floor" is a real, first-class answer — not
    // empty output that gets silently explained away downstream.
    progress(
      `no strong matches for "${topic.id}" — nothing in the corpus cleared the similarity floor`,
    );
  } else {
    progress(`retrieved ${items.length} stored item(s) for "${topic.id}"`);
  }

  const clusters = clusterItems(items, { now, similarityById });
  const itemsById = new Map(items.map((it) => [it.id, it]));

  // Optional paid enrichment: label narratives + extract claims via Claude.
  let claims: import("./ports.ts").Claim[] = [];
  let llm: LLMPort | null = null;
  if (Deno.env.get("ANTHROPIC_API_KEY")) {
    const { AnthropicLLM } = await import("./llm/anthropic.ts");
    llm = new AnthropicLLM();
    progress("labeling narratives…");
    await Promise.all(clusters.map(async (c) => {
      const texts = c.item_ids.map((id) => itemsById.get(id)?.text ?? "").filter(Boolean);
      c.label = await llm!.labelCluster(texts);
    }));
    progress("extracting claims via Haiku batch (this can take a while)…");
    claims = await extractClaims(clusters, itemsById, llm);
  } else {
    progress("ANTHROPIC_API_KEY not set — labels, claims, and prose synthesis skipped");
  }

  // Coverage from what the corpus actually holds for this topic + blind-spot pull.
  const bySource = new Map<string, Item[]>();
  for (const it of items) {
    (bySource.get(it.source) ?? bySource.set(it.source, []).get(it.source)!).push(it);
  }
  const results: SourceResult[] = [...bySource.entries()].map(([source, its]) => ({
    source,
    items: its,
  }));
  const signals = summarizeBlindSpotSignals(items, { now });
  const coverage = assembleCoverageReport(topic.id, results, now, signals);

  let briefing = assembleBriefing(topic.id, clusters, claims, itemsById, coverage, {
    generatedAt: now,
  });
  if (llm) {
    progress("synthesizing overview…");
    try {
      briefing = await synthesizeBriefing(briefing, llm);
    } catch (err) {
      // Synthesis is best-effort; degrade to the structured briefing (P1 honesty).
      progress(
        `synthesis failed (${err instanceof Error ? err.message : err}) — ` +
          "returning the structured briefing without prose",
      );
    }
  }
  return briefing;
}
