/**
 * Continuous, multi-topic Bluesky ingest — the always-on replacement for the
 * CLI's manual `deno task ingest`. Owns ONE shared Jetstream connection for
 * the whole process (not one per topic) and watches the union of every
 * currently-saved topic, so a topic created through the web UI starts being
 * watched without any per-topic wiring.
 *
 * Deliberately minimal: Bluesky is a small, shrinking source (~3.7M DAU as of
 * 2026) whose relevance here is a demographic-skew argument (politically
 * engaged users), not a mass-reach one — that doesn't justify heavy
 * resilience engineering. If the single connection drops, it stays stopped
 * for the rest of the process's life; the next chance to ingest is the next
 * restart (routine anyway, since nucklehead deploys on every push). No
 * reconnect loop, no backoff, no cursor-resume.
 */

import type { CorpusPort, Item, SourcePort, TopicDefinition } from "../ports.ts";
import { PgCorpus } from "../corpus/store.ts";
import { LocalEmbedder } from "../corpus/embed.ts";
import { BlueskyJetstreamAdapter } from "./bluesky.ts";
import { adHocTopic, listTopics, matchesAnyTopic, TOPICS_DIR } from "./topic.ts";

/** How often to re-read config/topics/ so newly created/edited topics take effect. */
const TOPIC_REFRESH_MS = 30_000;
/** Batch a write to the corpus at this many matched items... */
const BATCH_SIZE = 16;
/** ...or after this long since the last flush, whichever comes first. */
const BATCH_FLUSH_MS = 5_000;

export type IngestState = "disabled" | "idle" | "connecting" | "connected" | "stopped";

export interface IngestStatus {
  state: IngestState;
  topicsWatched: number;
  /** Process-lifetime count of items matched against a topic and stored. */
  totalItemsIngested: number;
  /** Last raw commit observed from the firehose — proves liveness even at 0 matches. */
  lastEventAt: Date | null;
  lastError: { message: string; at: Date } | null;
}

export interface BlueskyServiceDeps {
  /** Build + init the corpus once, at service start. Defaults to a real PgCorpus (LocalEmbedder). */
  openCorpus?: (databaseUrl: string) => Promise<CorpusPort & { close(): Promise<void> }>;
  /** List currently saved topics. Defaults to listTopics(topicsDir). */
  listTopics?: (dir: string) => Promise<TopicDefinition[]>;
  /** Build the shared source. Defaults to a real BlueskyJetstreamAdapter. */
  createSource?: (opts: { signal: AbortSignal }) => SourcePort;
  now?: () => Date;
  /** Test seam for TOPIC_REFRESH_MS — real callers should never need this. */
  refreshIntervalMs?: number;
}

async function defaultOpenCorpus(
  databaseUrl: string,
): Promise<CorpusPort & { close(): Promise<void> }> {
  const corpus = new PgCorpus({ databaseUrl, embedder: new LocalEmbedder() });
  await corpus.init();
  return corpus;
}

export interface BlueskyIngestServiceOptions {
  databaseUrl: string;
  /** Where saved topics live. Defaults to TOPICS_DIR. */
  topicsDir?: string;
  /** Aborted to trigger a graceful stop (mirrors SourcePort's own signal-owns-lifecycle convention). */
  signal: AbortSignal;
  deps?: BlueskyServiceDeps;
}

/**
 * A single shared Jetstream subscription, filtered client-side against every
 * saved topic at once. `start()` returns immediately; the loop runs in the
 * background. `stop()` awaits a clean shutdown (flush + corpus.close()) —
 * callers must abort the constructor's `signal` (typically alongside calling
 * `stop()`, matching `SourcePort`'s own "signal owns lifecycle" convention),
 * since that's what actually ends an in-progress connection; `stop()` alone
 * only ends an *idle* wait.
 */
export class BlueskyIngestService {
  readonly #databaseUrl: string;
  readonly #topicsDir: string;
  readonly #signal: AbortSignal;
  readonly #deps: Required<BlueskyServiceDeps>;

  #status: IngestStatus = {
    state: "idle",
    topicsWatched: 0,
    totalItemsIngested: 0,
    lastEventAt: null,
    lastError: null,
  };
  #topics: TopicDefinition[] = [];
  #refreshTimer: ReturnType<typeof setInterval> | undefined;
  /** Set on the one and only connection attempt this service ever makes — never reset. */
  #connectionAttempted = false;
  /** The in-flight (or already-settled) #connectOnce call, if any has started. */
  #connectPromise: Promise<void> | null = null;
  #runPromise: Promise<void> | null = null;
  #stopped = false;
  #resolveStop: (() => void) | null = null;

  constructor(opts: BlueskyIngestServiceOptions) {
    this.#databaseUrl = opts.databaseUrl;
    this.#topicsDir = opts.topicsDir ?? TOPICS_DIR;
    this.#signal = opts.signal;
    this.#deps = {
      openCorpus: opts.deps?.openCorpus ?? defaultOpenCorpus,
      listTopics: opts.deps?.listTopics ?? listTopics,
      createSource: opts.deps?.createSource ??
        ((o: { signal: AbortSignal }) => new BlueskyJetstreamAdapter({ signal: o.signal })),
      now: opts.deps?.now ?? (() => new Date()),
      refreshIntervalMs: opts.deps?.refreshIntervalMs ?? TOPIC_REFRESH_MS,
    };
  }

  status(): IngestStatus {
    return { ...this.#status };
  }

  /** Idempotent. Starts the background loop and returns immediately. */
  start(): void {
    if (this.#runPromise) return;
    this.#runPromise = this.#run().catch((err) => {
      this.#status = {
        ...this.#status,
        state: "stopped",
        lastError: {
          message: err instanceof Error ? err.message : String(err),
          at: this.#deps.now(),
        },
      };
    });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#refreshTimer !== undefined) clearInterval(this.#refreshTimer);
    this.#resolveStop?.();
    await this.#runPromise;
  }

  async #run(): Promise<void> {
    const corpus = await this.#deps.openCorpus(this.#databaseUrl);
    try {
      this.#topics = await this.#deps.listTopics(this.#topicsDir);
      this.#status = { ...this.#status, topicsWatched: this.#topics.length };

      this.#refreshTimer = setInterval(async () => {
        this.#topics = await this.#deps.listTopics(this.#topicsDir);
        this.#status = { ...this.#status, topicsWatched: this.#topics.length };
        // A topic didn't exist yet when we started — this is the only
        // "reconnect" this service does: starting for the first time once
        // there's something to watch. #connectionAttempted latches true the
        // instant a connection is made and never resets, so a dropped
        // connection is never retried here. Not awaited (setInterval can't
        // await its callback) — tracked via #connectPromise instead, so
        // shutdown below can still wait for it to finish flushing.
        if (!this.#connectionAttempted && !this.#stopped && this.#topics.length > 0) {
          this.#connectPromise = this.#connectOnce(corpus);
        }
      }, this.#deps.refreshIntervalMs);

      if (this.#topics.length > 0 && !this.#signal.aborted) {
        this.#connectPromise = this.#connectOnce(corpus);
      }

      // Wait until told to stop — no retry loop, so nothing else to
      // supervise. (No polling either: this resolves on the first of an
      // explicit stop() or the shared AbortSignal firing.)
      if (!this.#stopped && !this.#signal.aborted) {
        await new Promise<void>((resolve) => {
          if (this.#signal.aborted) return resolve();
          this.#signal.addEventListener("abort", () => resolve(), { once: true });
          this.#resolveStop = resolve;
        });
      }
      // A connection kicked off by the refresh timer (above) isn't awaited
      // there — wait for it here so the corpus doesn't close underneath a
      // still-flushing batch.
      await this.#connectPromise;
    } finally {
      if (this.#refreshTimer !== undefined) clearInterval(this.#refreshTimer);
      this.#status = { ...this.#status, state: "stopped" };
      await corpus.close();
    }
  }

  async #connectOnce(corpus: CorpusPort): Promise<void> {
    this.#connectionAttempted = true;
    this.#status = { ...this.#status, state: "connecting" };

    const source = this.#deps.createSource({ signal: this.#signal });
    let batch: Item[] = [];
    let lastFlush = this.#deps.now().getTime();

    const flush = async () => {
      if (batch.length === 0) return;
      const toWrite = batch;
      batch = [];
      lastFlush = this.#deps.now().getTime();
      await corpus.append(toWrite);
      this.#status = {
        ...this.#status,
        totalItemsIngested: this.#status.totalItemsIngested + toWrite.length,
      };
    };

    try {
      for await (const item of source.fetch(adHocTopic([]))) {
        this.#status = { ...this.#status, state: "connected", lastEventAt: this.#deps.now() };
        if (matchesAnyTopic(item, this.#topics)) batch.push(item);
        const dueByCount = batch.length >= BATCH_SIZE;
        const dueByTime = batch.length > 0 &&
          this.#deps.now().getTime() - lastFlush >= BATCH_FLUSH_MS;
        if (dueByCount || dueByTime) await flush();
        if (this.#signal.aborted || this.#stopped) break;
      }
      await flush();
    } catch (err) {
      await flush().catch(() => {});
      this.#status = {
        ...this.#status,
        lastError: {
          message: err instanceof Error ? err.message : String(err),
          at: this.#deps.now(),
        },
      };
    } finally {
      // No retry regardless of why the connection ended (clean close, error,
      // or an explicit stop) — the next chance to ingest is a process restart.
      this.#status = { ...this.#status, state: "stopped" };
    }
  }
}
