import { assert, assertEquals } from "@std/assert";
import type { Item } from "../src/ports.ts";
import { extractBlindSpotRefs, summarizeBlindSpotSignals } from "../src/analysis/references.ts";

const NOW = new Date("2026-06-29T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function item(id: string, text: string, source: Item["source"] = "reddit", when = NOW): Item {
  return {
    id,
    source,
    source_id: id,
    author: null,
    text,
    url: `https://example.com/${id}`,
    created_at: when,
    fetched_at: when,
    engagement: {},
    parent_ref: null,
    embedding: null,
    raw: {},
  };
}

Deno.test("extractBlindSpotRefs: links (normalized) and bare mentions, link subsumes mention", () => {
  const refs = extractBlindSpotRefs(
    item("a", "Wild — watch https://www.tiktok.com/@user/video/123?lang=en it's on TikTok"),
  );
  // One ref: the link (the bare 'TikTok' mention is subsumed by the link).
  assertEquals(refs.length, 1);
  assertEquals(refs[0].kind, "link");
  assertEquals(refs[0].platform, "tiktok");
  assertEquals(refs[0].target, "tiktok.com/@user/video/123", "host(sans www)+path, no query");

  // Bare mention with no link → a mention ref.
  const m = extractBlindSpotRefs(item("b", "everyone is posting about it on Instagram rn"));
  assertEquals(m.length, 1);
  assertEquals(m[0].kind, "mention");
  assertEquals(m[0].platform, "instagram");
  assertEquals(m[0].target, null);

  // No blind-spot reference at all.
  assertEquals(
    extractBlindSpotRefs(item("c", "just a normal post with a https://news.example/x")).length,
    0,
  );
});

Deno.test("summarizeBlindSpotSignals: convergence, counts, by_source, velocity", () => {
  const items = [
    item("r1", "look https://vt.tiktok.com/ZS123/", "reddit", hoursAgo(1)),
    // Same target normalized → convergence on one video.
    item("r2", "https://vt.tiktok.com/ZS123 omg", "reddit", hoursAgo(2)),
    item("n1", "story references https://www.tiktok.com/@a/video/9 too", "gdelt", hoursAgo(3)),
    item("b1", "seen all over instagram", "bluesky", hoursAgo(1)),
    item("x", "nothing relevant here", "rss", hoursAgo(1)),
  ];

  const signals = summarizeBlindSpotSignals(items, { now: NOW, windowHours: 24 });
  const tik = signals.find((s) => s.platform === "tiktok")!;
  const ig = signals.find((s) => s.platform === "instagram")!;

  assertEquals(tik.referencing_items, 3);
  assertEquals(tik.links, 3);
  assertEquals(tik.mentions, 0);
  assertEquals(tik.by_source, { reddit: 2, gdelt: 1 });
  // The shared vt.tiktok.com/ZS123 target is the top convergence point.
  assertEquals(tik.top_targets[0], { target: "vt.tiktok.com/ZS123", mentions: 2 });
  assert(tik.references_per_hour > 0);

  assertEquals(ig.referencing_items, 1);
  assertEquals(ig.mentions, 1);
  assertEquals(ig.links, 0);

  // No references at all → no signal for that run.
  assertEquals(summarizeBlindSpotSignals([item("x", "nothing here")]), []);
});
