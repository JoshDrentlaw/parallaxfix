/**
 * Clustering — group the corpus into narratives over the embedding space.
 *
 * Single-linkage agglomeration by a cosine-similarity threshold (union-find):
 * items whose vectors are within `threshold` join the same narrative. This is
 * deliberately simple (the spec says don't over-engineer; tunable later) — it's
 * deterministic, O(n²), and good enough to surface distinct conversations.
 * HDBSCAN/average-linkage are drop-in upgrades behind this same signature.
 */

import type { Cluster, Item } from "../ports.ts";
import { stableId } from "../ingestion/normalize.ts";
import { computeVelocity } from "./velocity.ts";

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function norm(a: number[]): number {
  return Math.sqrt(dot(a, a));
}

/** Cosine similarity; 0 if either vector is degenerate. */
function cosine(a: number[], b: number[]): number {
  const denom = norm(a) * norm(b);
  return denom === 0 ? 0 : dot(a, b) / denom;
}

/** Mean of the vectors, L2-normalized (degenerate → zero vector). */
function centroidOf(vectors: number[][]): number[] {
  const dims = vectors[0].length;
  const mean = new Array(dims).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dims; i++) mean[i] += v[i];
  }
  for (let i = 0; i < dims; i++) mean[i] /= vectors.length;
  const n = norm(mean);
  return n === 0 ? mean : mean.map((x) => x / n);
}

// ── union-find ────────────────────────────────────────────────────────────────

class UnionFind {
  #parent: number[];
  constructor(n: number) {
    this.#parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.#parent[x] !== x) {
      this.#parent[x] = this.#parent[this.#parent[x]];
      x = this.#parent[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.#parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

export interface ClusterOptions {
  /** Cosine similarity at/above which two items join the same narrative. */
  threshold?: number;
  /** "now" for velocity scoring (injected for deterministic tests). */
  now?: Date;
}

/**
 * Cluster items (those carrying an embedding) into narratives. Items without an
 * embedding are skipped. Clusters come back sorted by velocity (P5), then size.
 */
export function clusterItems(items: Item[], opts: ClusterOptions = {}): Cluster[] {
  const threshold = opts.threshold ?? 0.78;
  const now = opts.now ?? new Date();

  const pts = items.filter((it): it is Item & { embedding: number[] } =>
    Array.isArray(it.embedding) && it.embedding.length > 0
  );
  if (pts.length === 0) return [];

  const uf = new UnionFind(pts.length);
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      if (cosine(pts[i].embedding, pts[j].embedding) >= threshold) uf.union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < pts.length; i++) {
    const root = uf.find(i);
    (groups.get(root) ?? groups.set(root, []).get(root)!).push(i);
  }

  const clusters: Cluster[] = [];
  for (const idxs of groups.values()) {
    const members = idxs.map((i) => pts[i]);
    const itemIds = members.map((m) => m.id);
    const timestamps = members.map((m) => m.created_at);
    clusters.push({
      id: stableId("cluster", [...itemIds].sort().join(",")),
      item_ids: itemIds,
      centroid: centroidOf(members.map((m) => m.embedding)),
      label: "",
      first_seen: new Date(Math.min(...timestamps.map((t) => t.getTime()))),
      velocity: computeVelocity(timestamps, now),
      size: members.length,
    });
  }

  clusters.sort((a, b) => b.velocity - a.velocity || b.size - a.size);
  return clusters;
}
