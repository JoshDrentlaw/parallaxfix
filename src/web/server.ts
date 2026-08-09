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

import type { BackgroundFact, Briefing, CoverageReport, Tag, TopicDefinition } from "../ports.ts";
import { FactStore } from "../facts/store.ts";
import { BriefingStore } from "../briefing/store.ts";
import {
  type BucketThresholds,
  ThresholdStore,
  validateThresholds,
} from "../briefing/thresholds.ts";
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
import {
  BlueskyIngestService,
  type BlueskyServiceDeps,
  type IngestStatus,
} from "../ingestion/bluesky-service.ts";

const DISABLED_INGEST_STATUS: IngestStatus = {
  state: "disabled",
  topicsWatched: 0,
  totalItemsIngested: 0,
  lastEventAt: null,
  lastError: null,
};

/** Injectable seams so tests (and demos) can run the server without Postgres. */
export interface WebDeps {
  databaseUrl?: () => string | undefined;
  gather?: (topic: TopicDefinition, since?: Date, until?: Date) => Promise<CoverageReport>;
  brief?: (
    topic: TopicDefinition,
    k: number,
    minSimilarity?: number,
    saveToLibrary?: boolean,
  ) => Promise<Briefing>;
  /** Where saved topics live. Defaults to `TOPICS_DIR`; tests point this at a temp dir. */
  topicsDir?: string;
  /** The always-on Bluesky ingest service's status, for /api/status. Defaults to "disabled". */
  ingestStatus?: () => IngestStatus | null;
}

const STATIC_DIR = new URL("./static/", import.meta.url);
const FAVICON = new URL("../../favicon.svg", import.meta.url);

/**
 * report-uri turns a silent block into a logged one: without it, a mistake
 * like an inline style="..." (which the CSP drops unconditionally — no
 * unsafe-inline, no nonce) only shows up if someone happens to have devtools
 * open. Shipped after that happened twice (the tuning histogram, the
 * info-chip popover) and went unnoticed both times. `report-uri` is the
 * older of the two reporting mechanisms (the newer `report-to` needs a
 * paired `Reporting-Endpoints` response header) but is simpler and still
 * honored by every current browser; revisit only if that stops being true.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "report-uri /api/csp-report",
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

/**
 * POST /api/csp-report — the browser's own report-uri delivery (see the CSP
 * constant above). Fire-and-forget from the browser's side, so this never
 * fails loudly: a malformed body is logged as-is and still gets a 204,
 * never a 500. Logs to stdout (docker logs), not the database — a CSP
 * violation is a maintenance signal, not user data worth persisting.
 */
async function reportCspViolation(req: Request): Promise<Response> {
  try {
    const parsed = await req.json();
    const report = (parsed as { "csp-report"?: Record<string, unknown> })["csp-report"];
    if (report) {
      console.warn(
        `[csp-report] ${report["violated-directive"]} blocked ${report["blocked-uri"]} ` +
          `at ${report["source-file"]}:${report["line-number"]} (page ${report["document-uri"]})`,
      );
    } else {
      console.warn("[csp-report] unrecognized report shape:", JSON.stringify(parsed).slice(0, 500));
    }
  } catch (err) {
    console.warn(
      `[csp-report] could not parse report body: ${err instanceof Error ? err.message : err}`,
    );
  }
  return new Response(null, { status: 204 });
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

// ── Track B (manual curation): background facts + the tag vocabulary that
//    scopes them to topics. Facts/tags live in Postgres (FactStore), same DB
//    as the corpus but a separate connection/schema concern — see
//    src/facts/store.ts. Each handler opens+closes its own FactStore, same
//    per-call lifecycle gather/brief use for PgCorpus. ──────────────────────

/** GET /api/tags */
async function listTagsHandler(databaseUrl: string): Promise<Response> {
  const facts = new FactStore(databaseUrl);
  try {
    await facts.init();
    return json(await facts.listTags());
  } finally {
    await facts.close();
  }
}

/** POST /api/tags — {name, slug?, description?}. slug is derived from name if omitted. */
async function createTagHandler(databaseUrl: string, req: Request): Promise<Response> {
  const body = await readJsonBody<{ slug?: unknown; name?: unknown; description?: unknown }>(req);
  if (body instanceof Response) return body;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return errorJson(400, "name is required");
  const slug = slugifyTopicId(typeof body.slug === "string" && body.slug.trim() ? body.slug : name);
  if (!slug) return errorJson(400, "could not derive a slug from name");
  const description = typeof body.description === "string" && body.description.trim()
    ? body.description.trim()
    : null;

  const facts = new FactStore(databaseUrl);
  try {
    await facts.init();
    return json(await facts.createTag(slug, name, description), 201);
  } finally {
    await facts.close();
  }
}

/** GET /api/topics/:id/facts — facts currently attached to this topic. */
async function listTopicFacts(databaseUrl: string, topicId: string): Promise<Response> {
  const facts = new FactStore(databaseUrl);
  try {
    await facts.init();
    return json(await facts.factsForTopic(topicId));
  } finally {
    await facts.close();
  }
}

/**
 * POST /api/topics/:id/facts — attach a fact to a topic. Either `{factId}` to
 * attach an existing fact, or `{text, source_name, source_url, as_of?}` to
 * create a new one and attach it in one step — the same
 * validate-then-add shape the RSS feed flow uses.
 */
async function addTopicFact(databaseUrl: string, topicId: string, req: Request): Promise<Response> {
  const body = await readJsonBody<{
    factId?: unknown;
    text?: unknown;
    source_name?: unknown;
    source_url?: unknown;
    as_of?: unknown;
  }>(req);
  if (body instanceof Response) return body;

  const facts = new FactStore(databaseUrl);
  try {
    await facts.init();
    let fact: BackgroundFact;
    if (typeof body.factId === "string" && body.factId.trim()) {
      const found = await facts.getFact(body.factId);
      if (!found) return errorJson(404, `no fact "${body.factId}"`);
      fact = found;
    } else {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      const sourceName = typeof body.source_name === "string" ? body.source_name.trim() : "";
      const sourceUrl = typeof body.source_url === "string" ? body.source_url.trim() : "";
      if (!text || !sourceName || !sourceUrl) {
        return errorJson(400, "text, source_name, and source_url are required");
      }
      let asOf = new Date();
      if (typeof body.as_of === "string" && body.as_of.trim()) {
        const parsed = new Date(body.as_of);
        if (Number.isNaN(parsed.getTime())) return errorJson(400, "as_of is not a valid date");
        asOf = parsed;
      }
      fact = await facts.createFact({
        text,
        source_name: sourceName,
        source_url: sourceUrl,
        as_of: asOf,
      });
    }
    await facts.attachFactToTopic(topicId, fact.id);
    return json(fact, 201);
  } finally {
    await facts.close();
  }
}

/** DELETE /api/topics/:id/facts?factId=... — detach; the fact record itself survives. */
async function removeTopicFact(
  databaseUrl: string,
  topicId: string,
  factId: string,
): Promise<Response> {
  if (!factId) return errorJson(400, "factId query parameter is required");
  const facts = new FactStore(databaseUrl);
  try {
    await facts.init();
    await facts.detachFactFromTopic(topicId, factId);
    return json({ detached: factId });
  } finally {
    await facts.close();
  }
}

/** GET /api/topics/:id/fact-suggestions — untached facts sharing a tag with this topic. */
async function suggestTopicFacts(databaseUrl: string, topicId: string): Promise<Response> {
  const facts = new FactStore(databaseUrl);
  try {
    await facts.init();
    return json(await facts.suggestFactsForTopic(topicId));
  } finally {
    await facts.close();
  }
}

/** GET /api/topics/:id/tags */
async function listTopicTags(databaseUrl: string, topicId: string): Promise<Response> {
  const facts = new FactStore(databaseUrl);
  try {
    await facts.init();
    return json(await facts.tagsForTopic(topicId));
  } finally {
    await facts.close();
  }
}

/**
 * POST /api/topics/:id/tags — `{tagId}` to attach an existing tag, or
 * `{name, slug?, description?}` to create (or reuse, by slug) a tag and
 * attach it in one step. Deliberately not an accidental side effect of
 * typing into a free-text field — creating a new tag is its own action.
 */
async function addTopicTag(databaseUrl: string, topicId: string, req: Request): Promise<Response> {
  const body = await readJsonBody<
    { tagId?: unknown; slug?: unknown; name?: unknown; description?: unknown }
  >(req);
  if (body instanceof Response) return body;

  const facts = new FactStore(databaseUrl);
  try {
    await facts.init();
    let tag: Tag;
    if (typeof body.tagId === "string" && body.tagId.trim()) {
      const found = await facts.getTag(body.tagId);
      if (!found) return errorJson(404, `no tag "${body.tagId}"`);
      tag = found;
    } else {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return errorJson(400, "name is required");
      const slug = slugifyTopicId(
        typeof body.slug === "string" && body.slug.trim() ? body.slug : name,
      );
      if (!slug) return errorJson(400, "could not derive a slug from name");
      const description = typeof body.description === "string" && body.description.trim()
        ? body.description.trim()
        : null;
      tag = await facts.createTag(slug, name, description);
    }
    await facts.tagTopic(topicId, tag.id);
    return json(tag, 201);
  } finally {
    await facts.close();
  }
}

/** DELETE /api/topics/:id/tags?tagId=... */
async function removeTopicTag(
  databaseUrl: string,
  topicId: string,
  tagId: string,
): Promise<Response> {
  if (!tagId) return errorJson(400, "tagId query parameter is required");
  const facts = new FactStore(databaseUrl);
  try {
    await facts.init();
    await facts.untagTopic(topicId, tagId);
    return json({ detached: tagId });
  } finally {
    await facts.close();
  }
}

// ── Track A #5/#6: the briefings library. Postgres-backed (BriefingStore),
//    same per-call open/close lifecycle as the Track B handlers above. ─────

/** GET /api/topics/:id/briefings — past briefings for a topic, most recent first. */
async function listTopicBriefings(databaseUrl: string, topicId: string): Promise<Response> {
  const store = new BriefingStore(databaseUrl);
  try {
    await store.init();
    return json(await store.listForTopic(topicId));
  } finally {
    await store.close();
  }
}

/** GET /api/briefings/:id — a specific stored briefing's full payload (same shape as /api/brief). */
async function getStoredBriefing(databaseUrl: string, id: string): Promise<Response> {
  const store = new BriefingStore(databaseUrl);
  try {
    await store.init();
    const data = await store.get(id);
    if (!data) return errorJson(404, `no stored briefing "${id}"`);
    return json(data);
  } finally {
    await store.close();
  }
}

/** GET /api/briefings/latest — most recent briefing per topic, for the what's-moving home view. */
async function listLatestBriefings(databaseUrl: string): Promise<Response> {
  const store = new BriefingStore(databaseUrl);
  try {
    await store.init();
    return json(await store.latestPerTopic());
  } finally {
    await store.close();
  }
}

// ── Tuning (2026-08) — the hot/active/quiet + strong/plausible/weak bucket
//    cutoffs, ported from Job Radar's app.settings + histogram pattern.
//    Thresholds live here instead of the hardcoded constants
//    velocityBucket()/relevanceBucket() shipped with, and the GET response
//    carries the raw scores across every stored briefing so the client can
//    show where the real distribution separates. ─────────────────────────

/** GET /api/tuning — current thresholds + every stored narrative's raw velocity/relevance. */
async function getTuning(databaseUrl: string): Promise<Response> {
  const thresholds = new ThresholdStore(databaseUrl);
  const briefings = new BriefingStore(databaseUrl);
  try {
    await Promise.all([thresholds.init(), briefings.init()]);
    const [current, scores] = await Promise.all([
      thresholds.get(),
      briefings.allNarrativeScores(),
    ]);
    return json({ thresholds: current, scores });
  } finally {
    await Promise.all([thresholds.close(), briefings.close()]);
  }
}

/** PUT /api/tuning — set the bucket thresholds. Validated; never partially applied. */
async function putTuning(databaseUrl: string, req: Request): Promise<Response> {
  const body = await readJsonBody<Partial<BucketThresholds>>(req);
  if (body instanceof Response) return body;
  const t: BucketThresholds = {
    hot: Number(body.hot),
    active: Number(body.active),
    strong: Number(body.strong),
    plausible: Number(body.plausible),
  };
  const invalid = validateThresholds(t);
  if (invalid) return errorJson(400, invalid);

  const store = new ThresholdStore(databaseUrl);
  try {
    await store.init();
    return json(await store.set(t));
  } finally {
    await store.close();
  }
}

/**
 * POST /api/topics/:id/facts/draft — auto-draft candidate background facts
 * via Claude + web search (Track B, auto-draft). Draft-and-approve only:
 * this never persists anything — the client reviews each candidate and, if
 * approved, sends it through the same create-fact flow the manual-curation
 * UI uses (POST /api/topics/:id/facts). A wrong background fact is worse
 * than a missing one, so nothing here auto-publishes.
 */
async function draftTopicFacts(id: string, topicsDir: string): Promise<Response> {
  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    return errorJson(503, "ANTHROPIC_API_KEY is not set — auto-draft needs the Claude API");
  }
  let topic: TopicDefinition;
  try {
    topic = await loadTopic(topicFilePath(id, topicsDir));
  } catch {
    return errorJson(404, `no saved topic "${id}" in ${topicsDir}/`);
  }
  try {
    const { AnthropicReferenceFacts } = await import("../facts/reference.ts");
    const drafts = await new AnthropicReferenceFacts().draft(topic);
    return json(drafts);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return errorJson(502, `draft failed: ${reason}`);
  }
}

/**
 * POST /api/topics/suggest-fields — LLM-drafted candidate keywords/entities/
 * exclude terms from a plain-English description (topic-assist, draft-and-
 * approve). Never persists anything — the client reviews and folds accepted
 * terms into POST/PUT /api/topics the same way typing them by hand would.
 * No topic needs to exist yet — this is meant to run during topic creation,
 * before there's an id to attach anything to.
 */
async function suggestTopicFields(req: Request): Promise<Response> {
  // Input validation before the service-config check: a malformed request is
  // a 400 regardless of whether ANTHROPIC_API_KEY happens to be set — the
  // opposite order made this endpoint's behavior depend on environment
  // secrets in a way its own test caught (passed with a local key, failed in
  // CI without one).
  const body = await readJsonBody<
    { description?: unknown; keywords?: unknown; entities?: unknown }
  >(req);
  if (body instanceof Response) return body;
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!description) return errorJson(400, "description is required");
  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    return errorJson(503, "ANTHROPIC_API_KEY is not set — topic suggestions need the Claude API");
  }
  try {
    const { AnthropicTopicSuggestions } = await import("../ingestion/suggest.ts");
    const suggestions = await new AnthropicTopicSuggestions().suggest({
      description,
      keywords: parseCommaList(body.keywords),
      entities: parseCommaList(body.entities),
    });
    return json(suggestions);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return errorJson(502, `suggestion failed: ${reason}`);
  }
}

/** Cap on how many weak narratives get sent to the exclude-suggestion prompt, to bound cost/context. */
const MAX_WEAK_NARRATIVES_FOR_SUGGEST = 40;

/**
 * POST /api/topics/:id/exclude-suggestions — LLM-drafted candidate exclude
 * terms mined from the topic's own most recent briefing's low-relevance
 * ("weak", per the tuned bucket thresholds — src/briefing/thresholds.ts)
 * narratives. Draft-and-approve only; never writes to the saved topic.
 */
async function suggestTopicExcludes(id: string, topicsDir: string, db: string): Promise<Response> {
  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    return errorJson(503, "ANTHROPIC_API_KEY is not set — exclude suggestions need the Claude API");
  }
  let topic: TopicDefinition;
  try {
    topic = await loadTopic(topicFilePath(id, topicsDir));
  } catch {
    return errorJson(404, `no saved topic "${id}" in ${topicsDir}/`);
  }
  const briefingStore = new BriefingStore(db);
  const thresholdStore = new ThresholdStore(db);
  try {
    const [summaries, thresholds] = await Promise.all([
      briefingStore.listForTopic(id, 1),
      thresholdStore.get(),
    ]);
    if (summaries.length === 0) {
      return errorJson(404, `no briefing yet for topic "${id}" — brief it at least once first`);
    }
    const data = await briefingStore.get(summaries[0].id);
    if (!data) return errorJson(404, `briefing ${summaries[0].id} not found`);
    const narratives = ((data as unknown as Briefing).narratives ?? []) as Briefing["narratives"];
    const weak = narratives
      .filter((n) => n.relevance < thresholds.plausible)
      .slice(0, MAX_WEAK_NARRATIVES_FOR_SUGGEST);
    if (weak.length === 0) {
      return json({ weak_narrative_count: 0, suggestions: [] });
    }
    const { AnthropicExcludeSuggestions } = await import("../briefing/exclude_suggest.ts");
    const suggestions = await new AnthropicExcludeSuggestions().suggestExcludes(topic, weak);
    return json({ weak_narrative_count: weak.length, suggestions });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return errorJson(502, `suggestion failed: ${reason}`);
  } finally {
    await briefingStore.close();
    await thresholdStore.close();
  }
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
    (async (topic: TopicDefinition, k: number, minSimilarity?: number, saveToLibrary?: boolean) => {
      const db = requireDb();
      if (db instanceof Response) throw db;
      const { briefTopic } = await import("../pipeline.ts");
      return await briefTopic(topic, { databaseUrl: db }, { k, minSimilarity, saveToLibrary });
    });

  const topicsDir = deps.topicsDir ?? TOPICS_DIR;
  const ingestStatus = deps.ingestStatus ?? (() => null);

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
              bluesky_ingest: ingestStatus() ?? DISABLED_INGEST_STATUS,
            });
          case "/api/topics":
            return json(await listTopics(topicsDir));
          case "/api/tags": {
            const db = requireDb();
            if (db instanceof Response) return db;
            return await listTagsHandler(db);
          }
          case "/api/briefings/latest": {
            const db = requireDb();
            if (db instanceof Response) return db;
            return await listLatestBriefings(db);
          }
          case "/api/tuning": {
            const db = requireDb();
            if (db instanceof Response) return db;
            return await getTuning(db);
          }
        }
      }

      if (req.method === "POST" && pathname === "/api/tags") {
        const db = requireDb();
        if (db instanceof Response) return db;
        return await createTagHandler(db, req);
      }

      if (req.method === "PUT" && pathname === "/api/tuning") {
        const db = requireDb();
        if (db instanceof Response) return db;
        return await putTuning(db, req);
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

      // Track B auto-draft: LLM-drafted candidate facts, never persisted.
      const factsDraftMatch = pathname.match(/^\/api\/topics\/([^/]+)\/facts\/draft$/);
      if (factsDraftMatch && req.method === "POST") {
        return await draftTopicFacts(topicIdFromPath(factsDraftMatch[1]), topicsDir);
      }

      // Track B: background facts + tags attached to a topic. Postgres-backed
      // (like gather/brief), so these need DATABASE_URL.
      const factsMatch = pathname.match(/^\/api\/topics\/([^/]+)\/facts$/);
      if (factsMatch) {
        const id = topicIdFromPath(factsMatch[1]);
        const db = requireDb();
        if (db instanceof Response) return db;
        if (req.method === "GET") return await listTopicFacts(db, id);
        if (req.method === "POST") return await addTopicFact(db, id, req);
        if (req.method === "DELETE") {
          const factId = searchParams.get("factId");
          if (!factId) return errorJson(400, "factId query parameter is required");
          return await removeTopicFact(db, id, factId);
        }
      }

      const factSuggestMatch = pathname.match(/^\/api\/topics\/([^/]+)\/fact-suggestions$/);
      if (factSuggestMatch && req.method === "GET") {
        const id = topicIdFromPath(factSuggestMatch[1]);
        const db = requireDb();
        if (db instanceof Response) return db;
        return await suggestTopicFacts(db, id);
      }

      // Topic-assist: LLM-drafted keyword/entity/exclude vocabulary. Checked
      // before topicMatch below so "suggest-fields" isn't parsed as a topic id.
      if (req.method === "POST" && pathname === "/api/topics/suggest-fields") {
        return await suggestTopicFields(req);
      }

      const excludeSuggestMatch = pathname.match(/^\/api\/topics\/([^/]+)\/exclude-suggestions$/);
      if (excludeSuggestMatch && req.method === "POST") {
        const id = topicIdFromPath(excludeSuggestMatch[1]);
        const db = requireDb();
        if (db instanceof Response) return db;
        return await suggestTopicExcludes(id, topicsDir, db);
      }

      const tagsMatch = pathname.match(/^\/api\/topics\/([^/]+)\/tags$/);
      if (tagsMatch) {
        const id = topicIdFromPath(tagsMatch[1]);
        const db = requireDb();
        if (db instanceof Response) return db;
        if (req.method === "GET") return await listTopicTags(db, id);
        if (req.method === "POST") return await addTopicTag(db, id, req);
        if (req.method === "DELETE") {
          const tagId = searchParams.get("tagId");
          if (!tagId) return errorJson(400, "tagId query parameter is required");
          return await removeTopicTag(db, id, tagId);
        }
      }

      // Track A #5: the briefings library.
      const topicBriefingsMatch = pathname.match(/^\/api\/topics\/([^/]+)\/briefings$/);
      if (topicBriefingsMatch && req.method === "GET") {
        const id = topicIdFromPath(topicBriefingsMatch[1]);
        const db = requireDb();
        if (db instanceof Response) return db;
        return await listTopicBriefings(db, id);
      }

      const briefingIdMatch = pathname.match(/^\/api\/briefings\/([^/]+)$/);
      if (briefingIdMatch && req.method === "GET") {
        const db = requireDb();
        if (db instanceof Response) return db;
        return await getStoredBriefing(db, decodeURIComponent(briefingIdMatch[1]));
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
      if (req.method === "POST" && pathname === "/api/csp-report") {
        return await reportCspViolation(req);
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
        const isSavedTopic = typeof body.topicId === "string" && body.topicId.trim() !== "";

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
        return json(await brief(topic, k, minSimilarity, isSavedTopic));
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
  /** Test seam for the Bluesky ingest service's own dependencies (corpus/source/topics). */
  ingestDeps?: BlueskyServiceDeps;
}

export function startServer(opts: ServeOptions = {}): Deno.HttpServer<Deno.NetAddr> {
  const hostname = opts.hostname ?? "127.0.0.1";
  const port = opts.port ?? 8420;

  // The always-on ingest service and the HTTP server share one lifetime:
  // startServer is the single owner of both, so a container stop cleanly
  // drains the Bluesky connection instead of killing it mid-batch.
  const controller = new AbortController();
  const databaseUrl = (opts.deps?.databaseUrl ?? (() => Deno.env.get("DATABASE_URL")))();
  const ingestService = databaseUrl
    ? new BlueskyIngestService({ databaseUrl, signal: controller.signal, deps: opts.ingestDeps })
    : null;
  ingestService?.start();

  const handler = createHandler({
    ...opts.deps,
    ingestStatus: opts.deps?.ingestStatus ?? (() => ingestService?.status() ?? null),
  });

  const server = Deno.serve({
    hostname,
    port,
    onListen: ({ hostname, port }) => {
      console.log(`\nParallax Fix web UI → http://${hostname}:${port}`);
      console.log("  (localhost-only by default; see SECURITY.md §3a before exposing it)");
    },
  }, handler);

  // docker compose stop / a container recreate sends SIGTERM, not SIGINT, to
  // PID 1 — without catching it, the process is killed mid-batch instead of
  // shutting down cleanly.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    Deno.removeSignalListener("SIGINT", shutdown);
    Deno.removeSignalListener("SIGTERM", shutdown);
    controller.abort();
    await ingestService?.stop();
    await server.shutdown();
  };
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  return server;
}
