import { assertEquals } from "@std/assert";
import { parseDraftFacts } from "../src/facts/reference.ts";

Deno.test("parseDraftFacts: well-formed JSON round-trips", () => {
  const text = JSON.stringify({
    facts: [
      {
        text: "Hyperscale data centers run roughly 528,000 gal/day of water.",
        source_name: "EESI",
        source_url: "https://example.com/eesi/water-usage",
        as_of: "2026-01-01",
      },
    ],
  });
  assertEquals(parseDraftFacts(text), [
    {
      text: "Hyperscale data centers run roughly 528,000 gal/day of water.",
      source_name: "EESI",
      source_url: "https://example.com/eesi/water-usage",
      as_of: "2026-01-01",
    },
  ]);
});

Deno.test("parseDraftFacts: malformed JSON is an empty list, not a throw", () => {
  assertEquals(parseDraftFacts("not json"), []);
  assertEquals(parseDraftFacts("{}"), []);
  assertEquals(parseDraftFacts(JSON.stringify({ facts: "not an array" })), []);
});

Deno.test("parseDraftFacts: drops facts with a non-http(s) or malformed source_url", () => {
  const text = JSON.stringify({
    facts: [
      { text: "ok", source_name: "X", source_url: "javascript:alert(1)", as_of: "2026-01-01" },
      { text: "ok2", source_name: "Y", source_url: "not a url", as_of: "2026-01-01" },
      {
        text: "keeps this one",
        source_name: "Z",
        source_url: "http://example.com",
        as_of: "2026-01-01",
      },
    ],
  });
  const out = parseDraftFacts(text);
  assertEquals(out.length, 1);
  assertEquals(out[0].text, "keeps this one");
});

Deno.test("parseDraftFacts: drops facts missing a required field", () => {
  const text = JSON.stringify({
    facts: [
      { text: "", source_name: "X", source_url: "https://example.com", as_of: "2026-01-01" },
      {
        text: "no source name",
        source_name: "",
        source_url: "https://example.com",
        as_of: "2026-01-01",
      },
      { text: "no as_of", source_name: "X", source_url: "https://example.com", as_of: "" },
    ],
  });
  assertEquals(parseDraftFacts(text), []);
});
