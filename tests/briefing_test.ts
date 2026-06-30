import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Claim, Cluster, Item, LLMPort } from "../src/ports.ts";
import { assembleCoverageReport } from "../src/briefing/coverage.ts";
import {
  assembleBriefing,
  buildSynthesisPrompt,
  renderBriefing,
  synthesizeBriefing,
} from "../src/briefing/synthesize.ts";

const NOW = new Date("2026-06-29T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function item(id: string, text: string, when = NOW, source: Item["source"] = "reddit"): Item {
  return {
    id,
    source,
    source_id: id,
    author: `@${id}`,
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

function cluster(id: string, itemIds: string[], velocity: number, label = ""): Cluster {
  return {
    id,
    item_ids: itemIds,
    centroid: [],
    label,
    first_seen: hoursAgo(3),
    velocity,
    size: itemIds.length,
  };
}

function claim(id: string, clusterId: string, partial: Partial<Claim> = {}): Claim {
  return {
    id,
    text: partial.text ?? "a claim",
    cluster_id: clusterId,
    evidence_type: partial.evidence_type ?? "reported",
    supporting_item_ids: partial.supporting_item_ids ?? [],
    verify_hint: partial.verify_hint ?? null,
  };
}

function fixture() {
  const items = new Map([
    ["a1", item("a1", "council voted 4-3 on the recall", hoursAgo(1))],
    ["a2", item("a2", "filing shows the $5k donation", hoursAgo(2))],
    ["b1", item("b1", "everyone is mad about the park", hoursAgo(5))],
  ]);
  // c1 is slower but bigger; c2 is faster — P5 ranks c2 first.
  const c1 = cluster("c1", ["a1", "a2"], 0.5);
  const c2 = cluster("c2", ["b1"], 4.0);
  const claims = [
    claim("cl1", "c1", {
      text: "They donated $5,000",
      evidence_type: "primary_record",
      verify_hint: "FEC.gov",
      supporting_item_ids: ["a1", "a2"],
    }),
    claim("cl2", "c1", {
      text: "The vote was 4-3",
      evidence_type: "reported",
      supporting_item_ids: ["a1"],
    }),
  ];
  const coverage = assembleCoverageReport(
    "riverside-recall",
    [{ source: "reddit", items: [...items.values()] }],
    NOW,
  );
  return { items, clusters: [c1, c2], claims, coverage };
}

Deno.test("assembleBriefing: P5 ordering, provenance completeness, totals", () => {
  const { items, clusters, claims, coverage } = fixture();
  const b = assembleBriefing("riverside-recall", clusters, claims, items, coverage, {
    generatedAt: NOW,
  });

  // P5: the faster narrative (c2, 4.0/h) comes before the slower one (c1, 0.5/h).
  assertEquals(b.narratives.map((n) => n.cluster_id), ["c2", "c1"]);

  // Totals: 3 distinct items across clusters, 2 claims.
  assertEquals(b.total_items, 3);
  assertEquals(b.total_claims, 2);

  // P3: every referenced item (representatives + claim supporters) has provenance.
  for (const n of b.narratives) {
    for (const id of n.representative_item_ids) assert(b.provenance[id], `prov for rep ${id}`);
    for (const c of n.claims) {
      for (const sid of c.supporting_item_ids) assert(b.provenance[sid], `prov for ${sid}`);
    }
  }
  assertEquals(b.provenance["a2"].url, "https://example.com/a2");

  // P4: within c1, the primary_record claim is surfaced before the reported one.
  const c1 = b.narratives.find((n) => n.cluster_id === "c1")!;
  assertEquals(c1.claims.map((c) => c.evidence_type), ["primary_record", "reported"]);

  // No prose unless synthesized.
  assertEquals(b.overview, null);
});

Deno.test("buildSynthesisPrompt: carries the P2 guardrail and the coverage gaps", () => {
  const { items, clusters, claims, coverage } = fixture();
  const b = assembleBriefing("riverside-recall", clusters, claims, items, coverage, {
    generatedAt: NOW,
  });
  const prompt = buildSynthesisPrompt(b);

  // P2: explicit no-verdict / no-recommendation instruction.
  assertStringIncludes(prompt, "do NOT render a verdict");
  assertStringIncludes(prompt, "do NOT recommend");
  // Untrusted-input framing.
  assertStringIncludes(prompt, "untrusted DATA");
  // P1: the coverage gaps are in the prompt (blind spots always declared).
  assertStringIncludes(prompt, "could NOT see");
  assertStringIncludes(prompt, "tiktok");
  // The material is present.
  assertStringIncludes(prompt, "They donated $5,000");
});

Deno.test("synthesizeBriefing: fills overview from the injected LLM", async () => {
  const { items, clusters, claims, coverage } = fixture();
  const b = assembleBriefing("riverside-recall", clusters, claims, items, coverage, {
    generatedAt: NOW,
  });

  const llm: LLMPort = {
    extractClaims: () => Promise.resolve([]),
    labelCluster: () => Promise.resolve("label"),
    synthesize: (prompt: string) => {
      // It receives the assembled prompt, not raw items.
      assertStringIncludes(prompt, "NARRATIVES");
      return Promise.resolve("Two narratives are moving. Description only.");
    },
  };

  const out = await synthesizeBriefing(b, llm);
  assertEquals(out.overview, "Two narratives are moving. Description only.");
  // Pure: the original is untouched.
  assertEquals(b.overview, null);
});

Deno.test("renderBriefing: foregrounds coverage (P1), shows provenance (P3), no-verdict footer (P2)", () => {
  const { items, clusters, claims, coverage } = fixture();
  const b = assembleBriefing("riverside-recall", clusters, claims, items, coverage, {
    generatedAt: NOW,
  });
  const text = renderBriefing({ ...b, overview: "A neutral description." });

  // Header + P1 coverage block present and ahead of the narratives.
  assertStringIncludes(text, "BRIEFING — riverside-recall");
  assertStringIncludes(text, "Coverage report (P1)");
  assert(
    text.indexOf("Coverage report (P1)") < text.indexOf("Narratives (ranked by velocity"),
    "coverage is foregrounded before narratives",
  );
  // Declared blind spots always render (P1).
  assertStringIncludes(text, "tiktok");
  // P3: a provenance URL is shown.
  assertStringIncludes(text, "https://example.com/a2");
  // P4: evidence tag rendered.
  assertStringIncludes(text, "[primary_record]");
  // P2: the closing reminder.
  assertStringIncludes(text, "draws no conclusion");
});

Deno.test("renderBriefing: degrades honestly with no prose and no clusters", () => {
  const coverage = assembleCoverageReport("empty", [], NOW);
  const b = assembleBriefing("empty", [], [], new Map(), coverage, { generatedAt: NOW });
  const text = renderBriefing(b);
  assertStringIncludes(text, "no synthesis prose");
  assertStringIncludes(text, "none — the corpus held no clustered items");
  // Even an empty run declares the blind spots (P1).
  assertStringIncludes(text, "tiktok");
});
