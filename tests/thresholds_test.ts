import { assertEquals } from "@std/assert";
import { DEFAULT_THRESHOLDS, validateThresholds } from "../src/briefing/thresholds.ts";

Deno.test("validateThresholds: accepts the shipped defaults", () => {
  assertEquals(validateThresholds(DEFAULT_THRESHOLDS), null);
});

Deno.test("validateThresholds: rejects hot <= active, strong <= plausible, negatives, non-finite", () => {
  const base = DEFAULT_THRESHOLDS;
  assertEquals(validateThresholds({ ...base, hot: 0.5, active: 0.5 }) !== null, true);
  assertEquals(validateThresholds({ ...base, strong: 0.5, plausible: 0.5 }) !== null, true);
  assertEquals(validateThresholds({ ...base, active: -1 }) !== null, true);
  assertEquals(validateThresholds({ ...base, plausible: -1 }) !== null, true);
  assertEquals(validateThresholds({ ...base, hot: NaN }) !== null, true);
  assertEquals(validateThresholds({ ...base, strong: Infinity }) !== null, true);
});

const DATABASE_URL = Deno.env.get("DATABASE_URL");

Deno.test({
  name:
    "ThresholdStore: get() returns shipped defaults until set() is called; set() persists and validates",
  ignore: !DATABASE_URL,
  async fn() {
    const { ThresholdStore } = await import("../src/briefing/thresholds.ts");
    const store = new ThresholdStore(DATABASE_URL!);
    try {
      await store.init();
      await store.clear();

      assertEquals(await store.get(), DEFAULT_THRESHOLDS);

      const tuned = { hot: 4, active: 1, strong: 0.7, plausible: 0.55 };
      const saved = await store.set(tuned);
      assertEquals(saved, tuned);
      assertEquals(await store.get(), tuned);

      // set() again overwrites the single row, not a second one.
      const retuned = { hot: 5, active: 1.5, strong: 0.75, plausible: 0.6 };
      await store.set(retuned);
      assertEquals(await store.get(), retuned);
    } finally {
      await store.close();
    }
  },
});
