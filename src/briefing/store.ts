/**
 * Briefing persistence (Track A #5) — the "briefings you've read before"
 * library. Stores the full serialized Briefing (already JSON-safe: dates as
 * ISO strings, exactly what `/api/brief` already returns) keyed by
 * topic_id + generated_at, the natural key the UX proposal calls out.
 *
 * Own Postgres connection, same DB as PgCorpus/FactStore but a separate
 * schema concern — mirrors src/facts/store.ts's per-call lifecycle.
 */

import postgres from "postgres";
import type { Briefing } from "../ports.ts";

type Sql = ReturnType<typeof postgres>;
type Row = Record<string, unknown>;

export interface BriefingSummary {
  id: string;
  topic_id: string;
  generated_at: Date;
  narrative_count: number;
  total_items: number;
  total_claims: number;
  /** The top (fastest-moving) narrative's velocity/label, or null for an empty briefing. */
  top_velocity: number | null;
  top_label: string | null;
}

function briefingId(topicId: string, generatedAt: Date): string {
  return `${topicId}::${generatedAt.toISOString()}`;
}

function rowToSummary(r: Row): BriefingSummary {
  return {
    id: r.id as string,
    topic_id: r.topic_id as string,
    generated_at: r.generated_at as Date,
    narrative_count: Number(r.narrative_count),
    total_items: Number(r.total_items),
    total_claims: Number(r.total_claims),
    top_velocity: r.top_velocity === null ? null : Number(r.top_velocity),
    top_label: (r.top_label as string | null) ?? null,
  };
}

export class BriefingStore {
  readonly #sql: Sql;

  constructor(databaseUrl: string) {
    this.#sql = postgres(databaseUrl, { onnotice: () => {} });
  }

  async init(): Promise<void> {
    const sql = this.#sql;
    await sql`
      CREATE TABLE IF NOT EXISTS briefings (
        id              text PRIMARY KEY,
        topic_id        text NOT NULL,
        generated_at    timestamptz NOT NULL,
        narrative_count int NOT NULL,
        total_items     int NOT NULL,
        total_claims    int NOT NULL,
        top_velocity    double precision,
        top_label       text,
        data            jsonb NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now()
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS briefings_topic_generated
      ON briefings (topic_id, generated_at DESC)
    `;
  }

  /** Save a briefing. Idempotent on topic_id+generated_at — a re-run with the same timestamp overwrites. */
  async save(briefing: Briefing): Promise<void> {
    const id = briefingId(briefing.topic_id, briefing.generated_at);
    // narratives are already sorted by velocity (P5) by the time they reach here.
    const top = briefing.narratives[0] ?? null;
    await this.#sql`
      INSERT INTO briefings (
        id, topic_id, generated_at, narrative_count, total_items, total_claims,
        top_velocity, top_label, data
      ) VALUES (
        ${id}, ${briefing.topic_id}, ${briefing.generated_at},
        ${briefing.narratives.length}, ${briefing.total_items}, ${briefing.total_claims},
        ${top?.velocity ?? null}, ${top?.label || null},
        ${this.#sql.json(briefing as unknown as Parameters<Sql["json"]>[0])}
      )
      ON CONFLICT (id) DO UPDATE SET
        narrative_count = EXCLUDED.narrative_count,
        total_items = EXCLUDED.total_items,
        total_claims = EXCLUDED.total_claims,
        top_velocity = EXCLUDED.top_velocity,
        top_label = EXCLUDED.top_label,
        data = EXCLUDED.data
    `;
  }

  /** Past briefings for a topic, most recent first — summaries only, no full payload. */
  async listForTopic(topicId: string, limit = 20): Promise<BriefingSummary[]> {
    const rows = await this.#sql`
      SELECT id, topic_id, generated_at, narrative_count, total_items, total_claims,
             top_velocity, top_label
      FROM briefings
      WHERE topic_id = ${topicId}
      ORDER BY generated_at DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => rowToSummary(r as unknown as Row));
  }

  /** The full stored payload for one briefing — same JSON shape /api/brief already returns. */
  async get(id: string): Promise<Row | null> {
    const rows = await this.#sql`SELECT data FROM briefings WHERE id = ${id}`;
    if (rows.length === 0) return null;
    return (rows[0] as unknown as Row).data as Row;
  }

  /**
   * Each topic's most recent briefing — the "what's moving" home view (Track
   * A #6): a velocity-ranked snapshot across saved topics without opening any
   * one of them.
   */
  async latestPerTopic(): Promise<BriefingSummary[]> {
    const rows = await this.#sql`
      SELECT DISTINCT ON (topic_id)
        id, topic_id, generated_at, narrative_count, total_items, total_claims,
        top_velocity, top_label
      FROM briefings
      ORDER BY topic_id, generated_at DESC
    `;
    return rows.map((r) => rowToSummary(r as unknown as Row));
  }

  /**
   * Every narrative's raw velocity/relevance across every stored briefing,
   * ever — the tuning page's histogram source (see src/briefing/thresholds.ts):
   * thresholds should be set where this distribution actually separates, not
   * guessed. Unnests the stored JSON rather than requiring a separate scored-
   * pairs table, since `narratives[].velocity/.relevance` already carry
   * exactly this data.
   */
  async allNarrativeScores(): Promise<{ velocity: number; relevance: number }[]> {
    const rows = await this.#sql`
      SELECT
        (elem->>'velocity')::double precision AS velocity,
        (elem->>'relevance')::double precision AS relevance
      FROM briefings, jsonb_array_elements(data->'narratives') AS elem
    `;
    return rows.map((r) => {
      const row = r as unknown as Row;
      return { velocity: Number(row.velocity), relevance: Number(row.relevance) };
    });
  }

  /** Test helper: wipe the briefings table. */
  async clear(): Promise<void> {
    await this.#sql`TRUNCATE briefings`;
  }

  async close(): Promise<void> {
    await this.#sql.end();
  }
}
