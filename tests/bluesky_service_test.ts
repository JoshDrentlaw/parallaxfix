import { assert, assertEquals } from "@std/assert";
import type { CorpusPort, Item, RankedItem, SourcePort, TopicDefinition } from "../src/ports.ts";
import { BlueskyIngestService } from "../src/ingestion/bluesky-service.ts";
import { adHocTopic } from "../src/ingestion/topic.ts";

function item(id: string, text: string): Item {
  return {
    id,
    source: "bluesky",
    source_id: id,
    author: "did:plc:test",
    text,
    url: `https://bsky.app/profile/did:plc:test/post/${id}`,
    created_at: new Date("2026-06-29T12:00:00.000Z"),
    fetched_at: new Date("2026-06-29T12:00:01.000Z"),
    engagement: {},
    parent_ref: null,
    embedding: null,
    raw: {},
  };
}

/** Controllable async-generator source — mirrors BlueskyJetstreamAdapter's own
 *  queue/wake-promise bridging (including honoring the abort signal it's
 *  constructed with, per SourcePort's "signal owns lifecycle" contract), but
 *  driven by test code instead of a socket. */
class FakeSource implements SourcePort {
  readonly name = "bluesky" as const;
  #queue: Item[] = [];
  #ended = false;
  #error: Error | null = null;
  #wake: (() => void) | null = null;

  constructor(signal: AbortSignal) {
    signal.addEventListener("abort", () => this.end(), { once: true });
  }

  push(it: Item) {
    this.#queue.push(it);
    this.#wake?.();
    this.#wake = null;
  }
  end() {
    this.#ended = true;
    this.#wake?.();
    this.#wake = null;
  }
  fail(err: Error) {
    this.#error = err;
    this.#ended = true;
    this.#wake?.();
    this.#wake = null;
  }

  async *fetch(): AsyncIterable<Item> {
    while (true) {
      while (this.#queue.length > 0) yield this.#queue.shift()!;
      if (this.#ended) {
        if (this.#error) throw this.#error;
        return;
      }
      await new Promise<void>((resolve) => (this.#wake = resolve));
    }
  }
}

class FakeCorpus implements CorpusPort {
  appended: Item[][] = [];
  closed = false;

  append(items: Item[]): Promise<void> {
    this.appended.push(items);
    return Promise.resolve();
  }
  retrieve(_topic: TopicDefinition, _k: number): Promise<RankedItem[]> {
    return Promise.resolve([]);
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

/** All items across every append() call, in order. */
function flatAppended(corpus: FakeCorpus): Item[] {
  return corpus.appended.flat();
}

async function withService(
  opts: {
    initialTopics?: TopicDefinition[];
    refreshIntervalMs?: number;
  },
  fn: (ctx: {
    service: BlueskyIngestService;
    corpus: FakeCorpus;
    sourceReady: Promise<FakeSource>;
    createSourceCalls: () => number;
    setTopics: (t: TopicDefinition[]) => void;
  }) => Promise<void>,
): Promise<void> {
  const corpus = new FakeCorpus();
  let topics = opts.initialTopics ?? [];
  let calls = 0;
  let resolveSource!: (s: FakeSource) => void;
  const sourceReady = new Promise<FakeSource>((r) => (resolveSource = r));

  const controller = new AbortController();
  const service = new BlueskyIngestService({
    databaseUrl: "postgres://unused",
    signal: controller.signal,
    deps: {
      openCorpus: () => Promise.resolve(corpus),
      listTopics: () => Promise.resolve(topics),
      createSource: (o) => {
        calls++;
        const s = new FakeSource(o.signal);
        resolveSource(s);
        return s;
      },
      refreshIntervalMs: opts.refreshIntervalMs ?? 10,
    },
  });
  service.start();

  try {
    await fn({
      service,
      corpus,
      sourceReady,
      createSourceCalls: () => calls,
      setTopics: (t) => {
        topics = t;
      },
    });
  } finally {
    controller.abort();
    await service.stop();
  }
}

function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitUntil timed out"));
      setTimeout(check, 5);
    };
    check();
  });
}

Deno.test("BlueskyIngestService: zero topics stays idle, never connects", async () => {
  await withService({ initialTopics: [] }, async ({ service, createSourceCalls }) => {
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(service.status().state, "idle");
    assertEquals(createSourceCalls(), 0);
  });
});

Deno.test("BlueskyIngestService: a topic added after start gets connected on the next refresh tick", async () => {
  await withService(
    { initialTopics: [] },
    async ({ service, setTopics, sourceReady, createSourceCalls }) => {
      assertEquals(service.status().state, "idle");
      setTopics([adHocTopic(["riverside"])]);

      const source = await sourceReady;
      assert(source instanceof FakeSource);
      assertEquals(createSourceCalls(), 1);
      await waitUntil(() => service.status().topicsWatched === 1);
    },
  );
});

Deno.test("BlueskyIngestService: stores an item matching any watched topic, batches by count", async () => {
  await withService(
    { initialTopics: [adHocTopic(["seattle"]), adHocTopic(["riverside"])] },
    async ({ sourceReady, corpus, service }) => {
      const source = await sourceReady;
      await waitUntil(() =>
        service.status().state === "connected" || service.status().state === "connecting"
      );

      // Matches only the second watched topic — still gets stored.
      source.push(item("a", "Wildfire near Riverside spreading fast"));
      // Matches neither — dropped.
      source.push(item("b", "Quarterly earnings beat expectations"));

      await waitUntil(() => service.status().lastEventAt !== null);
      // Not yet flushed (below BATCH_SIZE=16, below BATCH_FLUSH_MS=5s).
      assertEquals(flatAppended(corpus), []);

      // Push past the batch-size threshold to force a flush.
      for (let i = 0; i < 16; i++) {
        source.push(item(`c${i}`, "Riverside city council recall update"));
      }
      await waitUntil(() => flatAppended(corpus).length > 0);

      const stored = flatAppended(corpus).map((it) => it.id);
      assert(stored.includes("a"), "item matching only the second topic was stored");
      assert(!stored.includes("b"), "item matching no topic was dropped");
    },
  );
});

Deno.test("BlueskyIngestService: a closed source stops the service without retrying", async () => {
  await withService(
    { initialTopics: [adHocTopic(["riverside"])] },
    async ({ sourceReady, service, createSourceCalls }) => {
      const source = await sourceReady;
      await waitUntil(() =>
        service.status().state === "connecting" || service.status().state === "connected"
      );
      source.end();
      await waitUntil(() => service.status().state === "stopped");
      assertEquals(service.status().lastError, null);

      // Give the refresh timer a few more ticks — it must not reconnect.
      await new Promise((r) => setTimeout(r, 60));
      assertEquals(createSourceCalls(), 1);
      assertEquals(service.status().state, "stopped");
    },
  );
});

Deno.test("BlueskyIngestService: a source error is recorded, service stops, no retry", async () => {
  await withService(
    { initialTopics: [adHocTopic(["riverside"])] },
    async ({ sourceReady, service, createSourceCalls }) => {
      const source = await sourceReady;
      await waitUntil(() =>
        service.status().state === "connecting" || service.status().state === "connected"
      );
      source.fail(new Error("jetstream boom"));
      await waitUntil(() => service.status().state === "stopped");
      assertEquals(service.status().lastError?.message, "jetstream boom");

      await new Promise((r) => setTimeout(r, 60));
      assertEquals(createSourceCalls(), 1);
    },
  );
});

Deno.test("BlueskyIngestService: stop() drains the in-flight batch and closes the corpus", async () => {
  const corpus = new FakeCorpus();
  let resolveSource!: (s: FakeSource) => void;
  const sourceReady = new Promise<FakeSource>((r) => (resolveSource = r));
  const controller = new AbortController();

  const service = new BlueskyIngestService({
    databaseUrl: "postgres://unused",
    signal: controller.signal,
    deps: {
      openCorpus: () => Promise.resolve(corpus),
      listTopics: () => Promise.resolve([adHocTopic(["riverside"])]),
      createSource: (o) => {
        const s = new FakeSource(o.signal);
        resolveSource(s);
        return s;
      },
      refreshIntervalMs: 10,
    },
  });

  service.start();
  const source = await sourceReady;
  await waitUntil(() =>
    service.status().state === "connecting" || service.status().state === "connected"
  );

  // Below the batch-size/time thresholds — nothing flushed yet.
  source.push(item("a", "Riverside city council recall meeting tonight"));
  await waitUntil(() => service.status().lastEventAt !== null);
  assertEquals(flatAppended(corpus), []);

  controller.abort();
  await service.stop();

  assertEquals(flatAppended(corpus).map((it) => it.id), ["a"], "stop() flushed the partial batch");
  assert(corpus.closed, "stop() closed the corpus");
});
