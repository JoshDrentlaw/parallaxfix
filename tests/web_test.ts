import { assert, assertEquals } from "@std/assert";
import { createHandler } from "../src/web/server.ts";
import { sampleBriefing } from "./fixtures/briefing.ts";

const get = (path: string) => new Request(`http://localhost${path}`);
const post = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

Deno.test("web: / serves the shell with a strict CSP; static assets resolve", async () => {
  const handler = createHandler();
  const res = await handler(get("/"));
  assertEquals(res.status, 200);
  assert(res.headers.get("content-security-policy")?.includes("script-src 'self'"));
  const html = await res.text();
  assert(html.includes("Parallax Fix"));
  assert(html.includes('data-theme="dark"'), "dark mode is the default");

  for (
    const [path, type] of [["/app.js", "javascript"], ["/app.css", "css"], ["/favicon.svg", "svg"]]
  ) {
    const r = await handler(get(path));
    assertEquals(r.status, 200, path);
    assert(r.headers.get("content-type")?.includes(type), path);
    await r.body?.cancel();
  }
});

Deno.test("web: /api/status reports config honestly, blind spots always declared", async () => {
  const handler = createHandler({ databaseUrl: () => undefined });
  const res = await handler(get("/api/status"));
  const s = await res.json();
  assertEquals(s.corpus_configured, false);
  const spots = s.declared_blind_spots.map((b: { source: string }) => b.source);
  assert(spots.includes("tiktok") && spots.includes("instagram"));
});

Deno.test("web: /api/brief without a corpus is a clear 503, not a crash", async () => {
  const handler = createHandler({ databaseUrl: () => undefined });
  const res = await handler(post("/api/brief", { keywords: "recall" }));
  assertEquals(res.status, 503);
  const body = await res.json();
  assert(body.error.includes("DATABASE_URL"));
});

Deno.test("web: /api/brief round-trips a briefing through the injected pipeline", async () => {
  let got: { id: string; k: number } | null = null;
  const handler = createHandler({
    brief: (topic, k) => {
      got = { id: topic.id, k };
      return Promise.resolve(sampleBriefing());
    },
  });
  const res = await handler(post("/api/brief", { keywords: "recall, city council", k: 50 }));
  assertEquals(res.status, 200);
  const b = await res.json();
  assertEquals(got, { id: "recall+city council", k: 50 });
  assertEquals(b.topic_id, "riverside-recall");
  // P1 survives serialization: the coverage gaps ride along.
  assert(b.coverage.sources_unavailable.some((u: { source: string }) => u.source === "tiktok"));
});

Deno.test("web: bad input → 400s; unknown routes → 404", async () => {
  const handler = createHandler({ databaseUrl: () => "postgres://unused" });
  assertEquals((await handler(post("/api/brief", {}))).status, 400);
  const notJson = new Request("http://localhost/api/gather", { method: "POST", body: "nope" });
  assertEquals((await handler(notJson)).status, 400);
  assertEquals((await handler(get("/nope"))).status, 404);
  assertEquals((await handler(post("/api/brief", { topicId: "no-such-topic" }))).status, 404);
});
