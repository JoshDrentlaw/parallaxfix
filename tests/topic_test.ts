import { assert, assertEquals } from "@std/assert";
import type { TopicDefinition } from "../src/ports.ts";
import {
  deleteTopic,
  listTopics,
  loadTopic,
  parseCommaList,
  saveTopic,
  topicExists,
  topicFilePath,
  validateTopicDraft,
} from "../src/ingestion/topic.ts";

Deno.test("parseCommaList: splits/trims a comma string, passes an array through, else empty", () => {
  assertEquals(parseCommaList("recall, city council ,  Riverside"), [
    "recall",
    "city council",
    "Riverside",
  ]);
  assertEquals(parseCommaList("a,,  ,b"), ["a", "b"]);
  assertEquals(parseCommaList(["already", " an array "]), ["already", "an array"]);
  assertEquals(parseCommaList(undefined), []);
  assertEquals(parseCommaList(42), []);
});

Deno.test("validateTopicDraft: rejects empty, accepts either signal alone", () => {
  assert(validateTopicDraft({ keywords: [], description: "" }) !== null);
  assert(validateTopicDraft({ keywords: [], description: "   " }) !== null); // whitespace-only
  assertEquals(validateTopicDraft({ keywords: ["recall"], description: "" }), null);
  assertEquals(validateTopicDraft({ keywords: [], description: "some story" }), null);
});

function topic(id: string, partial: Partial<TopicDefinition> = {}): TopicDefinition {
  return {
    id,
    keywords: partial.keywords ?? ["recall"],
    entities: partial.entities ?? [],
    description: partial.description ?? "",
    exclude: partial.exclude ?? [],
    feeds: partial.feeds ?? [],
  };
}

Deno.test("saveTopic/loadTopic/topicExists/deleteTopic/listTopics: round-trip in an isolated dir", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await topicExists("riverside-recall", dir), false);
    assertEquals(await listTopics(dir), []);

    const t = topic("riverside-recall", { feeds: ["https://example.com/feed.rss"] });
    await saveTopic(t, dir);

    assertEquals(await topicExists("riverside-recall", dir), true);
    const loaded = await loadTopic(topicFilePath("riverside-recall", dir));
    assertEquals(loaded, t);

    const listed = await listTopics(dir);
    assertEquals(listed.length, 1);
    assertEquals(listed[0].id, "riverside-recall");

    await deleteTopic("riverside-recall", dir);
    assertEquals(await topicExists("riverside-recall", dir), false);
    assertEquals(await listTopics(dir), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("listTopics: missing directory is an empty list, not an error", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.remove(dir); // now it doesn't exist
  assertEquals(await listTopics(dir), []);
});

Deno.test("listTopics: an unparseable topic file is skipped, not fatal", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await saveTopic(topic("good-topic"), dir);
    await Deno.writeTextFile(`${dir}/broken.json`, "{ not json");
    const listed = await listTopics(dir);
    assertEquals(listed.map((t) => t.id), ["good-topic"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
