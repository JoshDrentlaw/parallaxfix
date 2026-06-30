import { assert, assertEquals } from "@std/assert";
import type { Item } from "../src/ports.ts";
import {
  assembleCoverageReport,
  DECLARED_BLIND_SPOTS,
  type SourceResult,
} from "../src/briefing/coverage.ts";

function item(source: Item["source"], when: string): Item {
  return {
    id: `${source}-${when}`,
    source,
    source_id: when,
    author: null,
    text: "x",
    url: "https://example.com",
    created_at: new Date(when),
    fetched_at: new Date(when),
    engagement: {},
    parent_ref: null,
    embedding: null,
    raw: {},
  };
}

Deno.test("CoverageReport: counts queried sources, records unavailable, always reports blind spots", () => {
  const results: SourceResult[] = [
    {
      source: "gdelt",
      items: [item("gdelt", "2026-06-29T10:00:00Z"), item("gdelt", "2026-06-29T12:00:00Z")],
    },
    { source: "rss", items: [item("rss", "2026-06-28T09:00:00Z")] },
    {
      source: "reddit",
      items: [],
      unavailable: "REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET not configured",
    },
  ];
  const runAt = new Date("2026-06-29T13:00:00Z");
  const r = assembleCoverageReport("riverside-recall", results, runAt);

  assertEquals(r.topic_id, "riverside-recall");
  assertEquals(r.sources_queried.sort(), ["gdelt", "rss"]);
  assertEquals(r.items_per_source, { gdelt: 2, rss: 1 });

  // Reddit (errored) + both declared blind spots are unavailable.
  const unavail = r.sources_unavailable.map((u) => u.source).sort();
  assertEquals(unavail, ["instagram", "reddit", "tiktok"]);

  // Window spans oldest→newest across all items.
  assertEquals(r.window[0].toISOString(), "2026-06-28T09:00:00.000Z");
  assertEquals(r.window[1].toISOString(), "2026-06-29T12:00:00.000Z");
});

Deno.test("CoverageReport: empty run still reports the blind spots and a degenerate window", () => {
  const runAt = new Date("2026-06-29T13:00:00Z");
  const r = assembleCoverageReport("empty", [], runAt);
  assertEquals(r.sources_queried, []);
  assertEquals(
    r.sources_unavailable.map((u) => u.source).sort(),
    DECLARED_BLIND_SPOTS.map((b) => b.source).sort(),
  );
  assertEquals(r.window, [runAt, runAt]);
});

Deno.test("CoverageReport: a source reporting itself unavailable isn't duplicated by a blind spot", () => {
  const results: SourceResult[] = [
    { source: "tiktok", items: [], unavailable: "custom reason" },
  ];
  const r = assembleCoverageReport("t", results);
  const tiktoks = r.sources_unavailable.filter((u) => u.source === "tiktok");
  assertEquals(tiktoks.length, 1, "tiktok appears once");
  assertEquals(tiktoks[0].reason, "custom reason", "the source's own reason wins");
  assert(r.sources_unavailable.some((u) => u.source === "instagram"));
});
