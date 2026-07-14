/**
 * Topic definitions: loading/saving config and a Phase-0 keyword prefilter.
 *
 * NOTE: real topic matching is *semantic* (embed description + keywords,
 * retrieve nearest items) and lands in Phase 1 behind the CorpusPort. The
 * `matchesTopic` filter here is a cheap keyword/exclude prefilter so a live
 * firehose doesn't flood the console — not the final matcher.
 */

import type { Item, TopicDefinition } from "../ports.ts";

/** Default on-disk home for saved topics; both the CLI and the web UI write here. */
export const TOPICS_DIR = "config/topics";

/** Load a saved TopicDefinition from a JSON file (config/topics/*.json). */
export async function loadTopic(path: string): Promise<TopicDefinition> {
  const raw = await Deno.readTextFile(path);
  const parsed = JSON.parse(raw) as Partial<TopicDefinition>;
  if (!parsed.id || !Array.isArray(parsed.keywords)) {
    throw new Error(`Invalid topic file ${path}: needs at least "id" and "keywords"`);
  }
  return {
    id: parsed.id,
    keywords: parsed.keywords ?? [],
    entities: parsed.entities ?? [],
    description: parsed.description ?? "",
    exclude: parsed.exclude ?? [],
    feeds: parsed.feeds ?? [],
  };
}

/** Normalize a free-text id into a filesystem-safe slug (e.g. for topic files). */
export function slugifyTopicId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Path to a saved topic's JSON file. `dir` is overridable for tests. */
export function topicFilePath(id: string, dir: string = TOPICS_DIR): string {
  return `${dir}/${id}.json`;
}

/** Whether a saved topic file already exists for this id. */
export async function topicExists(id: string, dir: string = TOPICS_DIR): Promise<boolean> {
  try {
    await Deno.stat(topicFilePath(id, dir));
    return true;
  } catch {
    return false;
  }
}

/** Persist a TopicDefinition to config/topics/<id>.json (creating the dir if needed). */
export async function saveTopic(topic: TopicDefinition, dir: string = TOPICS_DIR): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(topicFilePath(topic.id, dir), `${JSON.stringify(topic, null, 2)}\n`);
}

/** Remove a saved topic's file. */
export async function deleteTopic(id: string, dir: string = TOPICS_DIR): Promise<void> {
  await Deno.remove(topicFilePath(id, dir));
}

/** List saved topics from a directory (missing dir → empty list; an unparseable file is skipped). */
export async function listTopics(dir: string = TOPICS_DIR): Promise<TopicDefinition[]> {
  const topics: TopicDefinition[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      try {
        topics.push(await loadTopic(topicFilePath(entry.name.replace(/\.json$/, ""), dir)));
      } catch {
        // an unparseable topic file shouldn't take the caller down
      }
    }
  } catch {
    // dir doesn't exist yet
  }
  return topics.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Minimal sanity check before saving a topic: it needs *some* signal to match
 * on. Shared by the CLI (`topic new`) and the web API so both refuse the same
 * empty draft.
 */
export function validateTopicDraft(t: { keywords: string[]; description: string }): string | null {
  if (t.keywords.length === 0 && t.description.trim() === "") {
    return "a topic needs at least one keyword or a description";
  }
  return null;
}

/** Parse a comma-separated string (or pass an array through) into a trimmed, non-empty list. */
export function parseCommaList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v !== "string") return [];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Build an ad-hoc topic from CLI keywords (no saved config). */
export function adHocTopic(keywords: string[]): TopicDefinition {
  return {
    id: keywords.length ? keywords.join("+").toLowerCase() : "all",
    keywords,
    entities: [],
    description: keywords.join(", "),
    exclude: [],
  };
}

/**
 * Phase-0 keyword prefilter. Exclude terms win; with no keywords/entities the
 * topic matches everything (raw firehose). Case-insensitive substring match.
 */
export function matchesTopic(item: Item, topic: TopicDefinition): boolean {
  if (isExcluded(item, topic)) return false;

  const terms = [...topic.keywords, ...topic.entities]
    .map((t) => t.toLowerCase())
    .filter(Boolean);
  if (terms.length === 0) return true;

  const hay = item.text.toLowerCase();
  return terms.some((t) => hay.includes(t));
}

/**
 * Hard negative filter: drop items hitting an `exclude` term. Applied after
 * semantic retrieval (Phase 1) where keyword *matching* is no longer required
 * but exclusions still cut noise. Case-insensitive substring match.
 */
export function isExcluded(item: Item, topic: TopicDefinition): boolean {
  const hay = item.text.toLowerCase();
  return topic.exclude.some((ex) => ex !== "" && hay.includes(ex.toLowerCase()));
}

/**
 * The text embedded to represent a topic for semantic retrieval: the
 * natural-language description carries most of the signal, with keywords and
 * entities appended to sharpen it.
 */
export function buildTopicQuery(topic: TopicDefinition): string {
  const parts = [topic.description, ...topic.keywords, ...topic.entities]
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.join(" ") || topic.id;
}
