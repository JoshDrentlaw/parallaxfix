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

# Analysis (clusters → velocity → claims; claim extraction needs ANTHROPIC_API_KEY):
deno task start analyze --topic config/topics/riverside-recall.json -k 200

# Briefing (Phase 4): cluster → label → claims → coverage → structured briefing
deno task brief "riverside city council recall"
deno task brief --topic config/topics/riverside-recall.json -k 200
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

Phase 2 (merged): more sources + **coverage**. **Reddit** (app-only OAuth, poll), **GDELT** (keyless
news query), and **RSS** (per-topic outlet feeds) adapters behind `SourcePort`, plus the
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

Phase 4 (in progress): the **Briefing** — the finale. `brief "<topic>"` reads the stored corpus,
clusters it into narratives ranked by **velocity** (P5), labels them and extracts **evidence-tagged
claims** (P4) via Claude, derives the **coverage report** (P1, blind-spot signal included) from what
the corpus actually holds, and renders one structured briefing: provenance on every surfaced item
(P3), coverage gaps foregrounded, claims with verify-hints, and an optional synthesis **overview**
(Sonnet/Opus) that describes and attributes but renders **no verdict and recommends no action**
(P2). The LLM steps are optional — without `ANTHROPIC_API_KEY` the full structure still prints, with
labels and prose omitted rather than faked.
