# Parallax Fix — Topic Briefing Engine

> **The name.** _Parallax_ — you take in the same subject from different sources at different focus
> points, and the shift between those views is what locates it. _Fix_ — both the navigational
> reading you triangulate from those views and, quickly, the verb of the app: "I need to get a fix
> on that." A topic-scoped aggregator that coalesces news + social discussion into a single
> briefing, built for _intent_ rather than doomscrolling.

This document is the build spec for Claude Code. Read it top to bottom before writing code. The
**Design Philosophy** and **Source Reality (2026)** sections are load-bearing — they encode
constraints and decisions that are not obvious from the code and that change faster than training
data. Do not silently "optimize" them away.

---

## 1. Goal & Non-Goals

**Goal.** Given a _topic_ (keywords + entities + a natural-language description), produce an
on-demand **briefing** that answers three questions:

1. **Is this even happening?** — Is there measurable volume/velocity of discussion, or is it noise?
2. **What is the shape of the conversation?** — What distinct narratives/clusters exist, who's
   saying what?
3. **What is actually checkable?** — Which discrete claims are made, which are backed by a primary
   source, and where would I verify the rest?

The output is a _structured briefing with provenance and explicit coverage gaps_ — **not** a feed to
scroll, and **not** a verdict.

**Non-Goals (v1).**

- Not a real-time always-on monitor. On-demand runs first; scheduling is a later phase.
- Not a social-media _posting_ tool. Read/ingest only.
- Not a recommendation/verdict engine. It never tells the user what to conclude or do (see
  Philosophy P2).
- Not a TikTok/Instagram scraper. Those are a declared blind spot, not a target (see Source
  Reality).
- Not a commercial product in v1. This matters for source ToS (Reddit free tier is non-commercial).

---

## 2. Design Philosophy (non-negotiable)

These are the principles that make this a research instrument instead of a faster outrage hose.

**P1 — Coverage-gap honesty is a first-class output.** Absence of signal is not absence of the
thing. The system MUST report what it did and did not look at. A run that can't see TikTok must _say
so_, prominently, every time — because the thing being investigated may live exactly where the
system is blind. A silent omission is a bug, not a simplification.

**P2 — Assist judgment; never automate the verdict.** The pipeline clusters, counts, extracts
claims, and attaches provenance. It stops there. It does not emit "you should boycott / this is true
/ this is fake." The human makes the call; the system just lays the evidence on the desk pre-sorted.

**P3 — Provenance on every item.** Every surfaced statement traces to a source URL, author handle,
timestamp, and platform. No claim floats free of its origin.

**P4 — Separate the verifiable from the asserted.** A donation record and "I heard they hate
immigrants" are different epistemic objects. Tag every extracted claim with its evidence type
(primary-record / reported / opinion / unsourced-assertion).

**P5 — Velocity over volume for the "is it happening" signal.** Three angry posts and no
acceleration is noise; a cluster doubling hourly is an event. Rank by velocity, not raw count.

---

## 3. Source Reality (2026) — read before building adapters

The whole architecture is shaped by what's actually reachable. Current as of mid-2026; **re-verify
before relying on any paid tier** (X changed its model twice in four months).

| Source                    | Access                                       | Cost                                                                | Notes for the adapter                                                                                                                                                                                                        |
| ------------------------- | -------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bluesky (AT Protocol)** | **Open firehose, no API key, no app review** | Free                                                                | **The keystone.** Use **Jetstream** (`wss://jetstream*.bsky.network/subscribe`) for simplified JSON over WebSocket; filter with `wantedCollections=app.bsky.feed.post`. ~6 lines to a live stream. Build this adapter first. |
| **Reddit**                | Free tier OK for **non-commercial/research** | Free (strict)                                                       | ~100 req/min, ~10k/mo, **pull-based (no webhooks — you must poll)**. Fine for a personal tool; commercial use jumps to ~$12k/mo, so keep v1 non-commercial.                                                                  |
| **News (GDELT)**          | Open query API                               | Free                                                                | "Coalesce news articles" half. Query by topic for coverage volume, tone, and source spread.                                                                                                                                  |
| **News (RSS)**            | Open                                         | Free                                                                | Per-outlet feeds, including local (e.g. Raincross Gazette for Riverside). Good for outlets GDELT misses.                                                                                                                     |
| **X / Twitter**           | **No usable free read tier**                 | Pay-per-use (~$0.005/post read, 2M/mo cap) or 3rd-party (~$0.05/1k) | Gate behind a config flag, **off by default**. Phase 5 only. Treat as optional enrichment, never a dependency.                                                                                                               |
| **TikTok / Instagram**    | **Effectively closed** to automated access   | — (paid scrapers + ToS risk)                                        | **Do NOT build core ingestion here.** This is the declared blind spot (P1). The most likely place a _local_ story breaks — which is precisely why the briefing must announce that it can't see it.                           |

**Implication to internalize:** a 2026 open-source briefing is structurally lopsided toward
Bluesky/Reddit/news and blind to short-video platforms. That's acceptable _if and only if_ the tool
declares it (P1).

---

## 4. Architecture

Ports-and-adapters (hexagonal). Each external source sits behind a `SourcePort`; the core pipeline
never imports a vendor SDK directly. Stages communicate through the normalized `Item` type and an
append-only store.

```
              ┌─────────────────────────────────────────────────────────┐
ingestion     │  SourcePort adapters                                    │
(per source)  │  Bluesky(Jetstream) · Reddit · GDELT · RSS · [X*]       │
              └───────────────┬─────────────────────────────────────────┘
                              │ raw events
              ┌───────────────▼───────────────┐
normalize     │  Normalizer → Item             │   one schema, all sources
              └───────────────┬───────────────┘
              ┌───────────────▼───────────────┐
store         │  Event log (append-only)       │   source of truth
              │  + Vector index (embeddings)   │   semantic retrieval/dedup
              └───────────────┬───────────────┘
              ┌───────────────▼───────────────┐
enrich        │  Dedup → Cluster (narratives)  │   embeddings + clustering
              │  → Velocity scoring            │   "is it happening?"
              │  → Claim extraction (LLM)      │   batch + cached
              │  → Evidence-type tagging (LLM) │
              └───────────────┬───────────────┘
              ┌───────────────▼───────────────┐
brief         │  Briefing generator (LLM)      │   synthesis, provenance,
              │  + CoverageReport assembler    │   explicit gaps (P1)
              └───────────────┬───────────────┘
              ┌───────────────▼───────────────┐
present       │  CLI first → simple web later  │   briefing, not a scroll
              └───────────────────────────────┘
```

**Bounded contexts** (keep these seams clean for DDD):

- _Ingestion_ — adapters + normalization. Knows about vendors; knows nothing about clustering.
- _Corpus_ — storage + embeddings + retrieval. Knows about `Item`s and vectors; nothing about
  sources.
- _Analysis_ — dedup, clustering, velocity, claim extraction. Pure over the corpus.
- _Briefing_ — synthesis + coverage reporting + presentation.

---

## 5. Data Model

```python
Item:
    id: str                  # stable hash of (source, source_id)
    source: str              # "bluesky" | "reddit" | "gdelt" | "rss" | "x"
    source_id: str           # platform-native id
    author: str | None       # handle/username; None for some news
    text: str
    url: str                 # permalink to the original (provenance, P3)
    created_at: datetime
    fetched_at: datetime
    engagement: dict         # {likes, reposts, replies, score, ...} best-effort
    parent_ref: str | None   # for replies/threads
    embedding: list[float] | None
    raw: dict                # original payload, for debugging/reprocessing

Cluster:                     # a "narrative"
    id: str
    item_ids: list[str]
    centroid: list[float]
    label: str               # LLM-generated short description
    first_seen: datetime
    velocity: float          # items/hour, slope of recent volume
    size: int

Claim:
    id: str
    text: str                # the discrete factual assertion, normalized
    cluster_id: str
    evidence_type: str       # "primary_record" | "reported" | "opinion" | "unsourced"
    supporting_item_ids: list[str]
    verify_hint: str | None  # where a human could check (e.g. "FEC.gov", "Cal-Access Power Search", "USASpending")

CoverageReport:              # P1 made concrete
    topic_id: str
    run_at: datetime
    sources_queried: list[str]
    items_per_source: dict[str, int]
    sources_unavailable: list[dict]   # [{"source": "tiktok", "reason": "no automated access"}]
    window: tuple[datetime, datetime]

TopicDefinition:
    id: str
    keywords: list[str]
    entities: list[str]      # names, orgs, places to disambiguate
    description: str         # natural-language; embedded for semantic matching
    exclude: list[str]       # negative keywords to cut noise
```

Topic matching is **semantic, not just keyword**: embed `description` + `keywords`, retrieve nearest
items from the vector index, then apply keyword/entity filters and `exclude` terms. This is where
the RAG skillset pays off — keyword-only matching is too brittle for messy social text.

---

## 6. The LLM / Enrichment Layer (Claude API)

Two LLM jobs: **per-item extraction** (high volume, structured) and **final synthesis** (low volume,
quality). Route by stage; the cost levers below make the high-volume pass cheap.

**Model routing (three-tier lineup is stable):**

- **Haiku 4.5** (`claude-haiku-4-5-20251001`, $1/$5 per MTok) — per-item claim extraction &
  evidence-type tagging. High volume, structured output, cheap.
- **Sonnet 4.6** (`claude-sonnet-4-6`, $3/$15) — cluster labeling and the default briefing
  synthesis. Good price/quality balance.
- **Opus 4.8** (`claude-opus-4-8`, $5/$25) — reserve for hard synthesis runs where reasoning quality
  matters.

**Cost levers — use all three on the extraction pass:**

- **Batch API** — 50% off input+output, async (results typically within 1–2h, max 24h). The per-item
  extraction sweep is the textbook batch workload: high volume, latency-tolerant, offline.
- **Prompt caching** — cache reads cost ~10% of input (90% off). Put the _static_ extraction system
  prompt + JSON schema + few-shot examples behind a `cache_control` breakpoint so every item reuses
  them. Mind the minimums (Haiku ≥1,024 tokens cached; Sonnet/Opus ≥2,048).
- **Combined**, batch + caching can reach ~95% reduction on the repeated-context portion.

Practical pattern: serialize the frozen extraction prompt once → cache it → fan out N items through
the Batch API → collect structured `Claim` objects. The briefing synthesis is a single (or few)
synchronous Sonnet/Opus call(s) over the _clustered, deduped_ material, not the raw firehose.

**Hard rule (P2):** the synthesis prompt asks for _description, clustering, claims, provenance, and
coverage gaps_. It is explicitly instructed **not** to recommend an action or render a truth
verdict. If the model starts editorializing, that's a prompt bug to fix, not a feature.

> Anthropic product details (models, batch, caching, Files API) shift; confirm against the current
> docs: https://docs.claude.com/en/api/overview

---

## 7. Tech Decisions

Flagged as decisions, with a recommendation, because they're the user's call.

**Decision 1 — Language/runtime.**

- _Recommended:_ **Python** for the pipeline — strongest embeddings/vector/RAG ecosystem, and the
  Jetstream + atproto + Reddit clients are all first-class.
- _Strong alternative:_ **TypeScript/Node** if a single language front-to-back is appealing;
  Jetstream is trivial over a WS client and async fits the streaming model well.
- _Possible but not recommended for v1:_ PHP or Kotlin — atproto client libs exist in both, so
  reusing existing skills is viable, but you'll fight the ML ecosystem on embeddings/clustering.

**Decision 2 — Storage + vector index.**

- _Zero-infra MVP:_ **SQLite + sqlite-vec** — single file, event log and vectors in one place.
- _Recommended for growth:_ **Postgres + pgvector** — one store for the append-only log and the
  vector index; clean upgrade path.
- _If you want a dedicated vector DB:_ Qdrant or Chroma behind the `CorpusPort`.

**Decision 3 — Embeddings.**

- _Recommended:_ a **local** sentence-embedding model (free, private, no per-call cost) behind an
  `EmbeddingPort`, swappable for a hosted embedding API later if quality demands it.

**Decision 4 — Clustering.** Start simple: HDBSCAN or agglomerative clustering over embeddings, with
velocity computed from each cluster's item timestamps. Don't over-engineer; this is tunable later.

---

## 8. Build Plan (phased — ship each phase working)

**Phase 0 — Skeleton.** Repo, config, the `SourcePort` / `CorpusPort` / `EmbeddingPort` / `LLMPort`
interfaces, and a `TopicDefinition` loader. One adapter — **Bluesky/Jetstream** — streaming filtered
posts to the console as normalized `Item`s. Proves the seam end-to-end.

**Phase 1 — Corpus.** Append-only store + embeddings + vector index. Implement semantic topic
matching (embed topic → retrieve → keyword/entity/exclude filter). Output: a ranked list of relevant
`Item`s for a topic, deduped.

**Phase 2 — More sources + coverage.** Add **Reddit** (polling) and **GDELT + RSS** adapters.
Implement the `CoverageReport` (P1): what was queried, counts per source, and the hard-coded
"unavailable: tiktok, instagram" entries with reasons.

**Phase 3 — Analysis.** Clustering into narratives, velocity scoring ("is it happening?"), and the
LLM claim-extraction + evidence-type pass (Haiku, batched, cached).

**Phase 4 — Briefing + presentation.** Synthesis into a structured briefing (Sonnet/Opus) with
provenance and the coverage-gaps section foregrounded. CLI presentation: `brief "<topic>"`.

**Phase 5 — Optional/advanced.** X adapter behind an off-by-default flag (with cost warnings);
scheduling/persistence for recurring topics; simple web UI. Only after 0–4 are solid.

---

## 9. Suggested Repo Structure

```
parallax-fix/
  CLAUDE.md                 # seed below
  pyproject.toml
  config/
    topics/                 # one file per saved TopicDefinition
  src/
    ports/                  # SourcePort, CorpusPort, EmbeddingPort, LLMPort (interfaces)
    ingestion/
      bluesky.py            # Jetstream adapter (build first)
      reddit.py
      gdelt.py
      rss.py
      x.py                  # phase 5, flag-gated
      normalize.py
    corpus/
      store.py              # append-only event log
      vectors.py            # embedding index
      retrieve.py           # semantic topic matching
    analysis/
      cluster.py
      velocity.py
      claims.py             # LLM extraction (batched + cached)
    briefing/
      synthesize.py         # LLM synthesis (P2-constrained prompt)
      coverage.py           # CoverageReport assembler (P1)
    cli.py
  tests/
```

---

## 10. Open Decisions for the user to confirm before Phase 1

1. Language: Python (recommended) / TypeScript / stay in PHP-Kotlin?
2. Store: SQLite+sqlite-vec (MVP) / Postgres+pgvector (growth)?
3. Embeddings: which local model, or a hosted one?
4. How are topics authored — hand-written config files, or an interactive `topic new` flow?
5. Run model for v1: purely on-demand CLI, or persist runs for later diffing?

---

## Appendix — CLAUDE.md seed

> Drop this into the repo root so Claude Code keeps the philosophy in context.

```markdown
# Parallax Fix — context for Claude Code

Topic-briefing engine. Aggregates Bluesky + Reddit + news into a structured briefing with provenance
and explicit coverage gaps. See parallax-fix-spec.md for the full spec.

## Invariants (do not violate)

- Coverage gaps are a first-class output. If a source wasn't queried or is unreachable (TikTok,
  Instagram), the briefing must say so, every run. Never omit silently.
- The system assists judgment; it never renders a verdict or recommends an action.
- Every surfaced statement carries provenance: source, author, timestamp, URL.
- Tag claims by evidence type: primary_record / reported / opinion / unsourced.
- Rank by velocity (rate of change), not raw volume.

## Architecture

- Ports-and-adapters. Core never imports a vendor SDK; everything crosses a Port.
- Bounded contexts: ingestion / corpus / analysis / briefing.
- Normalized `Item` is the lingua franca between stages.

## Source rules

- Bluesky Jetstream is free, keyless — the keystone. Build its adapter first.
- Reddit free tier is non-commercial and pull-based (poll, no webhooks). Keep v1 non-commercial.
- X is pay-per-use, off by default, phase 5 only. TikTok/Instagram are a declared blind spot — not a
  target.

## LLM

- Route: Haiku 4.5 for per-item extraction (batched + prompt-cached); Sonnet 4.6 for synthesis; Opus
  4.8 only for hard runs.
- Use the Batch API (50% off) + prompt caching (90% off cached input) on the extraction sweep.
- The synthesis prompt must not editorialize or conclude. Description + evidence only.
```
