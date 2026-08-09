/**
 * Tunable bucket thresholds (ported from Job Radar's app.settings pattern) —
 * the second half of the 2026-08 tiering work alongside the Voyage rerank
 * tier (see CLAUDE.md's Corpus stack section).
 *
 * velocityBucket()/relevanceBucket() (src/web/static/app.js) used to be pure
 * functions over hardcoded constants (hot >= 3, active >= 0.5, strong >=
 * 0.65, plausible >= 0.5) — literally an "untuned heuristic, revisit once
 * there's real usage data" comment sitting in the code. This is that
 * revisiting mechanism: thresholds live here, are read live by the client
 * instead of baked into the bundle, and the tuning page shows the actual
 * score distribution (BriefingStore.allNarrativeScores) so they get set
 * where the data separates, not by guessing. A single row, not a per-topic
 * setting — velocity/relevance mean the same thing everywhere in the app.
 */

import postgres from "postgres";

type Sql = ReturnType<typeof postgres>;
type Row = Record<string, unknown>;

export interface BucketThresholds {
  hot: number;
  active: number;
  strong: number;
  plausible: number;
}

/** Matches the hardcoded values velocityBucket()/relevanceBucket() shipped with before this existed. */
export const DEFAULT_THRESHOLDS: BucketThresholds = {
  hot: 3,
  active: 0.5,
  strong: 0.65,
  plausible: 0.5,
};

const ROW_ID = "default";

function rowToThresholds(r: Row): BucketThresholds {
  return {
    hot: Number(r.hot),
    active: Number(r.active),
    strong: Number(r.strong),
    plausible: Number(r.plausible),
  };
}

/** `null` means "valid"; a string is the human-readable reason it was rejected. */
export function validateThresholds(t: BucketThresholds): string | null {
  for (const [k, v] of Object.entries(t)) {
    if (typeof v !== "number" || !Number.isFinite(v)) return `${k} must be a finite number`;
  }
  if (t.hot <= t.active) return "hot must be greater than active";
  if (t.active < 0) return "active must be at least 0";
  if (t.strong <= t.plausible) return "strong must be greater than plausible";
  if (t.plausible < 0) return "plausible must be at least 0";
  return null;
}

export class ThresholdStore {
  readonly #sql: Sql;

  constructor(databaseUrl: string) {
    this.#sql = postgres(databaseUrl, { onnotice: () => {} });
  }

  async init(): Promise<void> {
    await this.#sql`
      CREATE TABLE IF NOT EXISTS bucket_thresholds (
        id         text PRIMARY KEY,
        hot        double precision NOT NULL,
        active     double precision NOT NULL,
        strong     double precision NOT NULL,
        plausible  double precision NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `;
  }

  /** The current thresholds, or the shipped defaults if never tuned. */
  async get(): Promise<BucketThresholds> {
    const rows = await this.#sql`SELECT * FROM bucket_thresholds WHERE id = ${ROW_ID}`;
    if (rows.length === 0) return { ...DEFAULT_THRESHOLDS };
    return rowToThresholds(rows[0] as unknown as Row);
  }

  /** Upsert the single settings row. Caller validates first (see validateThresholds). */
  async set(t: BucketThresholds): Promise<BucketThresholds> {
    const rows = await this.#sql`
      INSERT INTO bucket_thresholds (id, hot, active, strong, plausible, updated_at)
      VALUES (${ROW_ID}, ${t.hot}, ${t.active}, ${t.strong}, ${t.plausible}, now())
      ON CONFLICT (id) DO UPDATE SET
        hot = EXCLUDED.hot,
        active = EXCLUDED.active,
        strong = EXCLUDED.strong,
        plausible = EXCLUDED.plausible,
        updated_at = EXCLUDED.updated_at
      RETURNING *
    `;
    return rowToThresholds(rows[0] as unknown as Row);
  }

  /** Test helper: back to "never tuned" (get() returns the defaults again). */
  async clear(): Promise<void> {
    await this.#sql`TRUNCATE bucket_thresholds`;
  }

  async close(): Promise<void> {
    await this.#sql.end();
  }
}
