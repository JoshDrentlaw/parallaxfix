/**
 * Voyage AI embedding adapter — the rerank tier (RerankEmbeddingPort), not
 * the storage tier. Anthropic has no embeddings endpoint of its own; Voyage
 * is their recommended partner.
 *
 * Deliberately never called on the full corpus — see
 * PgCorpus.retrieveForAnalysis, which only sends the (already narrow) local-
 * ANN candidate pool here, and only the fraction of it lacking a cached,
 * model-matching vector. That's what keeps this affordable against a live
 * firehose: the free local embedder (src/corpus/embed.ts) is what runs on
 * every ingested item; this only ever runs on the handful of candidates a
 * real briefing actually considers, and the result is cached permanently
 * (analyzed_embedding/analyzed_model) so a recurring item is never re-sent.
 *
 * Endpoint shape:
 *
 *   POST https://api.voyageai.com/v1/embeddings
 *   Authorization: Bearer <key>
 *   { "input": string[], "model": string, "input_type": "document" | "query" }
 *   → { "data": [{ "embedding": number[], "index": number }], "model": string }
 */

import type { RerankEmbeddingPort } from "../ports.ts";

const ENDPOINT = "https://api.voyageai.com/v1/embeddings";

/** The API caps a request at 128 inputs. */
const MAX_BATCH = 128;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);
const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 1_000;

export class EmbeddingError extends Error {
  override readonly name = "EmbeddingError";
}

export interface VoyageEmbedderOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  /** Test seam; production sleeps for real. */
  sleep?: (ms: number) => Promise<void>;
}

interface VoyageResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  detail?: string;
}

export class VoyageEmbedder implements RerankEmbeddingPort {
  readonly model: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(opts: VoyageEmbedderOptions = {}) {
    const apiKey = opts.apiKey ?? Deno.env.get("VOYAGE_API_KEY");
    if (!apiKey) throw new Error("VoyageEmbedder requires an apiKey (or VOYAGE_API_KEY)");
    this.#apiKey = apiKey;
    this.model = opts.model ?? Deno.env.get("VOYAGE_MODEL") ?? "voyage-3.5";
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  embed(texts: string[]): Promise<number[][]> {
    return this.#embedAll(texts, "document");
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.#embedAll([text], "query");
    return vec;
  }

  async #embedAll(texts: readonly string[], kind: "document" | "query"): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let start = 0; start < texts.length; start += MAX_BATCH) {
      const batch = texts.slice(start, start + MAX_BATCH);
      out.push(...await this.#embedBatch(batch, kind));
    }
    return out;
  }

  async #embedBatch(batch: readonly string[], kind: "document" | "query"): Promise<number[][]> {
    let lastFailure = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await this.#fetch(ENDPOINT, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.#apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ input: batch, model: this.model, input_type: kind }),
        });
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error);
        await this.#sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
        continue;
      }

      if (response.ok) {
        return parseEmbeddings(await response.json(), batch.length);
      }

      const body = await response.text().catch(() => "");
      lastFailure = `HTTP ${response.status}${body === "" ? "" : `: ${body.slice(0, 200)}`}`;
      if (!RETRYABLE_STATUS.has(response.status)) {
        throw new EmbeddingError(`Voyage embedding request failed (${lastFailure})`);
      }
      await this.#sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }
    throw new EmbeddingError(
      `Voyage embedding request failed after ${MAX_ATTEMPTS} attempts (${lastFailure})`,
    );
  }
}

/**
 * Exported for tests. Order is restored from the response's own `index`
 * field rather than assumed; a response missing any position is rejected
 * outright — a silently misaligned vector would corrupt every score
 * computed from it.
 */
export function parseEmbeddings(payload: unknown, expected: number): number[][] {
  const data = (payload as VoyageResponse)?.data;
  if (!Array.isArray(data) || data.length !== expected) {
    throw new EmbeddingError(
      `Voyage response has ${Array.isArray(data) ? data.length : "no"} embeddings, ` +
        `expected ${expected}`,
    );
  }
  const out: number[][] = new Array(expected);
  for (const item of data) {
    const index = item?.index;
    const embedding = item?.embedding;
    if (
      typeof index !== "number" || index < 0 || index >= expected ||
      !Array.isArray(embedding) || embedding.length === 0 ||
      !embedding.every((v) => typeof v === "number" && Number.isFinite(v))
    ) {
      throw new EmbeddingError("Voyage response contains a malformed embedding entry");
    }
    out[index] = embedding;
  }
  for (let i = 0; i < expected; i++) {
    if (out[i] === undefined) {
      throw new EmbeddingError(`Voyage response is missing the embedding at index ${i}`);
    }
  }
  return out;
}
