/**
 * Background-fact storage (Track B, manual curation) — durable general
 * context for a topic's subject matter, independent of any specific
 * narrative in the corpus. See the `BackgroundFact`/`Tag` doc comments in
 * `../ports.ts` for the shape rationale (a fact exists once; topics attach
 * to it via a many-to-many join, so two topics that want the same fact don't
 * duplicate — and can't drift out of sync — it).
 *
 * Lives in the same Postgres database as `PgCorpus` (one `DATABASE_URL` per
 * CLAUDE.md's corpus-stack decision) but is its own connection and its own
 * schema concern: these are human-authored rows, not derived from ingested
 * items, so this deliberately does NOT go through `CorpusPort`.
 */

import postgres from "postgres";
import type { BackgroundFact, Tag } from "../ports.ts";

type Sql = ReturnType<typeof postgres>;
type Row = Record<string, unknown>;

function rowToFact(r: Row): BackgroundFact {
  return {
    id: r.id as string,
    text: r.text as string,
    source_name: r.source_name as string,
    source_url: r.source_url as string,
    as_of: r.as_of as Date,
  };
}

function rowToTag(r: Row): Tag {
  return {
    id: r.id as string,
    slug: r.slug as string,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
  };
}

export class FactStore {
  readonly #sql: Sql;

  constructor(databaseUrl: string) {
    this.#sql = postgres(databaseUrl, { onnotice: () => {} });
  }

  /** Idempotent schema setup. Safe to call alongside PgCorpus.init() against the same DB. */
  async init(): Promise<void> {
    const sql = this.#sql;
    await sql`
      CREATE TABLE IF NOT EXISTS background_facts (
        id          text PRIMARY KEY,
        text        text NOT NULL,
        source_name text NOT NULL,
        source_url  text NOT NULL,
        as_of       timestamptz NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS topic_background_facts (
        topic_id    text NOT NULL,
        fact_id     text NOT NULL REFERENCES background_facts(id) ON DELETE CASCADE,
        attached_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (topic_id, fact_id)
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS tags (
        id          text PRIMARY KEY,
        slug        text NOT NULL UNIQUE,
        name        text NOT NULL,
        description text
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS fact_tags (
        fact_id text NOT NULL REFERENCES background_facts(id) ON DELETE CASCADE,
        tag_id  text NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (fact_id, tag_id)
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS topic_tags (
        topic_id text NOT NULL,
        tag_id   text NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (topic_id, tag_id)
      )
    `;
  }

  // ── tags — a controlled vocabulary; a tag must exist before it's applied ──

  async listTags(): Promise<Tag[]> {
    const rows = await this.#sql`SELECT * FROM tags ORDER BY name`;
    return rows.map((r) => rowToTag(r as unknown as Row));
  }

  /** Create a tag, or return the existing one if the slug is already taken (idempotent). */
  async createTag(slug: string, name: string, description: string | null = null): Promise<Tag> {
    const inserted = await this.#sql`
      INSERT INTO tags (id, slug, name, description)
      VALUES (${crypto.randomUUID()}, ${slug}, ${name}, ${description})
      ON CONFLICT (slug) DO NOTHING
      RETURNING *
    `;
    if (inserted.length > 0) return rowToTag(inserted[0] as unknown as Row);
    const existing = await this.#sql`SELECT * FROM tags WHERE slug = ${slug}`;
    return rowToTag(existing[0] as unknown as Row);
  }

  /** A single tag by id (indexed lookup) — for "attach an existing tag" flows that only need one row. */
  async getTag(id: string): Promise<Tag | null> {
    const rows = await this.#sql`SELECT * FROM tags WHERE id = ${id}`;
    return rows.length > 0 ? rowToTag(rows[0] as unknown as Row) : null;
  }

  // ── facts — durable, standalone; topic-scoping is via the join tables below ──

  async createFact(
    fact: { text: string; source_name: string; source_url: string; as_of: Date },
  ): Promise<BackgroundFact> {
    const rows = await this.#sql`
      INSERT INTO background_facts (id, text, source_name, source_url, as_of)
      VALUES (
        ${crypto.randomUUID()}, ${fact.text}, ${fact.source_name}, ${fact.source_url}, ${fact.as_of}
      )
      RETURNING *
    `;
    return rowToFact(rows[0] as unknown as Row);
  }

  async listAllFacts(): Promise<BackgroundFact[]> {
    const rows = await this.#sql`SELECT * FROM background_facts ORDER BY as_of DESC`;
    return rows.map((r) => rowToFact(r as unknown as Row));
  }

  /** A single fact by id (indexed lookup) — for "attach an existing fact" flows that only need one row. */
  async getFact(id: string): Promise<BackgroundFact | null> {
    const rows = await this.#sql`SELECT * FROM background_facts WHERE id = ${id}`;
    return rows.length > 0 ? rowToFact(rows[0] as unknown as Row) : null;
  }

  /** Deletes the fact record itself (cascades to its attachments and tags). */
  async deleteFact(id: string): Promise<void> {
    await this.#sql`DELETE FROM background_facts WHERE id = ${id}`;
  }

  // ── topic <-> fact attachment (the only persisted topic relation — see
  //    ports.ts: Topic is the durable entity here, same as it is for feeds) ──

  async attachFactToTopic(topicId: string, factId: string): Promise<void> {
    await this.#sql`
      INSERT INTO topic_background_facts (topic_id, fact_id)
      VALUES (${topicId}, ${factId})
      ON CONFLICT DO NOTHING
    `;
  }

  async detachFactFromTopic(topicId: string, factId: string): Promise<void> {
    await this.#sql`
      DELETE FROM topic_background_facts WHERE topic_id = ${topicId} AND fact_id = ${factId}
    `;
  }

  async factsForTopic(topicId: string): Promise<BackgroundFact[]> {
    const rows = await this.#sql`
      SELECT bf.* FROM background_facts bf
      JOIN topic_background_facts tbf ON bf.id = tbf.fact_id
      WHERE tbf.topic_id = ${topicId}
      ORDER BY bf.as_of DESC
    `;
    return rows.map((r) => rowToFact(r as unknown as Row));
  }

  // ── tag <-> fact, tag <-> topic ──

  async tagFact(factId: string, tagId: string): Promise<void> {
    await this.#sql`
      INSERT INTO fact_tags (fact_id, tag_id) VALUES (${factId}, ${tagId}) ON CONFLICT DO NOTHING
    `;
  }

  async tagTopic(topicId: string, tagId: string): Promise<void> {
    await this.#sql`
      INSERT INTO topic_tags (topic_id, tag_id) VALUES (${topicId}, ${tagId}) ON CONFLICT DO NOTHING
    `;
  }

  async untagTopic(topicId: string, tagId: string): Promise<void> {
    await this.#sql`DELETE FROM topic_tags WHERE topic_id = ${topicId} AND tag_id = ${tagId}`;
  }

  async tagsForTopic(topicId: string): Promise<Tag[]> {
    const rows = await this.#sql`
      SELECT t.* FROM tags t
      JOIN topic_tags tt ON t.id = tt.tag_id
      WHERE tt.topic_id = ${topicId}
      ORDER BY t.name
    `;
    return rows.map((r) => rowToTag(r as unknown as Row));
  }

  async tagsForFact(factId: string): Promise<Tag[]> {
    const rows = await this.#sql`
      SELECT t.* FROM tags t
      JOIN fact_tags ft ON t.id = ft.tag_id
      WHERE ft.fact_id = ${factId}
      ORDER BY t.name
    `;
    return rows.map((r) => rowToTag(r as unknown as Row));
  }

  /**
   * Facts sharing a tag with this topic that aren't attached to it yet — the
   * "attach existing facts to a new topic" suggestion query, via the tag join
   * rather than string matching.
   */
  async suggestFactsForTopic(topicId: string): Promise<BackgroundFact[]> {
    const rows = await this.#sql`
      SELECT DISTINCT bf.* FROM background_facts bf
      JOIN fact_tags ft ON bf.id = ft.fact_id
      WHERE ft.tag_id IN (SELECT tag_id FROM topic_tags WHERE topic_id = ${topicId})
        AND bf.id NOT IN (
          SELECT fact_id FROM topic_background_facts WHERE topic_id = ${topicId}
        )
      ORDER BY bf.as_of DESC
    `;
    return rows.map((r) => rowToFact(r as unknown as Row));
  }

  /** Test helper: wipe every fact/tag table. */
  async clear(): Promise<void> {
    await this.#sql`TRUNCATE background_facts, tags CASCADE`;
  }

  async close(): Promise<void> {
    await this.#sql.end();
  }
}
