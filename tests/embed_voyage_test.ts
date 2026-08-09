import { assertEquals, assertRejects } from "@std/assert";
import { EmbeddingError, parseEmbeddings, VoyageEmbedder } from "../src/corpus/embed_voyage.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

Deno.test("parseEmbeddings: well-formed response round-trips, order restored from index", () => {
  const out = parseEmbeddings(
    { data: [{ embedding: [0.2, 0.3], index: 1 }, { embedding: [0.1, 0.1], index: 0 }] },
    2,
  );
  assertEquals(out, [[0.1, 0.1], [0.2, 0.3]]);
});

Deno.test("parseEmbeddings: rejects a response with the wrong number of embeddings", () => {
  let threw = false;
  try {
    parseEmbeddings({ data: [{ embedding: [0.1], index: 0 }] }, 2);
  } catch (err) {
    threw = err instanceof EmbeddingError;
  }
  assertEquals(threw, true);
});

Deno.test("parseEmbeddings: rejects a malformed embedding entry (NaN, missing index, wrong shape)", () => {
  for (
    const bad of [
      { data: [{ embedding: [0.1, NaN], index: 0 }] },
      { data: [{ embedding: [0.1], index: -1 }] },
      { data: [{ index: 0 }] },
      { data: "not an array" },
    ]
  ) {
    let threw = false;
    try {
      parseEmbeddings(bad, 1);
    } catch (err) {
      threw = err instanceof EmbeddingError;
    }
    assertEquals(threw, true, `expected a throw for ${JSON.stringify(bad)}`);
  }
});

Deno.test("VoyageEmbedder: embed() sends input_type=document, embedQuery() sends input_type=query", async () => {
  const seen: { input: string[]; model: string; input_type: string }[] = [];
  const embedder = new VoyageEmbedder({
    apiKey: "test-key",
    model: "voyage-3.5",
    fetchImpl: ((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      seen.push(body);
      return Promise.resolve(jsonResponse(
        200,
        { data: body.input.map((_: string, i: number) => ({ embedding: [i, i], index: i })) },
      ));
    }) as typeof fetch,
  });

  await embedder.embed(["a", "b"]);
  await embedder.embedQuery("c");

  assertEquals(seen[0].input_type, "document");
  assertEquals(seen[0].input, ["a", "b"]);
  assertEquals(seen[1].input_type, "query");
  assertEquals(seen[1].input, ["c"]);
});

Deno.test("VoyageEmbedder: retries a 429, then succeeds", async () => {
  let calls = 0;
  const embedder = new VoyageEmbedder({
    apiKey: "test-key",
    fetchImpl: (() => {
      calls++;
      if (calls === 1) return Promise.resolve(jsonResponse(429, { detail: "rate limited" }));
      return Promise.resolve(
        jsonResponse(200, { data: [{ embedding: [1, 2, 3], index: 0 }] }),
      );
    }) as typeof fetch,
    sleep: () => Promise.resolve(),
  });

  const out = await embedder.embed(["hello"]);
  assertEquals(out, [[1, 2, 3]]);
  assertEquals(calls, 2);
});

Deno.test("VoyageEmbedder: a non-retryable status fails immediately, no retry", async () => {
  let calls = 0;
  const embedder = new VoyageEmbedder({
    apiKey: "test-key",
    fetchImpl: (() => {
      calls++;
      return Promise.resolve(jsonResponse(401, { detail: "bad key" }));
    }) as typeof fetch,
    sleep: () => Promise.resolve(),
  });

  await assertRejects(() => embedder.embed(["hello"]), EmbeddingError);
  assertEquals(calls, 1);
});

Deno.test("VoyageEmbedder: exhausts retries on persistent 5xx and throws", async () => {
  let calls = 0;
  const embedder = new VoyageEmbedder({
    apiKey: "test-key",
    fetchImpl: (() => {
      calls++;
      return Promise.resolve(jsonResponse(503, { detail: "down" }));
    }) as typeof fetch,
    sleep: () => Promise.resolve(),
  });

  await assertRejects(() => embedder.embed(["hello"]), EmbeddingError);
  assertEquals(calls, 4);
});

Deno.test("VoyageEmbedder: empty input short-circuits without a request", async () => {
  let calls = 0;
  const embedder = new VoyageEmbedder({
    apiKey: "test-key",
    fetchImpl: (() => {
      calls++;
      return Promise.resolve(jsonResponse(200, { data: [] }));
    }) as typeof fetch,
  });
  assertEquals(await embedder.embed([]), []);
  assertEquals(calls, 0);
});

Deno.test("VoyageEmbedder: constructor requires an apiKey (explicit or VOYAGE_API_KEY)", () => {
  const original = Deno.env.get("VOYAGE_API_KEY");
  Deno.env.delete("VOYAGE_API_KEY");
  try {
    let threw = false;
    try {
      new VoyageEmbedder();
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
  } finally {
    if (original !== undefined) Deno.env.set("VOYAGE_API_KEY", original);
  }
});
