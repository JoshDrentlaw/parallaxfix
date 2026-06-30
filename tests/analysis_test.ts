import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import type { Item } from "../src/ports.ts";
import { clusterItems } from "../src/analysis/cluster.ts";
import { computeVelocity } from "../src/analysis/velocity.ts";

const NOW = new Date("2026-06-29T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function item(id: string, embedding: number[] | null, createdAt: Date): Item {
  return {
    id,
    source: "bluesky",
    source_id: id,
    author: null,
    text: id,
    url: `https://example.com/${id}`,
    created_at: createdAt,
    fetched_at: createdAt,
    engagement: {},
    parent_ref: null,
    embedding,
    raw: {},
  };
}

Deno.test("computeVelocity: rate over the recent window", () => {
  assertEquals(computeVelocity([], NOW), 0);
  // 4 items spread across the last 2h → span 2h → 2 items/hour.
  const ts = [hoursAgo(2), hoursAgo(1.5), hoursAgo(1), hoursAgo(0.5)];
  assertAlmostEquals(computeVelocity(ts, NOW, 6), 4 / 2);
  // A single fresh item: span floored at 1h → 1 item/hour (no divide-by-zero spike).
  assertEquals(computeVelocity([hoursAgo(0.1)], NOW, 6), 1);
  // Everything older than the window → 0.
  assertEquals(computeVelocity([hoursAgo(10), hoursAgo(8)], NOW, 6), 0);
});

Deno.test("clusterItems: separates narratives, skips embeddingless items", () => {
  const items = [
    // narrative A (~[1,0,0]) — recent, so higher velocity
    item("a1", [1, 0, 0], hoursAgo(0.5)),
    item("a2", [0.99, 0.1, 0], hoursAgo(1)),
    item("a3", [0.98, 0, 0.1], hoursAgo(1.5)),
    // narrative B (~[0,1,0]) — older
    item("b1", [0, 1, 0], hoursAgo(5)),
    item("b2", [0.05, 0.99, 0], hoursAgo(5.5)),
    // no embedding → skipped entirely
    item("x", null, hoursAgo(0.2)),
  ];

  const clusters = clusterItems(items, { now: NOW });
  assertEquals(clusters.length, 2);

  // Sorted by velocity: the recent narrative A comes first.
  assertEquals(clusters[0].item_ids.sort(), ["a1", "a2", "a3"]);
  assertEquals(clusters[0].size, 3);
  assertEquals(clusters[1].item_ids.sort(), ["b1", "b2"]);
  assert(clusters[0].velocity >= clusters[1].velocity, "ranked by velocity");

  // first_seen is the oldest item in the cluster.
  assertEquals(clusters[0].first_seen.getTime(), hoursAgo(1.5).getTime());

  // Centroid is L2-normalized.
  const c = clusters[0].centroid;
  assertAlmostEquals(Math.hypot(...c), 1, 1e-9);

  // x (no embedding) appears in no cluster.
  assert(!clusters.some((cl) => cl.item_ids.includes("x")));
});

Deno.test("clusterItems: empty / all-embeddingless input → no clusters", () => {
  assertEquals(clusterItems([]), []);
  assertEquals(clusterItems([item("x", null, NOW)]), []);
});
