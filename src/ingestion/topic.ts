/**
 * Topic definitions: loading from config and a Phase-0 keyword prefilter.
 *
 * NOTE: real topic matching is *semantic* (embed description + keywords,
 * retrieve nearest items) and lands in Phase 1 behind the CorpusPort. The
 * `matchesTopic` filter here is a cheap keyword/exclude prefilter so a live
 * firehose doesn't flood the console — not the final matcher.
 */

import type { Item, TopicDefinition } from "../ports.ts";

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
  };
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
