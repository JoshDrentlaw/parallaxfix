# Historical-research plan

Written up after a real post-mortem run: a query for `"Dance Gavin Dance", "singer", "abuse"` —
about a specific, multi-year-old controversy (the Tilian Pearson accusations) — surfaced nothing
about the actual incident and instead produced narratives about Chris Brown and the Lostprophets
singer's death. Root-caused below; this doc is the plan to close the gap, not the postmortem itself.

## What's actually going on

Two independent problems, compounding:

1. **Every adapter is recency-windowed, not archival.** None of them can reach a multi-year-old
   story:
   - **Bluesky**: Jetstream is a live firehose. `listen`/`ingest` only see what streams by while the
     command runs — zero historical reach, by construction.
   - **GDELT** (`src/ingestion/gdelt.ts`): defaults to `timespan: "1d"`.
   - **Reddit** (`src/ingestion/reddit.ts`): public-RSS path uses `sort: "new"` with no time filter,
     and OR-joins keywords (`"Dance Gavin Dance" OR singer OR abuse`) — recency-biased and loosely
     scoped, not a targeted historical search.
   - **RSS**: only polls feeds configured on the topic; no discovery of old articles you don't
     already have a URL for.

2. **Retrieval has no relevance floor**, so the tool can never say "nothing good matched."
   `CorpusPort.retrieve()`/`retrieveForAnalysis()` (`src/corpus/store.ts`) always return the top-k
   _nearest_ vectors in the corpus, however weak the actual cosine similarity. Worse, the similarity
   score is dropped entirely once clustering happens — `Cluster` / `BriefingNarrative`
   (`src/ports.ts`) carry `velocity`, never relevance, and the web UI only ever renders velocity. So
   when the real topic isn't in the corpus, whatever's _closest_ (however irrelevant) gets labeled
   and presented as a legitimate narrative.

Neither of these is mandated by the spec — `parallax-fix-spec.md`'s only relevant non-goal is "not a
real-time always-on monitor... on-demand runs first," which is about scheduling (pull, not push),
not about how far back a single run can see. The narrow windows are implementation defaults, not a
design constraint, so they're fixable without a redesign — except Bluesky, which needs new work (see
below).

## Plan

### 1. Similarity floor + relevance surfacing — do this regardless of use case

Fixes false-confidence output for _both_ live monitoring and historical research.

- Add a minimum-cosine-similarity cutoff to `CorpusPort.retrieve()` and `retrieveForAnalysis()` —
  configurable, sane default TBD empirically (start conservative, tune against real queries).
- Thread relevance through to `Cluster` / `BriefingNarrative` (currently velocity-only) so a
  briefing can report per-narrative topic relevance, not just rate of change.
- Surface it in both the CLI (`match` already prints `sim`; `brief`/`analyze` don't) and the web UI
  (`app.js` currently renders velocity only).
- When nothing clears the floor: say so explicitly, in the same P1-honest spirit as coverage gaps —
  "no strong matches for this topic" is a real, first-class answer, not empty output to explain
  away.

### 2. GDELT: widen the query window

- Replace the hardcoded `timespan: "1d"` with either a much wider default or explicit
  `startdatetime`/`enddatetime` params (GDELT DOC 2.0 supports both) driven by the topic/CLI args.
- Verify GDELT's actual practical archive depth for the DOC query API empirically — don't assume;
  the spec's own "Source Reality" section warns to re-verify access assumptions before relying on
  them.
- Cheapest fix in this plan — parameter change, not new code.

### 3. Reddit: try relevance + all-time

- Add `sort=relevance&t=all` as an option (today it's hardcoded to `sort=new`, no `t`) for queries
  that want history over freshness.
- Set expectations: keyless public-RSS search is thinner than full API / Pushshift-era access (see
  the comment in `reddit.ts`), so a specific old thread that isn't being re-linked today may still
  not surface. This narrows the gap; it doesn't close it.

### 4. Bluesky: historical search is a new adapter, not a parameter

- Jetstream (current) is fundamentally live-only — no amount of config fixes that.
- AT Protocol has a separate `app.bsky.feed.searchPosts` REST endpoint with real keyword +
  date-range history search. A historical-research run would need a second Bluesky adapter mode
  using that endpoint instead of/alongside Jetstream.
- Real work, not a quick win — sequence this last, and only if Bluesky specifically matters for the
  kind of history you're chasing (items 2–3 may already get you most of the way for Reddit/news-led
  stories).

## Suggested order

1. Similarity floor + relevance surfacing (unconditionally worth it)
2. GDELT date-range widening (cheap, immediate payoff for news-led stories)
3. Reddit relevance/all-time params (cheap, uncertain payoff — test against a known case like the
   DGD query before committing further)
4. Bluesky historical-search adapter (defer until 1–3 are in and you've re-tested whether they're
   enough)

## Where this gets built

Runners are confirmed working (`development` → nucklehead auto-deploy, verified end-to-end). Actual
implementation work for this plan happens off nucklehead — via normal PRs against `development` from
wherever development actually happens (e.g. Claude Code Web) — and lands here automatically once
merged.
