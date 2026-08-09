import { assertEquals } from "@std/assert";
import { createHandler } from "../src/web/server.ts";

const post = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/csp-report" },
    body: JSON.stringify(body),
  });

function spyOnWarn(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    calls.push(args.map(String).join(" "));
  };
  return { calls, restore: () => (console.warn = original) };
}

Deno.test("web: POST /api/csp-report accepts a real browser report, 204, logs the key fields", async () => {
  const spy = spyOnWarn();
  try {
    const handler = createHandler();
    const res = await handler(
      post("/api/csp-report", {
        "csp-report": {
          "document-uri": "http://localhost/",
          "violated-directive": "style-src 'self'",
          "blocked-uri": "inline",
          "source-file": "http://localhost/app.js",
          "line-number": 1566,
        },
      }),
    );
    assertEquals(res.status, 204);
    assertEquals(spy.calls.length, 1);
    assertEquals(spy.calls[0].includes("style-src 'self'"), true);
    assertEquals(spy.calls[0].includes("app.js"), true);
  } finally {
    spy.restore();
  }
});

Deno.test("web: POST /api/csp-report never fails on a malformed body — still 204", async () => {
  const spy = spyOnWarn();
  try {
    const handler = createHandler();
    const res = await handler(
      new Request("http://localhost/api/csp-report", {
        method: "POST",
        headers: { "content-type": "application/csp-report" },
        body: "not json",
      }),
    );
    assertEquals(res.status, 204);
    assertEquals(spy.calls.length, 1);
  } finally {
    spy.restore();
  }
});

Deno.test("web: POST /api/csp-report logs an unrecognized shape rather than throwing", async () => {
  const spy = spyOnWarn();
  try {
    const handler = createHandler();
    const res = await handler(post("/api/csp-report", { something: "else" }));
    assertEquals(res.status, 204);
    assertEquals(spy.calls.length, 1);
    assertEquals(spy.calls[0].includes("unrecognized"), true);
  } finally {
    spy.restore();
  }
});
