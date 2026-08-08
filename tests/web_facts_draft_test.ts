import { assertEquals } from "@std/assert";
import { createHandler } from "../src/web/server.ts";

const post = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

Deno.test({
  name: "web: POST .../facts/draft is 503 without ANTHROPIC_API_KEY",
  // This asserts the honest-degradation path, not the live LLM call — see
  // tests/reference_facts_test.ts for the parsing logic and
  // src/facts/reference.ts for the adapter itself (untested live here since
  // it needs a real key and network access to Claude + web search).
  ignore: Boolean(Deno.env.get("ANTHROPIC_API_KEY")),
  async fn() {
    const handler = createHandler({ databaseUrl: () => "postgres://unused" });
    const res = await handler(post("/api/topics/some-topic/facts/draft", {}));
    assertEquals(res.status, 503);
    const body = await res.json();
    assertEquals(body.error.includes("ANTHROPIC_API_KEY"), true);
  },
});
