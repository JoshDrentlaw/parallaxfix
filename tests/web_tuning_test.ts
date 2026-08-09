import { assertEquals } from "@std/assert";
import { createHandler } from "../src/web/server.ts";
import { DEFAULT_THRESHOLDS } from "../src/briefing/thresholds.ts";
import { sampleBriefing } from "./fixtures/briefing.ts";
import { testDatabaseUrl } from "./db_test_guard.ts";

const get = (path: string) => new Request(`http://localhost${path}`);
const put = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const DATABASE_URL = testDatabaseUrl();

Deno.test("web: /api/tuning routes 503 without a corpus", async () => {
  const handler = createHandler({ databaseUrl: () => undefined });
  assertEquals((await handler(get("/api/tuning"))).status, 503);
  assertEquals((await handler(put("/api/tuning", DEFAULT_THRESHOLDS))).status, 503);
});

Deno.test({
  name: "web: GET /api/tuning returns defaults + scores; PUT validates and persists",
  ignore: !DATABASE_URL,
  async fn() {
    const { ThresholdStore } = await import("../src/briefing/thresholds.ts");
    const { BriefingStore } = await import("../src/briefing/store.ts");
    const thresholds = new ThresholdStore(DATABASE_URL!);
    const briefings = new BriefingStore(DATABASE_URL!);
    await thresholds.init();
    await briefings.init();
    await thresholds.clear();
    await briefings.clear();
    await briefings.save(sampleBriefing());
    await thresholds.close();
    await briefings.close();

    const handler = createHandler({ databaseUrl: () => DATABASE_URL });

    const before = await (await handler(get("/api/tuning"))).json();
    assertEquals(before.thresholds, DEFAULT_THRESHOLDS);
    assertEquals(before.scores.length, 2); // sampleBriefing() has 2 narratives

    const invalidRes = await handler(put("/api/tuning", { ...DEFAULT_THRESHOLDS, hot: 0.1 }));
    assertEquals(invalidRes.status, 400);

    const tuned = { hot: 4, active: 1, strong: 0.7, plausible: 0.55 };
    const putRes = await handler(put("/api/tuning", tuned));
    assertEquals(putRes.status, 200);
    assertEquals(await putRes.json(), tuned);

    const after = await (await handler(get("/api/tuning"))).json();
    assertEquals(after.thresholds, tuned);
  },
});
