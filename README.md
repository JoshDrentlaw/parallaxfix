# Parallax Fix

Topic-scoped briefing engine: coalesces news + social discussion into a single structured briefing
built for _intent_ rather than doomscrolling. Provenance on every item, explicit coverage gaps, no
verdicts.

See [`parallax-fix-spec.md`](./parallax-fix-spec.md) for the full build spec and
[`CLAUDE.md`](./CLAUDE.md) for the working invariants.

## Runtime

[Deno](https://deno.com/) 2.x (TypeScript).

## Security policy

This application **defines its own, deliberately broad security policy** — it is not bound by the
restrictive policies of the other nucklehead apps. See **[`SECURITY.md`](./SECURITY.md)**; the
executable form is the permission flags on the `deno task` definitions in
[`deno.jsonc`](./deno.jsonc).

## Quick start

```sh
cp .env.example .env   # fill in keys as phases come online
deno task start        # status: runtime config + coverage gaps

# Stream the keystone source (Bluesky/Jetstream) for a topic:
deno task start listen wildfire,riverside --limit 10
deno task start listen --topic config/topics/example.json --limit 10

# Author a reusable topic (interactive prompts, or flags for scripting):
deno task start topic new riverside-recall \
  --keywords "recall,city council" --entities "Riverside" \
  --description "Recall effort targeting Riverside city council members" \
  --exclude "basketball"

# Corpus (needs DATABASE_URL → Postgres+pgvector; see below):
deno task ingest --topic config/topics/riverside-recall.json --limit 50  # Bluesky → embed → store
deno task start gather --topic config/topics/riverside-recall.json       # Reddit+GDELT+RSS → store, + coverage report
deno task match  --topic config/topics/riverside-recall.json -k 20 --explain  # ranked + score legend

# Historical research (a multi-year-old story, not a live one): widen the window.
# GDELT switches to an explicit date range, Reddit to sort=relevance&t=all.
deno task start gather --topic config/topics/old-story.json --since 2018-01-01 --until 2018-12-31

# Analysis (clusters → velocity → relevance → claims; claim extraction needs ANTHROPIC_API_KEY):
deno task start analyze --topic config/topics/riverside-recall.json -k 200

# Briefing (Phase 4): cluster → label → claims → coverage → structured briefing
deno task brief "riverside city council recall"
deno task brief --topic config/topics/riverside-recall.json -k 200

# All retrieval commands (match/analyze/brief) accept --min-similarity to override the
# corpus's default relevance floor — nothing below it is ever presented as a match (P1).

# Web UI (dark mode, same pipeline): gather + brief from the browser
deno task serve                      # → http://127.0.0.1:8420
deno task serve -- --port 9000       # localhost-only by default; SECURITY.md §3a before exposing
```

### Corpus prerequisites (Phase 1)

- **Postgres + pgvector.** Point `DATABASE_URL` at a database with the `vector` extension available
  (local: `docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 pgvector/pgvector:pg16`). The
  schema is created automatically on first `ingest`.
- **Local embedder.** `ingest`/`match` run `bge-small-en-v1.5` via transformers.js. Those tasks set
  `--node-modules-dir=auto`; on first run the model weights (~130MB) download from huggingface.co
  and cache under `./models`, and Deno may prompt to approve native build scripts
  (`deno approve-scripts` for `onnxruntime-node`/`sharp`) — without them it falls back to the slower
  WASM runtime. Both the weight download and the egress need outbound network.

Dev loop:

```sh
deno task check && deno task lint && deno task fmt && deno task test
```

## Status

Phase 0 (merged): project + security policy + Ports + the **Bluesky/Jetstream adapter** streaming
normalized `Item`s via `listen`, with unreachable sources reported as coverage gaps (P1).

Phase 1 (merged): the **Corpus** — a Postgres + pgvector append-only store with embeddings
(`bge-small-en-v1.5`) and **semantic topic matching** (`ingest` → embed/store, `match` → ranked
retrieval).

Phase 2 (merged): more sources + **coverage**. **Reddit** (see access ladder below), **GDELT**
(keyless news query), and **RSS** (per-topic outlet feeds) adapters behind `SourcePort`, plus the
`CoverageReport` (P1) — `gather` polls them, stores results, and prints what was queried, counts per
source, and what it could NOT see (TikTok/Instagram are always-declared blind spots).

Phase 3 (merged): **Analysis**. Single-linkage clustering over embeddings into narratives,
**velocity** scoring (items/hour — the "is it happening?" signal, P5), and LLM **claim extraction**
tagged by evidence type (P4) via Haiku 4.5 over the Message Batches API with a prompt-cached system
prompt and structured JSON output. `analyze` clusters, scores, and extracts.

**Blind-spot reference signal** (`src/analysis/references.ts`): we can't see TikTok/Instagram, but
we measure how hard the _reachable_ sources point at them — how many items reference a blind spot,
whether they converge on the same target, and how fast it's accelerating. This **augments** the
blind-spot declaration (never replaces it): it's a measure of _attention_, not content, and links
can be gamed, so it's surfaced as a lead, not proof. The parallax move — locating the unseen by the
pull it exerts on the visible.

### Reddit access in 2026 (the shrinking door)

Reddit locked down hard: self-service OAuth registration closed under the Responsible Builder Policy
(Nov 2025), and the keyless public `.json` mirrors started returning 403 (May 2026). The adapter
walks a degradation ladder instead of going dark:

1. **OAuth** (`REDDIT_CLIENT_ID`/`SECRET`) — credentials issued before the lockdown keep working;
   new ones need manual approval from Reddit.
2. **Public RSS** (keyless, automatic fallback) — Reddit's `.rss` search/listing feeds still work
   without auth. Live content, same as the site, but thinner: no scores/comment counts, and
   rate-limited per IP, so poll gently.
3. **Neither** → the run reports Reddit as a coverage gap (P1), loudly, rather than pretending.

### Web UI

`deno task serve` starts the web driver over the exact same pipeline (`src/pipeline.ts`) the CLI
uses: gather sources, generate a briefing, and read it with coverage foregrounded, narratives ranked
by velocity, evidence-tagged claims, and provenance links on everything. Dark mode by default
(toggle in the header). Binds localhost; see `SECURITY.md` §3a before exposing it.

Phase 4 (in progress): the **Briefing** — the finale. `brief "<topic>"` reads the stored corpus,
clusters it into narratives ranked by **velocity** (P5), labels them and extracts **evidence-tagged
claims** (P4) via Claude, derives the **coverage report** (P1, blind-spot signal included) from what
the corpus actually holds, and renders one structured briefing: provenance on every surfaced item
(P3), coverage gaps foregrounded, claims with verify-hints, and an optional synthesis **overview**
(Sonnet/Opus) that describes and attributes but renders **no verdict and recommends no action**
(P2). The LLM steps are optional — without `ANTHROPIC_API_KEY` the full structure still prints, with
labels and prose omitted rather than faked.

### Historical research (see `historical-research-plan.md`)

Every adapter used to be recency-windowed by construction (GDELT `timespan: "1d"`, Reddit
`sort=new`), and retrieval had no relevance floor — so a query for an old, specific story could
silently surface _whatever's nearest in the corpus_, however unrelated, and present it as if it were
a real match. Closed so far:

- **Similarity floor (P1).** `match`/`analyze`/`brief` all take `--min-similarity` (default set on
  the corpus). Nothing below the floor is returned; when nothing clears it, the run says so plainly
  instead of rendering an empty or fabricated result. Narratives now carry **relevance** (mean
  topic-similarity) alongside velocity, in the CLI and the web UI.
- **GDELT** defaults to a much wider `timespan` and accepts an explicit
  `startdatetime`/`enddatetime` range instead of the old 1-day window.
- **Reddit** can search `sort=relevance&t=all` instead of the recency-biased `sort=new` default.
- `gather --since <date> --until <date>` switches both of the above into historical mode in one
  step. The web UI has matching Since/Until and Min-similarity inputs.

Bluesky historical search (`app.bsky.feed.searchPosts`, a second adapter mode alongside the live
Jetstream firehose) is **deferred** per the plan — real work, sequenced last, only once the cheaper
fixes above are shown not to be enough for the case at hand.
