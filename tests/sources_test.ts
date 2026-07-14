import { assert, assertEquals } from "@std/assert";
import {
  bskySearchParams,
  type BskySearchPost,
  normalizeSearchPost,
} from "../src/ingestion/bluesky.ts";
import {
  type GdeltArticle,
  gdeltQueryParams,
  normalizeGdeltArticle,
  toGdeltDatetime,
} from "../src/ingestion/gdelt.ts";
import {
  normalizeRedditFeedEntry,
  normalizeRedditPost,
  type RedditFeedEntry,
  type RedditPostData,
  redditSearchParams,
  redditSearchQuery,
} from "../src/ingestion/reddit.ts";
import { normalizeRssEntry } from "../src/ingestion/rss.ts";
import { stableId } from "../src/ingestion/normalize.ts";
import { adHocTopic } from "../src/ingestion/topic.ts";

Deno.test("GDELT: maps an article, parses seendate, requires a url", () => {
  const a: GdeltArticle = {
    url: "https://example.com/story",
    title: "Riverside council faces recall push",
    domain: "example.com",
    seendate: "20260629T120000Z",
    language: "English",
  };
  const item = normalizeGdeltArticle(a)!;
  assertEquals(item.source, "gdelt");
  assertEquals(item.url, "https://example.com/story");
  assertEquals(item.author, "example.com");
  assertEquals(item.text, "Riverside council faces recall push");
  assertEquals(item.created_at.toISOString(), "2026-06-29T12:00:00.000Z");
  assertEquals(normalizeGdeltArticle({ title: "no url" }), null);
});

Deno.test("GDELT: widened default timespan (not the old recency-only '1d')", () => {
  const topic = adHocTopic(["Tilian Pearson"]);
  const params = gdeltQueryParams(topic);
  assertEquals(params.get("timespan"), "3months");
  assert(!params.has("startdatetime") && !params.has("enddatetime"));
});

Deno.test("GDELT: an explicit start+end range wins over timespan (historical mode)", () => {
  const topic = adHocTopic(["Tilian Pearson"]);
  const params = gdeltQueryParams(topic, {
    timespan: "1d", // should be ignored once a range is given
    startDatetime: toGdeltDatetime(new Date("2018-01-01T00:00:00Z")),
    endDatetime: toGdeltDatetime(new Date("2018-12-31T00:00:00Z")),
  });
  assertEquals(params.get("startdatetime"), "20180101000000");
  assertEquals(params.get("enddatetime"), "20181231000000");
  assert(!params.has("timespan"));
});

Deno.test("Reddit search params: defaults to sort=new with no time filter", () => {
  const topic = adHocTopic(["recall"]);
  const params = redditSearchParams(topic, { limit: 50, sort: "new", time: null });
  assertEquals(params.get("sort"), "new");
  assert(!params.has("t"));
});

Deno.test("Reddit search params: historical mode sends sort=relevance&t=all", () => {
  const topic = adHocTopic(["Tilian Pearson"]);
  const params = redditSearchParams(topic, {
    limit: 50,
    sort: "relevance",
    time: "all",
    type: "link",
  });
  assertEquals(params.get("sort"), "relevance");
  assertEquals(params.get("t"), "all");
  assertEquals(params.get("type"), "link");
});

Deno.test("Reddit: maps a post, builds permalink, captures engagement", () => {
  const d: RedditPostData = {
    id: "abc123",
    author: "someuser",
    title: "Recall effort gains signatures",
    selftext: "Organizers say they have enough.",
    permalink: "/r/Riverside/comments/abc123/recall/",
    created_utc: 1_782_000_000,
    score: 42,
    num_comments: 7,
  };
  const item = normalizeRedditPost(d)!;
  assertEquals(item.source, "reddit");
  assertEquals(item.source_id, "abc123");
  assertEquals(item.author, "someuser");
  assertEquals(item.url, "https://www.reddit.com/r/Riverside/comments/abc123/recall/");
  assert(item.text.includes("Recall effort") && item.text.includes("enough"));
  assertEquals(item.engagement.score, 42);
  assertEquals(item.engagement.comments, 7);
  assertEquals(normalizeRedditPost({ id: "" } as RedditPostData), null);
});

Deno.test("Reddit RSS: maps a feed entry, strips fullname/footer, empty engagement", () => {
  const e: RedditFeedEntry = {
    id: "t3_abc123",
    title: "Recall effort gains signatures",
    contentHtml:
      "<p>Organizers say they have <b>enough</b>.</p> submitted by <a>/u/someuser</a> <a>[link]</a> <a>[comments]</a>",
    link: "https://www.reddit.com/r/Riverside/comments/abc123/recall/",
    authorName: "/u/someuser",
    published: new Date("2026-07-01T12:00:00.000Z"),
  };
  const item = normalizeRedditFeedEntry(e)!;
  assertEquals(item.source, "reddit");
  assertEquals(item.source_id, "abc123"); // fullname prefix stripped → same id as OAuth path
  assertEquals(item.author, "someuser");
  assertEquals(item.url, "https://www.reddit.com/r/Riverside/comments/abc123/recall/");
  assert(item.text.includes("Recall effort") && item.text.includes("enough"));
  assert(!item.text.includes("submitted by"), "feed footer boilerplate stripped");
  assertEquals(item.engagement, {}); // feeds carry no scores — absent, not zero
  assertEquals(item.created_at.toISOString(), "2026-07-01T12:00:00.000Z");
});

Deno.test("Reddit RSS: recovers the id from the permalink; rejects entries without both", () => {
  const item = normalizeRedditFeedEntry({
    title: "No atom id",
    link: "https://www.reddit.com/r/x/comments/zz99/thing/",
  })!;
  assertEquals(item.source_id, "zz99");
  assertEquals(normalizeRedditFeedEntry({ title: "no link", id: "t3_a" }), null);
  assertEquals(normalizeRedditFeedEntry({ title: "nothing" }), null);
});

Deno.test("Reddit search query: ORs keywords/entities, quotes phrases, falls back to description", () => {
  const topic = adHocTopic(["recall", "city council"]);
  topic.entities = ["Riverside"];
  assertEquals(redditSearchQuery(topic), 'recall OR "city council" OR Riverside');
  assertEquals(
    redditSearchQuery({
      id: "t",
      keywords: [],
      entities: [],
      description: "some story",
      exclude: [],
    }),
    "some story",
  );
});

Deno.test("RSS: maps an entry, strips HTML, uses feed title as author, requires a link", () => {
  const item = normalizeRssEntry({
    id: "guid-1",
    title: "Council schedules recall hearing",
    description: "<p>The hearing is <b>Thursday</b>.</p>",
    link: "https://raincrossgazette.example/recall",
    published: new Date("2026-06-29T08:00:00.000Z"),
  }, "Raincross Gazette")!;
  assertEquals(item.source, "rss");
  assertEquals(item.author, "Raincross Gazette");
  assertEquals(item.url, "https://raincrossgazette.example/recall");
  assert(item.text.includes("Council schedules recall hearing"));
  assert(item.text.includes("The hearing is") && item.text.includes("Thursday"));
  assert(!item.text.includes("<") && !item.text.includes(">"), "HTML stripped");
  assertEquals(normalizeRssEntry({ title: "no link" }, "Outlet"), null);
});

Deno.test("Bluesky search: maps a searchPosts result, prefers handle, captures engagement", () => {
  const p: BskySearchPost = {
    uri: "at://did:plc:abc123/app.bsky.feed.post/xyz789",
    cid: "bafy...",
    author: { did: "did:plc:abc123", handle: "someuser.bsky.social" },
    record: {
      text: "The Tilian Pearson accusations, revisited",
      createdAt: "2018-06-15T10:00:00Z",
    },
    indexedAt: "2018-06-15T10:05:00Z",
    likeCount: 12,
    repostCount: 3,
    replyCount: 1,
    quoteCount: 0,
  };
  const item = normalizeSearchPost(p)!;
  assertEquals(item.source, "bluesky");
  assertEquals(item.source_id, "did:plc:abc123/xyz789");
  assertEquals(item.author, "someuser.bsky.social");
  assertEquals(item.url, "https://bsky.app/profile/did:plc:abc123/post/xyz789");
  assertEquals(item.text, "The Tilian Pearson accusations, revisited");
  assertEquals(item.created_at.toISOString(), "2018-06-15T10:00:00.000Z");
  assertEquals(item.engagement, { likes: 12, reposts: 3, replies: 1, quotes: 0 });
  assertEquals(normalizeSearchPost({ uri: "not-an-at-uri" }), null);
});

Deno.test("Bluesky search: same (did, rkey) as Jetstream would produce → dedupes to one row", () => {
  // Jetstream's stableId key is `${did}/${rkey}`; searchPosts must match it so
  // the same real-world post reached via either adapter lands on one row.
  const p: BskySearchPost = {
    uri: "at://did:plc:abc123/app.bsky.feed.post/xyz789",
    author: { did: "did:plc:abc123" },
    record: { text: "hello", createdAt: "2018-06-15T10:00:00Z" },
  };
  const item = normalizeSearchPost(p)!;
  assertEquals(item.id, stableId("bluesky", "did:plc:abc123/xyz789"));
});

Deno.test("Bluesky search: falls back to indexedAt, then now, when createdAt is missing/bad", () => {
  const p: BskySearchPost = {
    uri: "at://did:plc:abc123/app.bsky.feed.post/xyz789",
    author: { did: "did:plc:abc123" },
    record: { text: "hello" },
    indexedAt: "2018-06-15T10:05:00Z",
  };
  const item = normalizeSearchPost(p)!;
  assertEquals(item.created_at.toISOString(), "2018-06-15T10:05:00.000Z");
});

Deno.test("Bluesky search: captures reply parent as provenance", () => {
  const p: BskySearchPost = {
    uri: "at://did:plc:abc123/app.bsky.feed.post/xyz789",
    author: { did: "did:plc:abc123" },
    record: {
      text: "reply",
      createdAt: "2018-06-15T10:00:00Z",
      reply: { parent: { uri: "at://did:plc:parent/app.bsky.feed.post/root1" } },
    },
  };
  const item = normalizeSearchPost(p)!;
  assertEquals(item.parent_ref, "at://did:plc:parent/app.bsky.feed.post/root1");
});

Deno.test("Bluesky search params: defaults to sort=latest, no date bounds", () => {
  const topic = adHocTopic(["Tilian Pearson"]);
  const params = bskySearchParams(topic, { sort: "latest", limit: 100 });
  assertEquals(params.get("sort"), "latest");
  assertEquals(params.get("limit"), "100");
  assert(!params.has("since") && !params.has("until"));
});

Deno.test("Bluesky search params: since/until serialize as ISO datetimes (historical mode)", () => {
  const topic = adHocTopic(["Tilian Pearson"]);
  const params = bskySearchParams(topic, {
    sort: "latest",
    limit: 100,
    since: new Date("2018-01-01T00:00:00Z"),
    until: new Date("2018-12-31T00:00:00Z"),
  });
  assertEquals(params.get("since"), "2018-01-01T00:00:00.000Z");
  assertEquals(params.get("until"), "2018-12-31T00:00:00.000Z");
});
