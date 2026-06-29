/**
 * Bluesky adapter — the keystone source (free, keyless, open firehose).
 *
 * Connects to Jetstream (simplified JSON over WebSocket), filters to
 * `app.bsky.feed.post` create events, normalizes them to `Item`s, and applies
 * the Phase-0 topic prefilter. Implements `SourcePort`; the core never sees a
 * WebSocket.
 *
 * Jetstream docs: https://github.com/bluesky-social/jetstream
 */

import type { Item, SourcePort, TopicDefinition } from "../ports.ts";
import { type JetstreamCommit, type JetstreamEvent, normalizeFeedPost } from "./normalize.ts";
import { matchesTopic } from "./topic.ts";

/** Public Jetstream instances (pick one; they mirror the same firehose). */
export const JETSTREAM_HOSTS = [
  "jetstream2.us-east.bsky.network",
  "jetstream1.us-east.bsky.network",
  "jetstream2.us-west.bsky.network",
  "jetstream1.us-west.bsky.network",
] as const;

export interface BlueskyOptions {
  /** Jetstream host to connect to. Defaults to a us-east instance. */
  host?: string;
  /** Collections to subscribe to. Defaults to feed posts only. */
  wantedCollections?: string[];
  /** Cancellation: abort to close the socket and end the stream. */
  signal?: AbortSignal;
}

export class BlueskyJetstreamAdapter implements SourcePort {
  readonly name = "bluesky" as const;

  readonly #host: string;
  readonly #collections: string[];
  readonly #signal?: AbortSignal;

  constructor(opts: BlueskyOptions = {}) {
    this.#host = opts.host ?? JETSTREAM_HOSTS[0];
    this.#collections = opts.wantedCollections ?? ["app.bsky.feed.post"];
    this.#signal = opts.signal;
  }

  /** Build the subscribe URL, optionally replaying from `since` via cursor. */
  url(since?: Date): string {
    const params = new URLSearchParams();
    for (const c of this.#collections) params.append("wantedCollections", c);
    // Jetstream cursor is unix microseconds; `since` is ms.
    if (since) params.set("cursor", String(since.getTime() * 1000));
    return `wss://${this.#host}/subscribe?${params.toString()}`;
  }

  async *fetch(topic: TopicDefinition, since?: Date): AsyncIterable<Item> {
    const ws = new WebSocket(this.url(since));

    // Bridge the event-driven socket to an async iterator via a queue.
    const queue: Item[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    let failure: Error | null = null;

    const ping = () => {
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    };

    ws.onmessage = (ev: MessageEvent) => {
      try {
        const data = typeof ev.data === "string" ? ev.data : "";
        if (!data) return;
        const parsed = JSON.parse(data) as JetstreamEvent;
        if (parsed.kind !== "commit") return; // ignore identity/account events
        const item = normalizeFeedPost(parsed as JetstreamCommit);
        if (item && matchesTopic(item, topic)) {
          queue.push(item);
          ping();
        }
      } catch {
        // Untrusted input: drop malformed frames, never break the stream.
      }
    };
    ws.onclose = () => {
      closed = true;
      ping();
    };
    ws.onerror = () => {
      failure = new Error(`Jetstream connection error (${this.#host})`);
      closed = true;
      ping();
    };

    const onAbort = () => {
      try {
        ws.close();
      } catch { /* already closing */ }
    };
    this.#signal?.addEventListener("abort", onAbort, { once: true });

    try {
      while (true) {
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        if (closed) break;
        await new Promise<void>((resolve) => (wake = resolve));
      }
      if (failure && !this.#signal?.aborted) throw failure;
    } finally {
      this.#signal?.removeEventListener("abort", onAbort);
      try {
        ws.close();
      } catch { /* noop */ }
    }
  }
}
