/**
 * Gate for DB-backed integration tests. `deno task test` auto-loads .env via
 * --env-file, and this repo's .env DATABASE_URL is the live production
 * database (see CLAUDE.md), not a throwaway — several integration tests call
 * .clear() in their setup, and running them against whatever DATABASE_URL
 * happens to be present wiped the real corpus and briefing history once
 * already. PARALLAX_FIX_TEST_DB=1 is an explicit, separate opt-in: DB-backed
 * tests only run when it's set, decoupling "DATABASE_URL exists" from
 * "it's safe to clear." Point DATABASE_URL at a disposable Postgres when
 * setting it.
 */
export function testDatabaseUrl(): string | undefined {
  if (Deno.env.get("PARALLAX_FIX_TEST_DB") !== "1") return undefined;
  return Deno.env.get("DATABASE_URL");
}
