import { assert, assertEquals } from "@std/assert";
import { createHandler } from "../src/web/server.ts";
import { sampleBriefing } from "./fixtures/briefing.ts";

const get = (path: string) => new Request(`http://localhost${path}`);
const withBody = (method: string) => (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const post = withBody("POST");
const put = withBody("PUT");
const del = (path: string) => new Request(`http://localhost${path}`, { method: "DELETE" });

/** Stub global fetch for one test, restoring it afterward even on failure. */
async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const SAMPLE_RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Raincross Gazette</title>
  <item>
    <title>Council schedules recall hearing</title>
    <link>https://raincrossgazette.example/recall</link>
    <pubDate>Mon, 29 Jun 2026 08:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

/** Run a test against an isolated topics dir, cleaned up afterward. */
async function withTopicsDir(fn: (topicsDir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

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

Deno.test("web: /api/status's bluesky_ingest defaults to disabled with no ingest service wired up", async () => {
  const handler = createHandler({});
  const res = await handler(get("/api/status"));
  const s = await res.json();
  assertEquals(s.bluesky_ingest.state, "disabled");
  assertEquals(s.bluesky_ingest.topicsWatched, 0);
});

Deno.test("web: /api/status round-trips an injected ingest status unchanged", async () => {
  const handler = createHandler({
    ingestStatus: () => ({
      state: "connected",
      topicsWatched: 3,
      totalItemsIngested: 42,
      lastEventAt: null,
      lastError: null,
    }),
  });
  const res = await handler(get("/api/status"));
  const s = await res.json();
  assertEquals(s.bluesky_ingest.state, "connected");
  assertEquals(s.bluesky_ingest.topicsWatched, 3);
  assertEquals(s.bluesky_ingest.totalItemsIngested, 42);
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

// ── topic CRUD ───────────────────────────────────────────────────────────────

Deno.test("web: POST /api/topics creates a topic; listed and fetchable afterward; 409 on duplicate", async () => {
  await withTopicsDir(async (topicsDir) => {
    const handler = createHandler({ topicsDir });

    const created = await handler(post("/api/topics", {
      id: "Riverside Recall",
      keywords: "recall, city council",
      entities: "Riverside",
      description: "Recall effort in Riverside",
      exclude: "basketball",
    }));
    assertEquals(created.status, 201);
    const topic = await created.json();
    assertEquals(topic.id, "riverside-recall");
    assertEquals(topic.keywords, ["recall", "city council"]);
    assertEquals(topic.feeds, []);

    const listed = await (await handler(get("/api/topics"))).json();
    assertEquals(listed.map((t: { id: string }) => t.id), ["riverside-recall"]);

    const fetched = await (await handler(get("/api/topics/riverside-recall"))).json();
    assertEquals(fetched, topic);

    const dupe = await handler(post("/api/topics", { id: "Riverside Recall", keywords: "recall" }));
    assertEquals(dupe.status, 409);
  });
});

Deno.test("web: POST /api/topics rejects an empty draft and a missing id", async () => {
  await withTopicsDir(async (topicsDir) => {
    const handler = createHandler({ topicsDir });
    assertEquals((await handler(post("/api/topics", { id: "empty" }))).status, 400);
    assertEquals((await handler(post("/api/topics", { keywords: "recall" }))).status, 400);
  });
});

Deno.test("web: GET /api/topics/:id 404s for an unknown topic", async () => {
  await withTopicsDir(async (topicsDir) => {
    const handler = createHandler({ topicsDir });
    assertEquals((await handler(get("/api/topics/nope"))).status, 404);
  });
});

Deno.test("web: PUT /api/topics/:id updates given fields, preserves the rest, 404s if missing", async () => {
  await withTopicsDir(async (topicsDir) => {
    const handler = createHandler({ topicsDir });
    await handler(post("/api/topics", {
      id: "riverside-recall",
      keywords: "recall",
      feeds: ["https://example.com/feed.rss"],
    }));

    const updated = await handler(put("/api/topics/riverside-recall", {
      description: "Recall effort in Riverside",
    }));
    assertEquals(updated.status, 200);
    const topic = await updated.json();
    assertEquals(topic.description, "Recall effort in Riverside");
    // Untouched fields (including feeds) survive the partial update.
    assertEquals(topic.keywords, ["recall"]);
    assertEquals(topic.feeds, ["https://example.com/feed.rss"]);

    assertEquals((await handler(put("/api/topics/no-such-topic", {}))).status, 404);
  });
});

Deno.test("web: DELETE /api/topics/:id removes it; 404 the second time", async () => {
  await withTopicsDir(async (topicsDir) => {
    const handler = createHandler({ topicsDir });
    await handler(post("/api/topics", { id: "riverside-recall", keywords: "recall" }));

    assertEquals((await handler(del("/api/topics/riverside-recall"))).status, 200);
    assertEquals((await handler(get("/api/topics/riverside-recall"))).status, 404);
    assertEquals((await handler(del("/api/topics/riverside-recall"))).status, 404);
  });
});

Deno.test("web: a hostile id path segment is sanitized, never escapes topicsDir", async () => {
  await withTopicsDir(async (topicsDir) => {
    const handler = createHandler({ topicsDir });
    const res = await handler(get(`/api/topics/${encodeURIComponent("../../etc/passwd")}`));
    assertEquals(res.status, 404); // slugified to a harmless id, not found — never a path escape
  });
});

// ── feed management (validation + persistence) ──────────────────────────────

Deno.test("web: POST /api/feeds/validate reports a good feed without saving it anywhere", async () => {
  await withTopicsDir(async (topicsDir) => {
    const handler = createHandler({ topicsDir });
    const res = await withFetch(
      () => Promise.resolve(new Response(SAMPLE_RSS, { status: 200 })),
      () => handler(post("/api/feeds/validate", { url: "https://raincrossgazette.example/rss" })),
    );
    const result = await res.json();
    assert(result.ok);
    assertEquals(result.title, "Raincross Gazette");
    assertEquals(result.entryCount, 1);
    // Nothing was saved — no topics exist.
    assertEquals(await (await handler(get("/api/topics"))).json(), []);
  });
});

Deno.test("web: POST /api/topics/:id/feeds validates, then persists only on success", async () => {
  await withTopicsDir(async (topicsDir) => {
    const handler = createHandler({ topicsDir });
    await handler(post("/api/topics", { id: "riverside-recall", keywords: "recall" }));

    const added = await withFetch(
      () => Promise.resolve(new Response(SAMPLE_RSS, { status: 200 })),
      () =>
        handler(
          post("/api/topics/riverside-recall/feeds", {
            url: "https://raincrossgazette.example/rss",
          }),
        ),
    );
    assertEquals(added.status, 200);
    const addedBody = await added.json();
    assert(addedBody.ok);
    assertEquals(addedBody.topic.feeds, ["https://raincrossgazette.example/rss"]);

    // A bad feed is a structured failure, and the topic is untouched.
    const failed = await withFetch(
      () => Promise.resolve(new Response("not a feed", { status: 404, statusText: "Not Found" })),
      () =>
        handler(post("/api/topics/riverside-recall/feeds", { url: "https://example.com/gone" })),
    );
    assertEquals(failed.status, 200); // structured failure, not an HTTP error
    const failedBody = await failed.json();
    assertEquals(failedBody.ok, false);

    const topic = await (await handler(get("/api/topics/riverside-recall"))).json();
    assertEquals(
      topic.feeds,
      ["https://raincrossgazette.example/rss"],
      "the bad feed was not saved",
    );
  });
});

Deno.test("web: POST /api/topics/:id/feeds rejects a duplicate feed without re-fetching", async () => {
  await withTopicsDir(async (topicsDir) => {
    const handler = createHandler({ topicsDir });
    await handler(post("/api/topics", {
      id: "riverside-recall",
      keywords: "recall",
      feeds: ["https://raincrossgazette.example/rss"],
    }));

    let fetched = false;
    const res = await withFetch(
      () => {
        fetched = true;
        return Promise.resolve(new Response(SAMPLE_RSS, { status: 200 }));
      },
      () =>
        handler(
          post("/api/topics/riverside-recall/feeds", {
            url: "https://raincrossgazette.example/rss",
          }),
        ),
    );
    const body = await res.json();
    assertEquals(body.ok, false);
    assert(!fetched, "a duplicate is rejected before re-validating");
  });
});

Deno.test("web: DELETE /api/topics/:id/feeds removes a feed; 404 if it isn't there", async () => {
  await withTopicsDir(async (topicsDir) => {
    const handler = createHandler({ topicsDir });
    await handler(post("/api/topics", {
      id: "riverside-recall",
      keywords: "recall",
      feeds: ["https://raincrossgazette.example/rss"],
    }));

    const removed = await handler(
      del(
        `/api/topics/riverside-recall/feeds?url=${
          encodeURIComponent("https://raincrossgazette.example/rss")
        }`,
      ),
    );
    assertEquals(removed.status, 200);
    const topic = await removed.json();
    assertEquals(topic.feeds, []);

    assertEquals(
      (await handler(
        del(
          `/api/topics/riverside-recall/feeds?url=${
            encodeURIComponent("https://gone.example/rss")
          }`,
        ),
      )).status,
      404,
    );
  });
});
