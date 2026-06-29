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

deno task brief "riverside city council recall"   # stub for the briefing CLI
```

Dev loop:

```sh
deno task check && deno task lint && deno task fmt && deno task test
```

## Status

Phase 0: project + security policy + Ports + the **Bluesky/Jetstream adapter** (the keystone source)
streaming normalized `Item`s via `listen`, with unreachable sources reported as coverage gaps (P1).
Corpus, more sources, analysis, and briefing land in subsequent phases — see the spec's Build Plan.
