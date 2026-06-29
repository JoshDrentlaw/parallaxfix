import { assert, assertEquals } from "@std/assert";
import { type JetstreamCommit, normalizeFeedPost, stableId } from "../src/ingestion/normalize.ts";
import { adHocTopic, matchesTopic } from "../src/ingestion/topic.ts";

function sampleCommit(overrides: Partial<JetstreamCommit["commit"]> = {}): JetstreamCommit {
  return {
    did: "did:plc:abc123",
    time_us: 1_735_500_000_000_000,
    kind: "commit",
    commit: {
      rev: "rev1",
      operation: "create",
      collection: "app.bsky.feed.post",
      rkey: "3kxyz",
      cid: "bafy...",
      record: {
        $type: "app.bsky.feed.post",
        text: "Wildfire near Riverside spreading fast",
        createdAt: "2026-06-29T12:00:00.000Z",
        langs: ["en"],
      },
      ...overrides,
    },
  };
}

Deno.test("stableId is deterministic and input-sensitive", () => {
  assertEquals(stableId("bluesky", "a/b"), stableId("bluesky", "a/b"));
  assert(stableId("bluesky", "a/b") !== stableId("bluesky", "a/c"));
  assert(stableId("bluesky", "a/b") !== stableId("reddit", "a/b"));
});

Deno.test("normalizeFeedPost maps a feed post create to an Item", () => {
  const item = normalizeFeedPost(sampleCommit());
  assert(item !== null);
  assertEquals(item!.source, "bluesky");
  assertEquals(item!.source_id, "did:plc:abc123/3kxyz");
  assertEquals(item!.author, "did:plc:abc123");
  assertEquals(item!.text, "Wildfire near Riverside spreading fast");
  assertEquals(item!.url, "https://bsky.app/profile/did:plc:abc123/post/3kxyz");
  assertEquals(item!.created_at.toISOString(), "2026-06-29T12:00:00.000Z");
  assertEquals(item!.parent_ref, null);
});

Deno.test("normalizeFeedPost captures reply parent as provenance", () => {
  const item = normalizeFeedPost(
    sampleCommit({
      record: {
        $type: "app.bsky.feed.post",
        text: "replying",
        createdAt: "2026-06-29T12:00:00.000Z",
        reply: { parent: { uri: "at://did:plc:other/app.bsky.feed.post/parentkey" } },
      },
    }),
  );
  assertEquals(item!.parent_ref, "at://did:plc:other/app.bsky.feed.post/parentkey");
});

Deno.test("normalizeFeedPost ignores deletes, other collections, bad records", () => {
  assertEquals(normalizeFeedPost(sampleCommit({ operation: "delete" })), null);
  assertEquals(normalizeFeedPost(sampleCommit({ collection: "app.bsky.feed.like" })), null);
  assertEquals(normalizeFeedPost(sampleCommit({ record: undefined })), null);
});

Deno.test("matchesTopic: keywords, exclude wins, empty matches all", () => {
  const item = normalizeFeedPost(sampleCommit())!;

  assert(matchesTopic(item, adHocTopic(["riverside"])));
  assert(matchesTopic(item, adHocTopic(["RIVERSIDE"]))); // case-insensitive
  assert(!matchesTopic(item, adHocTopic(["seattle"])));

  const excluded = { ...adHocTopic(["riverside"]), exclude: ["wildfire"] };
  assert(!matchesTopic(item, excluded));

  assert(matchesTopic(item, adHocTopic([]))); // no terms → firehose
});
