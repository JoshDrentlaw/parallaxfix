/**
 * Claim assembly — turn per-item LLM extractions into `Claim`s linked to
 * clusters (P4: separate the verifiable from the asserted).
 *
 * Pure over the `LLMPort`: the LLM does extraction (which item asserts what,
 * tagged by evidence type); this module assigns stable ids, links each claim to
 * its narrative, and de-duplicates identical claims within a cluster — merging
 * their supporting items so provenance accumulates (P3). Fully testable with a
 * deterministic fake LLM.
 */

import type { Claim, Cluster, Item, LLMPort } from "../ports.ts";
import { stableId } from "../ingestion/normalize.ts";

/**
 * Extract claims for the items that belong to clusters, in one batched LLM
 * pass, then assemble them into `Claim`s. Items outside any cluster are ignored.
 */
export async function extractClaims(
  clusters: Cluster[],
  itemsById: Map<string, Item>,
  llm: LLMPort,
): Promise<Claim[]> {
  const clusterOf = new Map<string, string>();
  for (const c of clusters) {
    for (const id of c.item_ids) clusterOf.set(id, c.id);
  }

  const items = [...itemsById.values()].filter((it) => clusterOf.has(it.id));
  if (items.length === 0) return [];

  const perItem = await llm.extractClaims(items);

  // De-dupe within a cluster by normalized text; merge supporting items.
  const byKey = new Map<string, Claim>();
  items.forEach((it, i) => {
    const clusterId = clusterOf.get(it.id)!;
    for (const ec of perItem[i] ?? []) {
      const text = ec.text.trim();
      if (!text) continue;
      const key = `${clusterId}::${text.toLowerCase()}`;
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.supporting_item_ids.includes(it.id)) {
          existing.supporting_item_ids.push(it.id);
        }
      } else {
        byKey.set(key, {
          id: stableId("claim", key),
          text,
          cluster_id: clusterId,
          evidence_type: ec.evidence_type,
          supporting_item_ids: [it.id],
          verify_hint: ec.verify_hint,
        });
      }
    }
  });

  return [...byKey.values()];
}
