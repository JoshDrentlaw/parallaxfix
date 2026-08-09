import { assertEquals } from "@std/assert";
import { createHandler } from "../src/web/server.ts";

const post = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

Deno.test({
  name: "web: POST /api/topics/suggest-fields is 503 without ANTHROPIC_API_KEY",
  // Asserts the honest-degradation path, not the live LLM call — see
  // tests/topic_suggest_test.ts for the parsing logic and
  // src/ingestion/suggest.ts for the adapter itself (untested live here since
  // it needs a real key and network access to Claude + web search).
  ignore: Boolean(Deno.env.get("ANTHROPIC_API_KEY")),
  async fn() {
    const handler = createHandler({ databaseUrl: () => "postgres://unused" });
    const res = await handler(post("/api/topics/suggest-fields", { description: "data centers" }));
    assertEquals(res.status, 503);
    const body = await res.json();
    assertEquals(body.error.includes("ANTHROPIC_API_KEY"), true);
  },
});

Deno.test({
  name: "web: POST /api/topics/suggest-fields is 400 without a description",
  // Runs regardless of ANTHROPIC_API_KEY — the description check comes first.
  async fn() {
    const handler = createHandler({ databaseUrl: () => "postgres://unused" });
    const res = await handler(post("/api/topics/suggest-fields", {}));
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "web: POST /api/topics/<id>/exclude-suggestions is 503 without ANTHROPIC_API_KEY",
  ignore: Boolean(Deno.env.get("ANTHROPIC_API_KEY")),
  async fn() {
    const handler = createHandler({ databaseUrl: () => "postgres://unused" });
    const res = await handler(post("/api/topics/some-topic/exclude-suggestions", {}));
    assertEquals(res.status, 503);
    const body = await res.json();
    assertEquals(body.error.includes("ANTHROPIC_API_KEY"), true);
  },
});
