import { assert, assertEquals } from "@std/assert";
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
