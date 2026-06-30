/**
 * Local embedder (EmbeddingPort) — sentence embeddings via transformers.js
 * (ONNX). Free, private, no per-call cost; weights download once on first use
 * and cache under `./models`. Default model is `bge-small-en-v1.5` (384-dim).
 *
 * bge models expect a short instruction prepended to *queries* (not documents),
 * which is why `embedQuery` differs from `embed`.
 */

import { env, pipeline } from "@huggingface/transformers";
import type { EmbeddingPort } from "../ports.ts";

/** Minimal shape of the transformers.js feature-extraction pipeline output. */
interface Tensor {
  tolist(): number[][];
}
type FeatureExtractor = (
  input: string[] | string,
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<Tensor>;

export interface LocalEmbedderOptions {
  model?: string;
  dimensions?: number;
  /** Instruction prepended to queries; bge-specific. */
  queryInstruction?: string;
  cacheDir?: string;
}

export class LocalEmbedder implements EmbeddingPort {
  readonly dimensions: number;
  readonly #model: string;
  readonly #queryInstruction: string;
  readonly #cacheDir: string;
  #extractor: FeatureExtractor | null = null;

  constructor(opts: LocalEmbedderOptions = {}) {
    this.#model = opts.model ?? Deno.env.get("PARALLAX_FIX_EMBED_MODEL") ??
      "BAAI/bge-small-en-v1.5";
    this.dimensions = opts.dimensions ?? 384;
    this.#queryInstruction = opts.queryInstruction ??
      "Represent this sentence for searching relevant passages: ";
    this.#cacheDir = opts.cacheDir ?? "./models";
  }

  /** Lazily load the model so CLI paths that don't embed pay nothing. */
  async #ensure(): Promise<FeatureExtractor> {
    if (!this.#extractor) {
      env.cacheDir = this.#cacheDir;
      this.#extractor = await pipeline(
        "feature-extraction",
        this.#model,
      ) as unknown as FeatureExtractor;
    }
    return this.#extractor;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extract = await this.#ensure();
    const out = await extract(texts, { pooling: "mean", normalize: true });
    return out.tolist();
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.embed([this.#queryInstruction + text]);
    return vec;
  }
}
