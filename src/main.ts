/**
 * Parallax Fix — entrypoint.
 *
 * Phase 0: boots under the declared security policy (SECURITY.md / deno.jsonc)
 * and streams the keystone source. The `listen` command runs the Bluesky/
 * Jetstream adapter end-to-end, proving the SourcePort seam. Corpus, analysis,
 * and briefing land in later phases.
 *
 * Invariant reminder (P1): every run announces its coverage gaps. Even this
 * skeleton refuses to pretend it saw more than it did.
 */

import { parseArgs } from "@std/cli/parse-args";
import type { CoverageReport, Item, TopicDefinition } from "./ports.ts";
import { DECLARED_BLIND_SPOTS, formatCoverageReport } from "./briefing/coverage.ts";
import { BlueskyJetstreamAdapter } from "./ingestion/bluesky.ts";
import { adHocTopic, loadTopic } from "./ingestion/topic.ts";

const OTHER_PULL_SOURCES = ["reddit", "gdelt", "rss"] as const;

function banner(): void {
  const w = 60; // inner width between the borders
  const title = " Parallax Fix ";
  const lines = [
    "Topic-briefing engine · read-only · provenance-first",
    "Assists judgment — never renders a verdict (P2).",
  ];
  console.log(`┌${("─" + title).padEnd(w, "─")}┐`);
  for (const l of lines) console.log(`│${(" " + l).padEnd(w)}│`);
  console.log(`└${"─".repeat(w)}┘`);
}

/** Surface which capabilities the policy actually granted at boot. */
function reportEnv(): void {
  const have = (k: string) => (Deno.env.get(k) ? "set" : "—");
  console.log("\nRuntime config:");
  console.log(`  ANTHROPIC_API_KEY : ${have("ANTHROPIC_API_KEY")}`);
  console.log(`  REDDIT_CLIENT_ID  : ${have("REDDIT_CLIENT_ID")}`);
  console.log(`  DATABASE_URL      : ${have("DATABASE_URL")}`);
  console.log(`  HTTPS_PROXY       : ${have("HTTPS_PROXY")}`);
  console.log(`  DENO_CERT         : ${have("DENO_CERT")}`);
}

interface Unavailable {
  source: string;
  reason: string;
}

/** P1 made concrete: never finish a run without naming what we did/didn't see. */
function coverageNotice(queried: string[], unavailable: Unavailable[] = []): void {
  console.log("\nCoverage (P1):");
  console.log(`  queried this run : ${queried.join(", ") || "(none)"}`);
  for (const u of unavailable) {
    console.log(`  UNAVAILABLE      : ${u.source} — ${u.reason}`);
  }
  const pending = OTHER_PULL_SOURCES.filter((s) => !queried.includes(s));
  if (pending.length) console.log(`  not queried here : ${pending.join(", ")} (use \`gather\`)`);
  for (const bs of DECLARED_BLIND_SPOTS) {
    console.log(`  blind spot       : ${bs.source} — ${bs.reason}`);
  }
}

function printItem(item: Item, similarity?: number): void {
  const when = item.created_at.toISOString().replace("T", " ").slice(0, 19);
  const text = item.text.replace(/\s+/g, " ").trim();
  const clipped = text.length > 200 ? `${text.slice(0, 197)}…` : text;
  const score = similarity === undefined ? "" : `  (sim ${similarity.toFixed(3)})`;
  console.log(`\n[${item.source}] ${when}  ${item.author}${score}`);
  console.log(`  ${clipped || "(no text)"}`);
  console.log(`  ↳ ${item.url}`);
}

/** Boxed info panel — the CLI form of the future web tooltip. */
function infoPanel(title: string, body: string): void {
  const width = 76;
  const bar = "─".repeat(width);
  console.log(`\n╭─ ${title} ${"─".repeat(Math.max(0, width - title.length - 3))}╮`);
  for (const raw of body.split("\n")) {
    console.log(`│ ${raw}`);
  }
  console.log(`╰${bar}╯`);
}

type Args = ReturnType<typeof parseArgs>;

/** Topic from `--topic <file>`, else inline keywords (positional or --keywords). */
async function resolveTopic(args: Args): Promise<TopicDefinition> {
  const topicPath = typeof args.topic === "string" ? args.topic : "";
  if (topicPath) return await loadTopic(topicPath);

  const inline = String(args._[1] ?? args.keywords ?? "").trim();
  const keywords = inline ? inline.split(",").map((s) => s.trim()).filter(Boolean) : [];
  return adHocTopic(keywords);
}

async function listen(args: Args): Promise<number> {
  const topic = await resolveTopic(args);
  const limit = Number(args.limit ?? 0);

  const controller = new AbortController();
  const onSigint = () => {
    console.log("\n(stopping…)");
    controller.abort();
  };
  Deno.addSignalListener("SIGINT", onSigint);

  const adapter = new BlueskyJetstreamAdapter({ signal: controller.signal });
  const terms = [...topic.keywords, ...topic.entities].join(", ");
  console.log(`\nListening on Bluesky/Jetstream for topic "${topic.id}"`);
  console.log(`  terms: ${terms || "(all — unfiltered firehose)"}`);
  if (limit) console.log(`  stopping after ${limit} match(es)`);

  let n = 0;
  const unavailable: Unavailable[] = [];
  try {
    for await (const item of adapter.fetch(topic)) {
      printItem(item);
      if (limit && ++n >= limit) {
        controller.abort();
        break;
      }
    }
  } catch (err) {
    // An unreachable source is a coverage gap (P1), not a crash. Report it.
    if (!controller.signal.aborted) {
      const reason = err instanceof Error ? err.message : String(err);
      unavailable.push({ source: "bluesky", reason });
      console.error(`\n! Bluesky stream ended early — reporting as a coverage gap.`);
    }
  } finally {
    Deno.removeSignalListener("SIGINT", onSigint);
  }

  console.log(`\nStreamed ${n} item(s).`);
  coverageNotice(["bluesky"], unavailable);
  return 0;
}

/** Require DATABASE_URL for Corpus commands; returns it or null (with a hint). */
function requireDatabaseUrl(): string | null {
  const url = Deno.env.get("DATABASE_URL");
  if (!url) {
    console.error("\nDATABASE_URL is not set — the Corpus needs Postgres + pgvector.");
    console.error("  e.g. DATABASE_URL=postgres://postgres:postgres@localhost:5432/parallaxfix");
  }
  return url ?? null;
}

/** Stream the keystone source into the corpus (embeds + stores). */
async function ingest(args: Args): Promise<number> {
  const dbUrl = requireDatabaseUrl();
  if (!dbUrl) return 2;

  const topic = await resolveTopic(args);
  const limit = Number(args.limit ?? 50);

  const { PgCorpus } = await import("./corpus/store.ts");
  const { LocalEmbedder } = await import("./corpus/embed.ts");
  const corpus = new PgCorpus({ databaseUrl: dbUrl, embedder: new LocalEmbedder() });
  await corpus.init();

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  Deno.addSignalListener("SIGINT", onSigint);

  const adapter = new BlueskyJetstreamAdapter({ signal: controller.signal });
  console.log(`\nIngesting Bluesky → corpus for "${topic.id}" (limit ${limit})…`);

  let n = 0;
  let batch: Item[] = [];
  const unavailable: Unavailable[] = [];
  try {
    for await (const item of adapter.fetch(topic)) {
      batch.push(item);
      if (batch.length >= 16) {
        await corpus.append(batch);
        batch = [];
      }
      if (limit && ++n >= limit) {
        controller.abort();
        break;
      }
    }
    if (batch.length) await corpus.append(batch);
  } catch (err) {
    if (!controller.signal.aborted) {
      unavailable.push({
        source: "bluesky",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    Deno.removeSignalListener("SIGINT", onSigint);
    await corpus.close();
  }

  console.log(`\nIngested ${n} item(s) into the corpus.`);
  coverageNotice(["bluesky"], unavailable);
  return 0;
}

/** Render the CoverageReport — P1's first-class output, foregrounded. */
function printCoverageReport(r: CoverageReport): void {
  console.log();
  for (const line of formatCoverageReport(r)) console.log(line);
}

/** Parse a `--since`/`--until` flag value into a Date, or null if unset/invalid. */
function parseDateFlag(v: unknown): Date | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Poll the pull-based sources (Reddit/GDELT/RSS), store, and report coverage.
 * `--since`/`--until` switch GDELT/Reddit into historical mode (explicit date
 * range + sort=relevance&t=all) instead of their live-recency defaults, and
 * add Bluesky's searchPosts history search alongside them (the live Jetstream
 * keystone stays a separate `listen`/`ingest` step either way).
 */
async function gather(args: Args): Promise<number> {
  const dbUrl = requireDatabaseUrl();
  if (!dbUrl) return 2;

  const topic = await resolveTopic(args);
  const since = parseDateFlag(args.since);
  const until = parseDateFlag(args.until);
  const { gatherSources } = await import("./pipeline.ts");

  console.log(`\nGathering pull-based sources for "${topic.id}"…`);
  const coverage = await gatherSources(topic, {
    databaseUrl: dbUrl,
    onProgress: (m) => console.log(`  ${m}`),
  }, { since: since ?? undefined, until: until ?? undefined });
  printCoverageReport(coverage);
  return 0;
}

/** Analysis: cluster the corpus into narratives, score velocity, extract claims. */
async function analyze(args: Args): Promise<number> {
  const dbUrl = requireDatabaseUrl();
  if (!dbUrl) return 2;

  const topic = await resolveTopic(args);
  const k = Number(args.k ?? 200);
  const minSimilarity = args["min-similarity"] !== undefined
    ? Number(args["min-similarity"])
    : undefined;

  const { PgCorpus } = await import("./corpus/store.ts");
  const { LocalEmbedder } = await import("./corpus/embed.ts");
  const { clusterItems } = await import("./analysis/cluster.ts");
  const { extractClaims } = await import("./analysis/claims.ts");

  const corpus = new PgCorpus({ databaseUrl: dbUrl, embedder: new LocalEmbedder() });
  let ranked: import("./ports.ts").RankedItem[];
  try {
    ranked = await corpus.retrieveForAnalysis(topic, k, { minSimilarity });
  } finally {
    await corpus.close();
  }
  const items = ranked.map((r) => r.item);
  const similarityById = new Map(ranked.map((r) => [r.item.id, r.similarity]));

  if (items.length === 0) {
    console.log(`\nNo strong matches for "${topic.id}" — nothing cleared the similarity floor.`);
    coverageNotice([]);
    return 0;
  }

  const clusters = clusterItems(items, { similarityById });
  console.log(`\nNarratives for "${topic.id}" (${clusters.length} from ${items.length} items):`);
  const itemsById = new Map(items.map((it) => [it.id, it]));

  // Claim extraction is the only paid step — run it only if a key is present.
  let claims: import("./ports.ts").Claim[] = [];
  if (Deno.env.get("ANTHROPIC_API_KEY")) {
    const { AnthropicLLM } = await import("./llm/anthropic.ts");
    console.log("  (extracting claims via Haiku batch — this can take a while)…");
    claims = await extractClaims(clusters, itemsById, new AnthropicLLM());
  } else {
    console.log("  (ANTHROPIC_API_KEY not set — skipping claim extraction)");
  }

  for (const [i, c] of clusters.entries()) {
    const rep = itemsById.get(c.item_ids[0]);
    console.log(
      `\n#${i + 1}  velocity ${c.velocity.toFixed(2)}/h · relevance ${
        c.relevance.toFixed(2)
      } · size ${c.size}`,
    );
    if (rep) {
      const t = rep.text.replace(/\s+/g, " ").trim();
      console.log(`  e.g. ${t.length > 160 ? `${t.slice(0, 157)}…` : t}`);
      console.log(`  ↳ ${rep.url}`);
    }
    for (const cl of claims.filter((x) => x.cluster_id === c.id)) {
      const hint = cl.verify_hint ? ` · verify: ${cl.verify_hint}` : "";
      console.log(
        `    [${cl.evidence_type}] ${cl.text} (${cl.supporting_item_ids.length} src)${hint}`,
      );
    }
  }

  coverageNotice([]);
  return 0;
}

/**
 * Phase 4 — the briefing. Reads the stored corpus for the topic, clusters into
 * narratives (P5), labels + extracts evidence-tagged claims (P4) when a key is
 * present, derives the coverage report (P1) with the blind-spot signal, and
 * renders one structured briefing with provenance (P3) and no verdict (P2). The
 * LLM steps are optional: without ANTHROPIC_API_KEY it still emits the full
 * structure (labels/overview omitted), never pretending to more than it has.
 */
async function brief(args: Args): Promise<number> {
  const dbUrl = requireDatabaseUrl();
  if (!dbUrl) return 2;

  // A briefing topic may arrive as a quoted or unquoted phrase; use the whole
  // thing (comma-separated → multiple keywords), or a --topic file if given.
  let topic: TopicDefinition;
  if (typeof args.topic === "string") {
    topic = await loadTopic(args.topic);
  } else {
    const phrase = args._.slice(1).join(" ").trim();
    topic = adHocTopic(phrase.split(",").map((s) => s.trim()).filter(Boolean));
  }
  const k = Number(args.k ?? 200);
  const minSimilarity = args["min-similarity"] !== undefined
    ? Number(args["min-similarity"])
    : undefined;

  const { briefTopic } = await import("./pipeline.ts");
  const { renderBriefing } = await import("./briefing/synthesize.ts");

  console.log(`\nBriefing "${topic.id}"…`);
  console.log("  (reads the corpus as-is — run `ingest`/`gather` first to refresh it)");
  const briefing = await briefTopic(topic, {
    databaseUrl: dbUrl,
    onProgress: (m) => console.log(`  ${m}`),
  }, { k, minSimilarity });

  console.log("\n" + renderBriefing(briefing));
  return 0;
}

/**
 * The web UI — same pipeline as the CLI, served over HTTP with a dark-mode
 * front end. Binds localhost by default; pass --host 0.0.0.0 to expose it
 * (see SECURITY.md §3a before you do).
 */
async function serve(args: Args): Promise<number> {
  const port = Number(args.port ?? 8420);
  const hostname = String(args.host ?? "127.0.0.1");
  const { startServer } = await import("./web/server.ts");
  await startServer({ hostname, port }).finished;
  return 0;
}

/** Semantic retrieval: ranked, deduped items for a topic. */
async function match(args: Args): Promise<number> {
  const dbUrl = requireDatabaseUrl();
  if (!dbUrl) return 2;

  const topic = await resolveTopic(args);
  const k = Number(args.k ?? 20);
  const minSimilarity = args["min-similarity"] !== undefined
    ? Number(args["min-similarity"])
    : undefined;

  const { PgCorpus } = await import("./corpus/store.ts");
  const { LocalEmbedder } = await import("./corpus/embed.ts");
  const corpus = new PgCorpus({ databaseUrl: dbUrl, embedder: new LocalEmbedder() });

  try {
    const matches = await corpus.retrieve(topic, k, { minSimilarity });
    if (matches.length === 0) {
      // P1: a real, first-class answer — not silently rendered as "Top 0 match(es)".
      console.log(`\nNo strong matches for "${topic.id}" — nothing cleared the similarity floor.`);
    } else {
      console.log(`\nTop ${matches.length} match(es) for "${topic.id}":`);
    }
    for (const m of matches) printItem(m.item, m.similarity);

    if (matches.length > 0) {
      if (args.explain) {
        const { COSINE_SIMILARITY_TITLE, COSINE_SIMILARITY_EXPLAINER } = await import(
          "./corpus/explain.ts"
        );
        infoPanel(COSINE_SIMILARITY_TITLE, COSINE_SIMILARITY_EXPLAINER);
      } else {
        console.log(
          "\n(sim = cosine similarity, ~1 closest in meaning. Run with --explain for more.)",
        );
      }
    }
  } finally {
    await corpus.close();
  }
  return 0;
}

/**
 * Topic authoring → config/topics/<id>.json. Interactive prompts when stdin is
 * a TTY; otherwise driven by flags (--keywords/--entities/--description/--exclude)
 * so it's scriptable. Each field prefers its flag, then an interactive prompt.
 */
async function topicNew(args: Args): Promise<number> {
  const { slugifyTopicId } = await import("./ingestion/topic.ts");

  const interactive = Deno.stdin.isTerminal();
  const flag = (k: string): string | undefined =>
    typeof args[k] === "string" ? String(args[k]).trim() : undefined;
  const ask = (label: string): string =>
    interactive ? (globalThis.prompt(`${label}:`) ?? "").trim() : "";
  const field = (k: string, label: string): string => flag(k) ?? ask(label);
  const list = (s: string): string[] => s.split(",").map((x) => x.trim()).filter(Boolean);

  if (interactive) console.log("\nNew topic — answer a few prompts (Ctrl+C to cancel).");

  const idRaw = typeof args._[2] === "string" ? String(args._[2]) : field("id", "id (short name)");
  const id = slugifyTopicId(idRaw);
  if (!id) {
    console.error("An id is required — pass `topic new <id>` or --id.");
    return 2;
  }

  const topic: TopicDefinition = {
    id,
    keywords: list(field("keywords", "keywords (comma-separated)")),
    entities: list(field("entities", "entities (names/orgs/places to disambiguate)")),
    description: field("description", "description (natural language — drives semantic matching)"),
    exclude: list(field("exclude", "exclude (negative keywords)")),
  };

  if (topic.keywords.length === 0 && topic.description === "") {
    console.error(
      "\nRefusing to write an empty topic (no keywords and no description).\n" +
        "  Interactive: run in a terminal. Scripted: pass --keywords and/or --description.",
    );
    return 2;
  }

  const dir = "config/topics";
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}/${id}.json`;
  try {
    await Deno.stat(path);
    if (!globalThis.confirm(`${path} already exists — overwrite?`)) {
      console.log("Aborted.");
      return 1;
    }
  } catch {
    // doesn't exist yet — fine
  }

  await Deno.writeTextFile(path, `${JSON.stringify(topic, null, 2)}\n`);
  console.log(`\nWrote ${path}`);
  console.log(`Next: deno task ingest --topic ${path} --limit 50`);
  console.log(`Then: deno task match  --topic ${path} -k 20 --explain`);
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(Deno.args);
  const cmd = String(args._[0] ?? "status");

  banner();

  switch (cmd) {
    case "status":
      reportEnv();
      coverageNotice([]);
      console.log("\nSkeleton online. Try: deno task start listen <keywords> --limit 5");
      return 0;
    case "listen":
      return await listen(args);
    case "ingest":
      return await ingest(args);
    case "gather":
      return await gather(args);
    case "match":
      return await match(args);
    case "analyze":
      return await analyze(args);
    case "topic": {
      const sub = String(args._[1] ?? "");
      if (sub === "new") return await topicNew(args);
      console.error("\nUsage: deno task start topic new [<id>]");
      return 2;
    }
    case "brief": {
      const inline = args._.slice(1).join(" ").trim();
      if (!inline && typeof args.topic !== "string") {
        console.error('\nUsage: deno task brief "<topic>"   (or --topic <file>)');
        return 2;
      }
      return await brief(args);
    }
    case "serve":
      return await serve(args);
    default:
      console.error(`\nUnknown command: ${cmd}`);
      console.error(
        "Commands:\n" +
          "  status\n" +
          "  listen <keywords> [--topic f] [--limit n]\n" +
          "  ingest <keywords> [--topic f] [--limit n]      (Bluesky → corpus)\n" +
          "  gather <keywords> [--topic f] [--since d] [--until d]  (Reddit+GDELT+RSS → corpus, + coverage;\n" +
          "                                                  --since/--until switch to historical mode,\n" +
          "                                                  adding Bluesky searchPosts)\n" +
          "  match  <keywords> [--topic f] [-k n] [--min-similarity f] [--explain]  (semantic retrieval)\n" +
          "  analyze <keywords> [--topic f] [-k n] [--min-similarity f]  (cluster + velocity + relevance + claims)\n" +
          "  topic new [<id>]                               (author a topic file)\n" +
          '  brief  "<topic>" [--topic f] [-k n] [--min-similarity f]  (structured briefing: narratives + claims + coverage)\n' +
          "  serve  [--port 8420] [--host 127.0.0.1]        (web UI over the same pipeline)",
      );
      return 2;
  }
}

if (import.meta.main) {
  Deno.exit(await main());
}
