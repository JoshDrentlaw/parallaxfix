import { assert, assertEquals } from "@std/assert";
import type { Cluster, ExtractedClaim, Item, LLMPort } from "../src/ports.ts";
import { extractClaims } from "../src/analysis/claims.ts";

function item(id: string, text: string): Item {
  return {
    id,
    source: "bluesky",
    source_id: id,
    author: null,
    text,
    url: `https://example.com/${id}`,
    created_at: new Date("2026-06-29T12:00:00Z"),
    fetched_at: new Date("2026-06-29T12:00:00Z"),
    engagement: {},
    parent_ref: null,
    embedding: null,
    raw: {},
  };
}

/** Deterministic LLM: returns canned extractions keyed by item id. */
class FakeLLM implements LLMPort {
  constructor(private byItem: Record<string, ExtractedClaim[]>) {}
  extractClaims(items: Item[]): Promise<ExtractedClaim[][]> {
    return Promise.resolve(items.map((it) => this.byItem[it.id] ?? []));
  }
  labelCluster(): Promise<string> {
    return Promise.resolve("a label");
  }
  synthesize(): Promise<string> {
    return Promise.resolve("a synthesis");
  }
}

Deno.test("extractClaims: assembles, links to clusters, de-dupes, merges provenance", async () => {
  const cluster: Cluster = {
    id: "c1",
    item_ids: ["a1", "a2"],
    centroid: [],
    label: "",
    first_seen: new Date("2026-06-29T12:00:00Z"),
    velocity: 1,
    size: 2,
    relevance: 0.8,
  };
  const itemsById = new Map([
    ["a1", item("a1", "post 1")],
    ["a2", item("a2", "post 2")],
    ["a3", item("a3", "post 3 — not in any cluster")],
  ]);

  const llm = new FakeLLM({
    a1: [{
      text: "They donated $5,000 to the campaign",
      evidence_type: "primary_record",
      verify_hint: "FEC.gov",
    }],
    a2: [
      // Same claim as a1, different case → de-duped and provenance merged.
      {
        text: "they donated $5,000 to the campaign",
        evidence_type: "primary_record",
        verify_hint: "FEC.gov",
      },
      { text: "The mayor endorsed the recall", evidence_type: "reported", verify_hint: null },
    ],
    a3: [{ text: "this should be ignored", evidence_type: "opinion", verify_hint: null }],
  });

  const claims = await extractClaims([cluster], itemsById, llm);

  // Two distinct claims (the donation, de-duped; the endorsement). a3 ignored.
  assertEquals(claims.length, 2);
  assert(!claims.some((c) => c.text.includes("ignored")), "items outside clusters are skipped");

  const donation = claims.find((c) => c.text.toLowerCase().includes("donated"))!;
  assertEquals(donation.evidence_type, "primary_record");
  assertEquals(donation.verify_hint, "FEC.gov");
  assertEquals(donation.cluster_id, "c1");
  assertEquals(donation.supporting_item_ids.sort(), ["a1", "a2"], "provenance merged across items");

  const endorsement = claims.find((c) => c.text.includes("endorsed"))!;
  assertEquals(endorsement.evidence_type, "reported");
  assertEquals(endorsement.supporting_item_ids, ["a2"]);
  assert(donation.id !== endorsement.id && donation.id.length > 0, "stable distinct ids");
});

Deno.test("extractClaims: no clusters → no claims", async () => {
  const llm = new FakeLLM({});
  assertEquals(await extractClaims([], new Map(), llm), []);
});
