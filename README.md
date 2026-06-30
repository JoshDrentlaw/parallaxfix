# Hand Terminal

Topic-scoped briefing engine: coalesces news + social discussion into a single structured briefing
built for _intent_ rather than doomscrolling. Provenance on every item, explicit coverage gaps, no
verdicts.

See [`hand-terminal-spec.md`](./hand-terminal-spec.md) for the full build spec and
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
deno task match  --topic config/topics/riverside-recall.json -k 20 --explain  # ranked + score legend

deno task brief "riverside city council recall"   # stub for the briefing CLI
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

Phase 1 (in progress): the **Corpus** — a Postgres + pgvector append-only store with embeddings
(`bge-small-en-v1.5`) and **semantic topic matching** (`ingest` → embed/store, `match` → ranked
retrieval). More sources, analysis, and briefing land in subsequent phases — see the spec's Build
Plan.
