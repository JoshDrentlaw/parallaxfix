/**
 * Web driver — the same pipeline as the CLI, over HTTP. A thin adapter:
 * routes parse requests into TopicDefinitions, call the application services
 * in `src/pipeline.ts`, and serialize the structured results; the front end
 * (static/, dark-mode first) renders them. No business logic lives here.
 *
 * Security posture (SECURITY.md §3a): binds localhost by default; every
 * response that can carry ingested content is JSON rendered client-side via
 * textContent (never innerHTML) under a strict CSP — ingested text stays
 * data, not markup, not instructions.
 */

import type { Briefing, CoverageReport, TopicDefinition } from "../ports.ts";
import { adHocTopic, loadTopic, slugifyTopicId } from "../ingestion/topic.ts";
import { DECLARED_BLIND_SPOTS } from "../briefing/coverage.ts";

/** Injectable seams so tests (and demos) can run the server without Postgres. */
export interface WebDeps {
  databaseUrl?: () => string | undefined;
  gather?: (topic: TopicDefinition) => Promise<CoverageReport>;
  brief?: (topic: TopicDefinition, k: number) => Promise<Briefing>;
}

const STATIC_DIR = new URL("./static/", import.meta.url);
const FAVICON = new URL("../../favicon.svg", import.meta.url);
const TOPICS_DIR = "config/topics";

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorJson(status: number, message: string): Response {
  return json({ error: message }, status);
}

async function staticFile(name: string, type: string): Promise<Response> {
  const url = name === "favicon.svg" ? FAVICON : new URL(name, STATIC_DIR);
  const body = await Deno.readTextFile(url);
  const headers: Record<string, string> = { "content-type": type };
  if (type.startsWith("text/html")) headers["content-security-policy"] = CSP;
  return new Response(body, { headers });
}

/** List saved topics from config/topics/*.json (missing dir → empty list). */
async function listTopics(): Promise<TopicDefinition[]> {
  const topics: TopicDefinition[] = [];
  try {
    for await (const entry of Deno.readDir(TOPICS_DIR)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      try {
        topics.push(await loadTopic(`${TOPICS_DIR}/${entry.name}`));
      } catch {
        // an unparseable topic file shouldn't take the endpoint down
      }
    }
  } catch {
    // no config/topics dir yet
  }
  return topics.sort((a, b) => a.id.localeCompare(b.id));
}

/** Topic from a request body: a saved topic by id, or ad-hoc keywords. */
async function topicFromBody(
  body: { topicId?: unknown; keywords?: unknown },
): Promise<TopicDefinition | null> {
  if (typeof body.topicId === "string" && body.topicId.trim()) {
    const slug = slugifyTopicId(body.topicId);
    return await loadTopic(`${TOPICS_DIR}/${slug}.json`);
  }
  if (typeof body.keywords === "string" && body.keywords.trim()) {
    const keywords = body.keywords.split(",").map((s: string) => s.trim()).filter(Boolean);
    return adHocTopic(keywords);
  }
  return null;
}

/**
 * Build the request handler. Dependencies default to the real pipeline
 * (imported lazily so the server starts fast and tests never touch Postgres).
 */
export function createHandler(deps: WebDeps = {}): (req: Request) => Promise<Response> {
  const databaseUrl = deps.databaseUrl ?? (() => Deno.env.get("DATABASE_URL"));

  const requireDb = (): string | Response => {
    const url = databaseUrl();
    if (url) return url;
    return errorJson(
      503,
      "DATABASE_URL is not set — the Corpus needs Postgres + pgvector " +
        "(e.g. postgres://postgres:postgres@localhost:5432/parallaxfix)",
    );
  };

  const gather = deps.gather ?? (async (topic: TopicDefinition) => {
    const db = requireDb();
    if (db instanceof Response) throw db;
    const { gatherSources } = await import("../pipeline.ts");
    return await gatherSources(topic, { databaseUrl: db });
  });

  const brief = deps.brief ?? (async (topic: TopicDefinition, k: number) => {
    const db = requireDb();
    if (db instanceof Response) throw db;
    const { briefTopic } = await import("../pipeline.ts");
    return await briefTopic(topic, { databaseUrl: db }, { k });
  });

  return async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);

    try {
      if (req.method === "GET") {
        switch (pathname) {
          case "/":
            return await staticFile("index.html", "text/html; charset=utf-8");
          case "/app.js":
            return await staticFile("app.js", "text/javascript; charset=utf-8");
          case "/app.css":
            return await staticFile("app.css", "text/css; charset=utf-8");
          case "/favicon.svg":
            return await staticFile("favicon.svg", "image/svg+xml");
          case "/api/status":
            return json({
              app: "parallax-fix",
              corpus_configured: Boolean(databaseUrl()),
              llm_configured: Boolean(Deno.env.get("ANTHROPIC_API_KEY")),
              reddit_mode: Deno.env.get("REDDIT_CLIENT_ID") ? "oauth" : "public-rss",
              declared_blind_spots: DECLARED_BLIND_SPOTS,
            });
          case "/api/topics":
            return json(await listTopics());
        }
      }

      if (req.method === "POST" && (pathname === "/api/gather" || pathname === "/api/brief")) {
        let body: { topicId?: unknown; keywords?: unknown; k?: unknown };
        try {
          body = await req.json();
        } catch {
          return errorJson(400, "request body must be JSON");
        }
        let topic: TopicDefinition | null;
        try {
          topic = await topicFromBody(body);
        } catch {
          return errorJson(404, `no saved topic "${body.topicId}" in ${TOPICS_DIR}/`);
        }
        if (!topic) return errorJson(400, "provide topicId (saved) or keywords (comma-separated)");

        if (pathname === "/api/gather") {
          return json({ coverage: await gather(topic) });
        }
        const k = Math.min(Math.max(Number(body.k) || 200, 1), 1000);
        return json(await brief(topic, k));
      }

      return errorJson(404, `no route: ${req.method} ${pathname}`);
    } catch (err) {
      if (err instanceof Response) return err; // requireDb's 503
      const reason = err instanceof Error ? err.message : String(err);
      return errorJson(500, reason);
    }
  };
}

export interface ServeOptions {
  hostname?: string;
  port?: number;
  deps?: WebDeps;
}

export function startServer(opts: ServeOptions = {}): Deno.HttpServer<Deno.NetAddr> {
  const hostname = opts.hostname ?? "127.0.0.1";
  const port = opts.port ?? 8420;
  return Deno.serve({
    hostname,
    port,
    onListen: ({ hostname, port }) => {
      console.log(`\nParallax Fix web UI → http://${hostname}:${port}`);
      console.log("  (localhost-only by default; see SECURITY.md §3a before exposing it)");
    },
  }, createHandler(opts.deps));
}
