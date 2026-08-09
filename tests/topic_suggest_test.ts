import { assertEquals } from "@std/assert";
import { lastText, parseSuggestions } from "../src/ingestion/suggest.ts";

Deno.test("parseSuggestions: well-formed JSON round-trips", () => {
  const text = JSON.stringify({
    keywords: ["data center", "hyperscaler"],
    entities: ["Amazon Web Services"],
    exclude: ["job search"],
    rationale: "Job-search posts mention 'data science' and collide on the shared word.",
  });
  assertEquals(parseSuggestions(text), {
    keywords: ["data center", "hyperscaler"],
    entities: ["Amazon Web Services"],
    exclude: ["job search"],
    rationale: "Job-search posts mention 'data science' and collide on the shared word.",
  });
});

Deno.test("parseSuggestions: malformed JSON is an empty result, not a throw", () => {
  const empty = { keywords: [], entities: [], exclude: [], rationale: "" };
  assertEquals(parseSuggestions("not json"), empty);
  assertEquals(parseSuggestions("{}"), empty);
});

Deno.test("parseSuggestions: drops non-string entries and dedupes case-insensitively", () => {
  const text = JSON.stringify({
    keywords: ["data center", "Data Center", "data center", 42, ""],
    entities: [],
    exclude: [],
    rationale: "",
  });
  assertEquals(parseSuggestions(text).keywords, ["data center"]);
});

Deno.test("lastText: picks the final text block, not the first", () => {
  // deno-lint-ignore no-explicit-any
  const content: any = [
    { type: "text", text: "Let me look into this topic..." },
    { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
    { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [] },
    { type: "text", text: '{"keywords":[],"entities":[],"exclude":[],"rationale":""}' },
  ];
  assertEquals(lastText(content), '{"keywords":[],"entities":[],"exclude":[],"rationale":""}');
});

Deno.test("lastText: no text block at all is an empty string, not a throw", () => {
  // deno-lint-ignore no-explicit-any
  const content: any = [
    { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
  ];
  assertEquals(lastText(content), "");
});
