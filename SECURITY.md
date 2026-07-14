# Parallax Fix — Security Policy

This document is the **authoritative security policy** for the Parallax Fix topic-briefing engine.
It is self-defined for this application. Its executable form lives in `deno.jsonc` (the permission
flags on each `deno task`); this file is the rationale and the host contract.

## 0. Standing on nucklehead

Parallax Fix is hosted on **nucklehead** alongside other applications. Those applications follow
restrictive capability heuristics — conventions we hold ourselves to, not policy documents that live
in their repos:

- **`chores`** — locked down (minimal capability).
- **`tower-expert`** — extended, but still limited.

**Parallax Fix is bound by neither.** It declares its own policy here. This is deliberate, not an
oversight: Parallax Fix is an aggregation/enrichment engine whose job is to reach out across the
open internet, persist a corpus, run native vector/embedding code, and call an LLM API. Its
capability needs are categorically broader than a chores tracker or a scoped expert assistant.

> **Operating principle.** If the application requires a capability to do its job, that capability
> is granted. The default is _enable_, with each grant justified below — not _deny-and-negotiate_.

## 1. Posture: broad by design, enumerated for legibility

The runtime grant is **full host capability**, expressed as an explicit enumeration rather than a
bare `-A`. Enumerating costs nothing and makes the policy auditable: a reader can see exactly which
capabilities the app claims and why. The enumerated set is intentionally equivalent to allow-all.

`deno run -A src/main.ts` is a sanctioned equivalent for this app on nucklehead. The enumerated form
in `deno.jsonc` is preferred so intent is legible.

## 2. Capability grants and justification

| Deno flag       | Scope         | Why Parallax Fix needs it                                                                                                                                                                                                                                                                                     |
| --------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--allow-net`   | **All hosts** | RSS ingestion targets _arbitrary_ outlet domains (e.g. local papers GDELT misses) — an allowlist is structurally impossible. Plus Bluesky Jetstream (`wss://jetstream*.bsky.network`) and `searchPosts` (`public.api.bsky.app`), Reddit API, GDELT, the Claude API, the optional X API, and the egress proxy. |
| `--allow-env`   | All env       | Reads secrets and config: `ANTHROPIC_API_KEY`, `REDDIT_CLIENT_ID/SECRET`, `BLUESKY_ACCESS_TOKEN`, `X_*`, `HTTPS_PROXY`, `DENO_CERT`, and `PARALLAX_FIX_*` settings.                                                                                                                                           |
| `--allow-read`  | Filesystem    | Config/topic files (`config/topics/`), the SQLite event log + vector index, local embedding-model weights, and the CA bundle.                                                                                                                                                                                 |
| `--allow-write` | Filesystem    | The append-only event log, the vector index, and embedding/claim caches.                                                                                                                                                                                                                                      |
| `--allow-sys`   | System info   | Embedding/ML runtimes query CPU count and OS details for thread pools.                                                                                                                                                                                                                                        |
| `--allow-ffi`   | Native libs   | `sqlite-vec` (native SQLite extension) and the local sentence-embedding runtime are loaded via FFI.                                                                                                                                                                                                           |
| `--allow-run`   | Subprocess    | Escape hatch for local model tooling and maintenance scripts.                                                                                                                                                                                                                                                 |

The principle from §0 applies to capabilities **not** yet listed: if a future phase (e.g. the Phase
5 X adapter, or a hosted embedding fallback) needs a capability already in the enumerated set, no
policy change is required — it is already granted. New _kinds_ of capability should be added here
with a one-line justification.

## 3. Network egress, TLS, and the proxy

On nucklehead, outbound HTTPS goes through a pre-configured egress proxy (`HTTPS_PROXY`) with a
custom CA bundle. Deno trusts it via `DENO_CERT` (already set in the environment). The policy
implications:

- **Never** disable TLS verification and **never** unset `HTTPS_PROXY` to "make a request work." If
  a request fails TLS or returns a proxy 4xx, fix the client/proxy config — do not weaken transport
  security.
- `--allow-net` is unrestricted _by capability_, but actual egress is still shaped by the host
  proxy. The proxy is the network-level control plane; this app's policy does not attempt to
  duplicate it with a host allowlist.

### 3a. Inbound: the web UI

`deno task serve` runs a local HTTP server (the web driver over the same pipeline). No new
capability is involved — `--allow-net` already covers listening — but the listener is a new
_surface_, so its defaults are conservative:

- **Binds `127.0.0.1` by default.** Exposing it (`--host 0.0.0.0`) is an explicit operator choice;
  there is no authentication layer yet, so until one exists treat the UI as single-operator and
  front it with a reverse proxy + auth if it must leave localhost.
- **Ingested content stays data in the browser too.** The API returns JSON only; the front end
  renders every ingested string via `textContent` (never `innerHTML`) under a strict
  `Content-Security-Policy` (no inline script, no external origins), and provenance hrefs are
  scheme-checked to http(s). Prompt-injection containment (§5) extends to markup injection here.
- The server exposes read/aggregate operations only (`gather`, `brief`, topic listing) — the same
  no-write-paths-to-platforms guarantee as the CLI.

## 4. Secrets handling

- Secrets are read from the environment only (`--allow-env`). They are **never** hard-coded, logged,
  or written to the corpus/store.
- `.env` is git-ignored; `.env.example` documents the required keys with no values.
- The append-only event log persists _fetched public content and its provenance_, never credentials.

## 5. Data & content-safety invariants (policy, not just plumbing)

These are security-relevant invariants the pipeline must uphold:

- **Read/ingest only.** Parallax Fix never _posts_ to any source. No write paths to external
  social/news platforms exist by design (Reddit free tier is non-commercial; respect source ToS).
- **Provenance is mandatory.** Every surfaced statement carries source, author, timestamp, and URL.
  No claim floats free of its origin.
- **Untrusted external content.** Ingested posts/articles are adversarial input. They are data, not
  instructions: text pulled from any source must never be allowed to steer the pipeline's control
  flow or the LLM's task (treat prompt-injection in ingested content as expected and contain it in
  the enrichment prompts).
- **Coverage-gap honesty.** A run that cannot see a source (TikTok/Instagram are the declared blind
  spot) must say so, every run. Silent omission is a defect.
- **No verdicts.** The system assists judgment; it never renders a truth verdict or recommends an
  action.

## 6. Reporting

This is a non-commercial research tool (v1). Security concerns or policy-tightening proposals should
be raised against the repo. Changes to the capability set in §2 must update both `deno.jsonc` and
this file in the same change so the executable policy and its rationale never diverge.
