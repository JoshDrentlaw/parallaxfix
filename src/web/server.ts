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
import {
  adHocTopic,
  deleteTopic,
  listTopics,
  loadTopic,
  parseCommaList,
  saveTopic,
  slugifyTopicId,
  topicExists,
  topicFilePath,
  TOPICS_DIR,
  validateTopicDraft,
} from "../ingestion/topic.ts";
import { type FeedValidationResult, validateRssFeed } from "../ingestion/rss.ts";
import { DECLARED_BLIND_SPOTS } from "../briefing/coverage.ts";

/** Injectable seams so tests (and demos) can run the server without Postgres. */
export interface WebDeps {
  databaseUrl?: () => string | undefined;
  gather?: (topic: TopicDefinition, since?: Date, until?: Date) => Promise<CoverageReport>;
  brief?: (topic: TopicDefinition, k: number, minSimilarity?: number) => Promise<Briefing>;
  /** Where saved topics live. Defaults to `TOPICS_DIR`; tests point this at a temp dir. */
  topicsDir?: string;
}

const STATIC_DIR = new URL("./static/", import.meta.url);
const FAVICON = new URL("../../favicon.svg", import.meta.url);

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

/** Topic from a request body: a saved topic by id, or ad-hoc keywords. */
async function topicFromBody(
  body: { topicId?: unknown; keywords?: unknown },
  dir: string,
): Promise<TopicDefinition | null> {
  if (typeof body.topicId === "string" && body.topicId.trim()) {
    const slug = slugifyTopicId(body.topicId);
    return await loadTopic(topicFilePath(slug, dir));
  }
  const keywords = parseCommaList(body.keywords);
  return keywords.length ? adHocTopic(keywords) : null;
}

/**
 * A safe topic id from a URL path segment: decode, then slugify. Every id
 * that reaches the filesystem comes through here, so a hostile path segment
 * (`../../etc/passwd`, encoded or not) can never survive as anything but
 * hyphens — `slugifyTopicId` strips everything outside `[a-z0-9-]`.
 */
function topicIdFromPath(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // malformed percent-encoding — fall through and slugify the raw segment
  }
  return slugifyTopicId(decoded);
}

interface TopicDraftBody {
  id?: unknown;
  keywords?: unknown;
  entities?: unknown;
  description?: unknown;
  exclude?: unknown;
  feeds?: unknown;
}

function feedsFromBody(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((f): f is string => typeof f === "string" && f.trim() !== "")
    : [];
}

async function readJsonBody<T>(req: Request): Promise<T | Response> {
  try {
    return await req.json() as T;
  } catch {
    return errorJson(400, "request body must be JSON");
  }
}

/** POST /api/topics — create a new saved topic. 409s if the id is already taken. */
async function createTopic(req: Request, dir: string): Promise<Response> {
  const body = await readJsonBody<TopicDraftBody>(req);
  if (body instanceof Response) return body;

  const id = slugifyTopicId(typeof body.id === "string" ? body.id : "");
  if (!id) return errorJson(400, "id is required");
  if (await topicExists(id, dir)) {
    return errorJson(409, `a topic "${id}" already exists — PUT /api/topics/${id} to update it`);
  }

  const topic: TopicDefinition = {
    id,
    keywords: parseCommaList(body.keywords),
    entities: parseCommaList(body.entities),
    description: typeof body.description === "string" ? body.description.trim() : "",
    exclude: parseCommaList(body.exclude),
    feeds: feedsFromBody(body.feeds),
  };
  const draftError = validateTopicDraft(topic);
  if (draftError) return errorJson(400, draftError);

  await saveTopic(topic, dir);
  return json(topic, 201);
}

/** PUT /api/topics/:id — update an existing saved topic. Omitted fields keep their current value. */
async function updateTopic(id: string, req: Request, dir: string): Promise<Response> {
  let existing: TopicDefinition;
  try {
    existing = await loadTopic(topicFilePath(id, dir));
  } catch {
    return errorJson(404, `no saved topic "${id}" in ${dir}/`);
  }

  const body = await readJsonBody<TopicDraftBody>(req);
  if (body instanceof Response) return body;

  const updated: TopicDefinition = {
    id,
    keywords: body.keywords !== undefined ? parseCommaList(body.keywords) : existing.keywords,
    entities: body.entities !== undefined ? parseCommaList(body.entities) : existing.entities,
    description: body.description !== undefined
      ? String(body.description).trim()
      : existing.description,
    exclude: body.exclude !== undefined ? parseCommaList(body.exclude) : existing.exclude,
    feeds: body.feeds !== undefined ? feedsFromBody(body.feeds) : existing.feeds,
  };
  const draftError = validateTopicDraft(updated);
  if (draftError) return errorJson(400, draftError);

  await saveTopic(updated, dir);
  return json(updated);
}

/** DELETE /api/topics/:id — remove a saved topic. */
async function removeTopic(id: string, dir: string): Promise<Response> {
  if (!(await topicExists(id, dir))) return errorJson(404, `no saved topic "${id}" in ${dir}/`);
  await deleteTopic(id, dir);
  return json({ deleted: id });
}

/**
 * POST /api/feeds/validate — check a candidate feed URL without saving it
 * anywhere. A bad feed is a normal, structured `{ ok: false, reason }` result
 * (200), not an error — the same "say so plainly" spirit as coverage gaps (P1).
 */
async function validateFeed(req: Request): Promise<Response> {
  const body = await readJsonBody<{ url?: unknown }>(req);
  if (body instanceof Response) return body;
  if (typeof body.url !== "string" || !body.url.trim()) return errorJson(400, "url is required");
  return json(await validateRssFeed(body.url.trim()));
}

/**
 * POST /api/topics/:id/feeds — validate a feed, then (only if it checks out)
 * append it to the topic and save. Duplicate URLs and failed validations come
 * back as `{ ok: false, reason }` rather than a write.
 */
async function addFeed(id: string, req: Request, dir: string): Promise<Response> {
  let topic: TopicDefinition;
  try {
    topic = await loadTopic(topicFilePath(id, dir));
  } catch {
    return errorJson(404, `no saved topic "${id}" in ${dir}/`);
  }

  const body = await readJsonBody<{ url?: unknown }>(req);
  if (body instanceof Response) return body;
  if (typeof body.url !== "string" || !body.url.trim()) return errorJson(400, "url is required");
  const url = body.url.trim();

  if ((topic.feeds ?? []).includes(url)) {
    const result: FeedValidationResult = { ok: false, reason: "already configured for this topic" };
    return json(result);
  }

  const validation = await validateRssFeed(url);
  if (!validation.ok) return json(validation);

  topic.feeds = [...(topic.feeds ?? []), url];
  await saveTopic(topic, dir);
  return json({ ...validation, topic });
}

/** DELETE /api/topics/:id/feeds?url=... — drop a feed from a topic. */
async function removeFeed(id: string, url: string, dir: string): Promise<Response> {
  let topic: TopicDefinition;
  try {
    topic = await loadTopic(topicFilePath(id, dir));
  } catch {
    return errorJson(404, `no saved topic "${id}" in ${dir}/`);
  }

  const before = topic.feeds?.length ?? 0;
  topic.feeds = (topic.feeds ?? []).filter((f) => f !== url);
  if (topic.feeds.length === before) return errorJson(404, "feed not found on this topic");

  await saveTopic(topic, dir);
  return json(topic);
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

  const gather = deps.gather ?? (async (topic: TopicDefinition, since?: Date, until?: Date) => {
    const db = requireDb();
    if (db instanceof Response) throw db;
    const { gatherSources } = await import("../pipeline.ts");
    return await gatherSources(topic, { databaseUrl: db }, { since, until });
  });

  const brief = deps.brief ??
    (async (topic: TopicDefinition, k: number, minSimilarity?: number) => {
      const db = requireDb();
      if (db instanceof Response) throw db;
      const { briefTopic } = await import("../pipeline.ts");
      return await briefTopic(topic, { databaseUrl: db }, { k, minSimilarity });
    });

  const topicsDir = deps.topicsDir ?? TOPICS_DIR;

  return async (req: Request): Promise<Response> => {
    const { pathname, searchParams } = new URL(req.url);

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
            return json(await listTopics(topicsDir));
        }
      }

      // Topic CRUD + per-topic feed management. `id` is sanitized before it
      // ever touches the filesystem (see topicIdFromPath).
      const feedsMatch = pathname.match(/^\/api\/topics\/([^/]+)\/feeds$/);
      if (feedsMatch) {
        const id = topicIdFromPath(feedsMatch[1]);
        if (req.method === "POST") return await addFeed(id, req, topicsDir);
        if (req.method === "DELETE") {
          const url = searchParams.get("url");
          if (!url) return errorJson(400, "url query parameter is required");
          return await removeFeed(id, url, topicsDir);
        }
      }

      const topicMatch = pathname.match(/^\/api\/topics\/([^/]+)$/);
      if (topicMatch) {
        const id = topicIdFromPath(topicMatch[1]);
        if (req.method === "GET") {
          try {
            return json(await loadTopic(topicFilePath(id, topicsDir)));
          } catch {
            return errorJson(404, `no saved topic "${id}" in ${topicsDir}/`);
          }
        }
        if (req.method === "PUT") return await updateTopic(id, req, topicsDir);
        if (req.method === "DELETE") return await removeTopic(id, topicsDir);
      }

      if (req.method === "POST" && pathname === "/api/topics") {
        return await createTopic(req, topicsDir);
      }
      if (req.method === "POST" && pathname === "/api/feeds/validate") {
        return await validateFeed(req);
      }

      if (req.method === "POST" && (pathname === "/api/gather" || pathname === "/api/brief")) {
        let body: {
          topicId?: unknown;
          keywords?: unknown;
          k?: unknown;
          minSimilarity?: unknown;
          since?: unknown;
          until?: unknown;
        };
        try {
          body = await req.json();
        } catch {
          return errorJson(400, "request body must be JSON");
        }
        let topic: TopicDefinition | null;
        try {
          topic = await topicFromBody(body, topicsDir);
        } catch {
          return errorJson(404, `no saved topic "${body.topicId}" in ${topicsDir}/`);
        }
        if (!topic) return errorJson(400, "provide topicId (saved) or keywords (comma-separated)");

        if (pathname === "/api/gather") {
          const since = typeof body.since === "string" && body.since
            ? new Date(body.since)
            : undefined;
          const until = typeof body.until === "string" && body.until
            ? new Date(body.until)
            : undefined;
          return json({ coverage: await gather(topic, since, until) });
        }
        const k = Math.min(Math.max(Number(body.k) || 200, 1), 1000);
        const minSimilarity = body.minSimilarity !== undefined && body.minSimilarity !== ""
          ? Number(body.minSimilarity)
          : undefined;
        return json(await brief(topic, k, minSimilarity));
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
