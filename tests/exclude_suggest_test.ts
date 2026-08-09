import { assertEquals } from "@std/assert";
import { parseExcludeSuggestions } from "../src/briefing/exclude_suggest.ts";

Deno.test("parseExcludeSuggestions: well-formed JSON round-trips", () => {
  const text = JSON.stringify({
    suggestions: [
      { term: "job search", reason: "Career posts mention 'data science', not data centers." },
    ],
  });
  assertEquals(parseExcludeSuggestions(text), [
    { term: "job search", reason: "Career posts mention 'data science', not data centers." },
  ]);
});

Deno.test("parseExcludeSuggestions: malformed JSON is an empty list, not a throw", () => {
  assertEquals(parseExcludeSuggestions("not json"), []);
  assertEquals(parseExcludeSuggestions("{}"), []);
  assertEquals(parseExcludeSuggestions(JSON.stringify({ suggestions: "nope" })), []);
});

Deno.test("parseExcludeSuggestions: drops entries missing a term or reason, dedupes by term", () => {
  const text = JSON.stringify({
    suggestions: [
      { term: "", reason: "no term" },
      { term: "no reason", reason: "" },
      {
        term: "graphic design",
        reason: "Unrelated design-critique posts share the word 'Google'.",
      },
      { term: "Graphic Design", reason: "duplicate, different case" },
    ],
  });
  const out = parseExcludeSuggestions(text);
  assertEquals(out.length, 1);
  assertEquals(out[0].term, "graphic design");
});
