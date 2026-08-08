/**
 * ReferenceFactPort — auto-drafted candidate background facts (Track B,
 * auto-draft version). A new port, deliberately not a repurposed SourcePort:
 * SourcePort adapters are built for high-volume, high-churn live discourse
 * and need the coverage-gap machinery; background facts are the opposite —
 * low volume, low churn, and the trust bar is source selection, not corpus
 * breadth.
 *
 * Draft-and-approve only — this NEVER writes to the facts store. Every
 * candidate is provisional until a human approves it through the same
 * create-fact flow the manual-curation UI uses (POST /api/topics/:id/facts).
 * A wrong background fact is worse than a missing one, and unlike a Claim
 * (explicitly someone's assertion, wrong-and-all), a BackgroundFact is
 * presented as settled context — so nothing here auto-publishes.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { TopicDefinition } from "../ports.ts";

// Matches this repo's existing model routing (src/llm/anthropic.ts): Sonnet
// for synthesis-tier work (research + writing), Haiku for high-volume
// extraction, Opus reserved for hard runs.
const DRAFT_MODEL = "claude-sonnet-4-6";

/** A candidate fact awaiting human review — same shape the manual create-fact endpoint accepts. */
export interface DraftFact {
  text: string;
  source_name: string;
  source_url: string;
  /** ISO date string; the client sends this straight through to the manual create-fact endpoint. */
  as_of: string;
}

export interface ReferenceFactPort {
  /** Draft candidate background facts for a topic. Never persists anything. */
  draft(topic: TopicDefinition, count?: number): Promise<DraftFact[]>;
}

const DRAFT_SYSTEM =
  `You research durable, general background context for a news/discourse topic — the kind of thing that's true regardless of any specific local narrative (e.g. "hyperscale data centers typically use hundreds of thousands of gallons of water per day for cooling," not "this specific facility used X gallons last week"). Use web search to find real, checkable sources.

Rules:
- Every fact must be independently verifiable at the source_url you cite. Do not fabricate a citation — if you cannot find a real source, omit that fact.
- Prefer primary/authoritative sources: government agencies, academic research, established standards bodies, or major reference organizations. Avoid single blog posts or opinion pieces.
- Each fact should be general context, not a claim about a specific ongoing event — durable and reusable across topics with similar subject matter, not scoped to "this week's" development.
- source_name is the publisher/organization (e.g. "EPA", "EESI"), not the article title.
- as_of is your best estimate of when the underlying data/figure is from (an ISO date), not today's date.
- You do NOT judge whether the topic's controversy is justified, and you never recommend an action. You only research and cite durable background facts.

Return JSON matching the provided schema. If you cannot find real, verifiable facts, return an empty list rather than guessing.`;

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          source_name: { type: "string" },
          source_url: { type: "string" },
          as_of: { type: "string" },
        },
        required: ["text", "source_name", "source_url", "as_of"],
      },
    },
  },
  required: ["facts"],
} as const;

function firstText(content: Anthropic.ContentBlock[]): string {
  for (const block of content) {
    if (block.type === "text") return block.text;
  }
  return "";
}

/** Defensive parse — mirrors src/llm/anthropic.ts's parseClaims: drop anything malformed rather than throw. */
export function parseDraftFacts(text: string): DraftFact[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const facts = (parsed as { facts?: unknown }).facts;
  if (!Array.isArray(facts)) return [];
  const out: DraftFact[] = [];
  for (const f of facts) {
    const o = f as Record<string, unknown>;
    const text_ = typeof o.text === "string" ? o.text.trim() : "";
    const sourceName = typeof o.source_name === "string" ? o.source_name.trim() : "";
    const sourceUrl = typeof o.source_url === "string" ? o.source_url.trim() : "";
    const asOf = typeof o.as_of === "string" ? o.as_of.trim() : "";
    let validUrl = false;
    try {
      const u = new URL(sourceUrl);
      validUrl = u.protocol === "https:" || u.protocol === "http:";
    } catch { /* not a URL */ }
    if (!text_ || !sourceName || !validUrl || !asOf) continue;
    out.push({ text: text_, source_name: sourceName, source_url: sourceUrl, as_of: asOf });
  }
  return out;
}

export interface AnthropicReferenceFactsOptions {
  apiKey?: string;
  model?: string;
}

export class AnthropicReferenceFacts implements ReferenceFactPort {
  readonly #client: Anthropic;
  readonly #model: string;

  constructor(opts: AnthropicReferenceFactsOptions = {}) {
    this.#client = new Anthropic({ apiKey: opts.apiKey ?? Deno.env.get("ANTHROPIC_API_KEY") });
    this.#model = opts.model ?? DRAFT_MODEL;
  }

  async draft(topic: TopicDefinition, count = 5): Promise<DraftFact[]> {
    const prompt = `Topic: ${topic.description || topic.id}\n` +
      (topic.keywords.length ? `Keywords: ${topic.keywords.join(", ")}\n` : "") +
      (topic.entities.length ? `Entities: ${topic.entities.join(", ")}\n` : "") +
      `\nFind up to ${count} durable background facts relevant to this topic's general subject ` +
      `matter, with real citations.`;

    // Built as an untyped local rather than inlined into the call: this
    // SDK version (@anthropic-ai/sdk@^0.69) has no types yet for
    // `output_config` (structured outputs) or the newer web_search tool
    // variant, even though the API itself accepts both. Passing a variable
    // rather than a fresh object literal sidesteps excess-property
    // checking; the wire request is unaffected.
    const params = {
      model: this.#model,
      max_tokens: 4096,
      system: DRAFT_SYSTEM,
      // web_search_20250305 (basic) rather than the newer dynamic-filtering
      // variant — same SDK-typing gap.
      tools: [{ type: "web_search_20250305" as const, name: "web_search" as const, max_uses: 8 }],
      output_config: { format: { type: "json_schema" as const, schema: DRAFT_SCHEMA } },
      messages: [{ role: "user" as const, content: prompt }],
    };
    const msg = await this.#client.messages.create(params);
    return parseDraftFacts(firstText(msg.content)).slice(0, count);
  }
}
