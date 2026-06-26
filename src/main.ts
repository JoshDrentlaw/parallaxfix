/**
 * Hand Terminal — entrypoint.
 *
 * This is a Phase-0 skeleton: it boots under the application's declared
 * security policy (see SECURITY.md / deno.jsonc) and proves the permission
 * posture end-to-end. The ingestion / corpus / analysis / briefing contexts
 * land in later phases behind the Ports defined in `src/ports.ts`.
 *
 * Invariant reminder (P1): every run announces its coverage gaps. Even this
 * skeleton refuses to pretend it saw more than it did.
 */

import { parseArgs } from "@std/cli/parse-args";

const DECLARED_BLIND_SPOTS = ["tiktok", "instagram"] as const;

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

/** P1 made concrete: never finish a run without naming what we could not see. */
function coverageGapNotice(): void {
  console.log("\nCoverage gaps (declared blind spots — see P1):");
  for (const src of DECLARED_BLIND_SPOTS) {
    console.log(`  · ${src}: no automated access — NOT queried this run.`);
  }
}

function main(): number {
  const args = parseArgs(Deno.args);
  const cmd = String(args._[0] ?? "status");

  banner();

  switch (cmd) {
    case "status":
      reportEnv();
      coverageGapNotice();
      console.log(
        "\nSkeleton online. Adapters (Bluesky/Jetstream first) arrive in Phase 0+.",
      );
      return 0;
    case "brief": {
      const topic = args._.slice(1).join(" ").trim();
      if (!topic) {
        console.error('\nUsage: deno task brief "<topic>"');
        return 2;
      }
      console.log(`\nbrief("${topic}") — pipeline not yet implemented.`);
      coverageGapNotice();
      return 0;
    }
    default:
      console.error(`\nUnknown command: ${cmd}`);
      console.error('Commands: status | brief "<topic>"');
      return 2;
  }
}

if (import.meta.main) {
  Deno.exit(main());
}
