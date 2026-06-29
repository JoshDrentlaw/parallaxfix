/**
 * Hand Terminal — entrypoint.
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
import type { Item, TopicDefinition } from "./ports.ts";
import { BlueskyJetstreamAdapter } from "./ingestion/bluesky.ts";
import { adHocTopic, loadTopic } from "./ingestion/topic.ts";

const DECLARED_BLIND_SPOTS = ["tiktok", "instagram"] as const;
const NOT_YET_WIRED = ["reddit", "gdelt", "rss"] as const;

function banner(): void {
  console.log("┌─ Hand Terminal ───────────────────────────────────────────┐");
  console.log("│ Topic-briefing engine · read-only · provenance-first       │");
  console.log("│ Assists judgment — never renders a verdict (P2).           │");
  console.log("└────────────────────────────────────────────────────────────┘");
}

/** Surface which capabilities the policy actually granted at boot. */
function reportEnv(): void {
  const have = (k: string) => (Deno.env.get(k) ? "set" : "—");
  console.log("\nRuntime config:");
  console.log(`  ANTHROPIC_API_KEY : ${have("ANTHROPIC_API_KEY")}`);
  console.log(`  REDDIT_CLIENT_ID  : ${have("REDDIT_CLIENT_ID")}`);
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
  const pending = NOT_YET_WIRED.filter((s) => !queried.includes(s));
  if (pending.length) console.log(`  not yet wired    : ${pending.join(", ")}`);
  for (const src of DECLARED_BLIND_SPOTS) {
    console.log(`  blind spot       : ${src} — no automated access, NOT queried.`);
  }
}

function printItem(item: Item): void {
  const when = item.created_at.toISOString().replace("T", " ").slice(0, 19);
  const text = item.text.replace(/\s+/g, " ").trim();
  const clipped = text.length > 200 ? `${text.slice(0, 197)}…` : text;
  console.log(`\n[${item.source}] ${when}  ${item.author}`);
  console.log(`  ${clipped || "(no text)"}`);
  console.log(`  ↳ ${item.url}`);
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
    case "brief": {
      const topic = args._.slice(1).join(" ").trim();
      if (!topic) {
        console.error('\nUsage: deno task brief "<topic>"');
        return 2;
      }
      console.log(`\nbrief("${topic}") — synthesis pipeline not yet implemented.`);
      coverageNotice([]);
      return 0;
    }
    default:
      console.error(`\nUnknown command: ${cmd}`);
      console.error(
        'Commands: status | listen <keywords> [--topic f] [--limit n] | brief "<topic>"',
      );
      return 2;
  }
}

if (import.meta.main) {
  Deno.exit(await main());
}
