/**
 * A hand-written sample Briefing for tests (and local UI checks). Clearly
 * synthetic: every URL points at example.com. Never served by the app itself —
 * it is injected through the web layer's dependency seam only.
 */

import type { Briefing } from "../../src/ports.ts";

export function sampleBriefing(): Briefing {
  const t = (s: string) => new Date(s);
  return {
    topic_id: "riverside-recall",
    generated_at: t("2026-07-09T18:00:00Z"),
    narratives: [
      {
        cluster_id: "c1",
        label: "Recall petition reaches signature threshold",
        velocity: 14.2,
        relevance: 0.71,
        size: 37,
        first_seen: t("2026-07-08T21:10:00Z"),
        representative_item_ids: ["i1", "i2"],
        claims: [
          {
            id: "cl1",
            text: "Organizers filed 12,480 signatures with the city clerk on July 8.",
            cluster_id: "c1",
            evidence_type: "primary_record",
            supporting_item_ids: ["i1"],
            verify_hint: "Riverside city clerk filings",
          },
          {
            id: "cl2",
            text: "Local news reports the clerk has 30 days to verify the signatures.",
            cluster_id: "c1",
            evidence_type: "reported",
            supporting_item_ids: ["i2"],
            verify_hint: null,
          },
          {
            id: "cl3",
            text: "Several posters assert the count is inflated, without citing records.",
            cluster_id: "c1",
            evidence_type: "unsourced",
            supporting_item_ids: ["i1"],
            verify_hint: null,
          },
        ],
      },
      {
        cluster_id: "c2",
        label: "Council response and special-election timing",
        velocity: 5.6,
        relevance: 0.58,
        size: 21,
        first_seen: t("2026-07-07T15:00:00Z"),
        representative_item_ids: ["i3"],
        claims: [
          {
            id: "cl4",
            text: 'A councilmember said a special election would cost "about $2M".',
            cluster_id: "c2",
            evidence_type: "opinion",
            supporting_item_ids: ["i3"],
            verify_hint: "county registrar cost estimates",
          },
        ],
      },
    ],
    coverage: {
      topic_id: "riverside-recall",
      run_at: t("2026-07-09T18:00:00Z"),
      sources_queried: ["bluesky", "gdelt", "reddit"],
      items_per_source: { bluesky: 41, gdelt: 12, reddit: 5 },
      sources_unavailable: [
        { source: "rss", reason: "no RSS feeds configured for this topic" },
        { source: "tiktok", reason: "no automated access — closed to automated ingestion" },
        { source: "instagram", reason: "no automated access — closed to automated ingestion" },
      ],
      window: [t("2026-07-07T15:00:00Z"), t("2026-07-09T17:42:00Z")],
      blind_spot_signals: [
        {
          platform: "tiktok",
          referencing_items: 7,
          by_source: { bluesky: 6, reddit: 1 },
          links: 5,
          mentions: 2,
          top_targets: [{ target: "https://example.com/tiktok-video", mentions: 4 }],
          references_per_hour: 0.8,
          window: [t("2026-07-08T10:00:00Z"), t("2026-07-09T16:00:00Z")],
        },
      ],
    },
    provenance: {
      i1: {
        item_id: "i1",
        source: "bluesky",
        author: "organizer.example.social",
        url: "https://example.com/bsky/post/1",
        created_at: t("2026-07-08T21:10:00Z"),
        excerpt: "We just filed 12,480 signatures with the clerk. Verification clock starts now.",
      },
      i2: {
        item_id: "i2",
        source: "gdelt",
        author: "example-gazette.com",
        url: "https://example.com/gazette/recall-story",
        created_at: t("2026-07-09T08:30:00Z"),
        excerpt:
          "Clerk's office confirms receipt of recall petition; 30-day verification window begins.",
      },
      i3: {
        item_id: "i3",
        source: "reddit",
        author: "riverside_watcher",
        url: "https://example.com/r/riverside/comments/abc/thread",
        created_at: t("2026-07-09T12:05:00Z"),
        excerpt:
          'Councilmember at the presser: a special election would cost "about $2M" — thread with clip.',
      },
    },
    overview:
      "Two narratives dominate. The faster-moving one centers on the petition filing: a primary " +
      "record (the clerk filing) anchors it, with reported coverage of the 30-day verification " +
      "window and unsourced pushback on the count. The second follows the council's response, " +
      "currently driven by one attributed cost estimate. RSS was not configured this run, and " +
      "TikTok/Instagram remain unreachable — though 7 reachable items point at one TikTok video.",
    total_items: 58,
    total_claims: 4,
  };
}
