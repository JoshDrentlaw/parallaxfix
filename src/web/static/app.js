// Parallax Fix web client. Everything rendered here is INGESTED, UNTRUSTED
// content (CLAUDE.md / SECURITY.md §5): all text lands via textContent, never
// innerHTML, and every outbound href is scheme-checked. Data, not markup.

"use strict";

const $ = (sel) => document.querySelector(sel);

// ── DOM helpers (textContent only — the injection boundary) ────────────────

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child);
  }
  return node;
}

// Provenance URLs come from ingested content — allow only http(s).
function safeLink(url, text, cls) {
  let ok = false;
  try {
    const u = new URL(url);
    ok = u.protocol === "https:" || u.protocol === "http:";
  } catch { /* not a URL */ }
  if (!ok) return el("span", { class: cls, text: text });
  return el("a", {
    href: url,
    target: "_blank",
    rel: "noopener noreferrer",
    class: cls,
    text: text,
  });
}

function fmtTime(iso) {
  if (!iso) return "?";
  return String(iso).slice(0, 16).replace("T", " ") + "Z";
}

// ── theme (dark to start; the toggle is the override) ──────────────────────

function initTheme() {
  const saved = localStorage.getItem("parallax-theme");
  if (saved === "light" || saved === "dark") {
    document.documentElement.dataset.theme = saved;
  }
  $("#theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("parallax-theme", next);
  });
}

// ── status chips ────────────────────────────────────────────────────────────

function chip(state, label) {
  return el("span", { class: `chip ${state}` }, el("span", { class: "dot" }), label);
}

async function loadStatus() {
  try {
    const s = await (await fetch("api/status")).json();
    const chips = $("#status-chips");
    chips.replaceChildren(
      chip(
        s.corpus_configured ? "on" : "off",
        s.corpus_configured ? "corpus" : "corpus: no DATABASE_URL",
      ),
      chip(s.llm_configured ? "on" : "off", s.llm_configured ? "claude" : "claude: no key"),
      chip(
        s.reddit_mode === "oauth" ? "on" : "warn",
        s.reddit_mode === "oauth" ? "reddit: oauth" : "reddit: keyless rss",
      ),
      chip("off", "blind: " + s.declared_blind_spots.map((b) => b.source).join(", ")),
    );
  } catch { /* status is cosmetic; the actions surface real errors */ }
}

async function loadTopics() {
  try {
    const topics = await (await fetch("api/topics")).json();
    const select = $("#topic-select");
    for (const t of topics) {
      select.append(el("option", { value: t.id, text: t.id }));
    }
  } catch { /* no saved topics is fine */ }
}

// ── renderers (coverage first, always — P1) ────────────────────────────────

function renderCoverage(c) {
  const card = el("section", { class: "card coverage" });
  card.append(
    el("h2", { class: "section-title", text: "Coverage — what this run could and could NOT see " }),
  );
  card.append(el("p", {
    class: "meta",
    text: `topic "${c.topic_id}" · run ${fmtTime(c.run_at)} · window ${fmtTime(c.window[0])} → ${
      fmtTime(c.window[1])
    }`,
  }));

  const grid = el("div", { class: "coverage-grid" });
  const queried = c.sources_queried || [];
  if (queried.length === 0) {
    grid.append(el("span", { class: "empty", text: "no sources queried" }));
  }
  for (const s of queried) {
    grid.append(
      el(
        "div",
        { class: "src-tile" },
        el("div", { class: "n", text: String(c.items_per_source[s] ?? 0) }),
        el("div", { class: "s", text: s }),
      ),
    );
  }
  card.append(grid);

  for (const u of c.sources_unavailable || []) {
    card.append(
      el(
        "div",
        { class: "gap" },
        el("span", { class: "src", text: `✗ ${u.source}` }),
        el("span", { class: "why", text: u.reason }),
      ),
    );
    const sig = (c.blind_spot_signals || []).find((x) => x.platform === u.source);
    if (sig) {
      const by = Object.entries(sig.by_source).map(([s, n]) => `${s} ${n}`).join(", ");
      card.append(el("div", {
        class: "signal",
        text: `↳ but ${sig.referencing_items} reachable item(s) point at it (${by}) · ` +
          `${sig.references_per_hour.toFixed(1)}/h` +
          (sig.top_targets[0] && sig.top_targets[0].mentions > 1
            ? ` · ${sig.top_targets[0].mentions} converge on ${sig.top_targets[0].target}`
            : ""),
      }));
    }
  }
  if ((c.blind_spot_signals || []).length) {
    card.append(el("p", {
      class: "signal-note",
      text: "references = attention, not content; links can be gamed — treat as a lead.",
    }));
  }
  return card;
}

function provenanceLine(e) {
  const line = el(
    "p",
    { class: "provenance" },
    el("span", { class: "src-tag", text: e.source }),
    ` ${e.author ?? "(unknown)"} · ${fmtTime(e.created_at)} · `,
  );
  line.append(safeLink(e.url, "open ↗"));
  return line;
}

function renderNarrative(n, i, provenance) {
  const card = el("article", { class: "card narrative" });
  const head = el(
    "div",
    { class: "narrative-head" },
    el("span", { class: "rank", text: `#${i + 1}` }),
    el("span", {
      class: n.label ? "label" : "label unlabeled",
      text: n.label || "(unlabeled — set ANTHROPIC_API_KEY for labels)",
    }),
    el(
      "span",
      { class: "narrative-meta" },
      el("span", { class: "velocity", text: `${n.velocity.toFixed(2)}/h` }),
      el("span", { class: "relevance", text: `relevance ${n.relevance.toFixed(2)}` }),
      ` · ${n.size} item(s) · first seen ${fmtTime(n.first_seen)}`,
    ),
  );
  card.append(head);

  for (const id of n.representative_item_ids) {
    const e = provenance[id];
    if (!e) continue;
    card.append(
      el(
        "div",
        { class: "exemplar" },
        el("p", { class: "excerpt", text: e.excerpt }),
        provenanceLine(e),
      ),
    );
  }

  if (n.claims.length) {
    const claims = el("div", { class: "claims" });
    for (const c of n.claims) {
      const links = el("span", { class: "links" });
      for (const sid of c.supporting_item_ids) {
        const e = provenance[sid];
        if (e) links.append(safeLink(e.url, "↳ src"));
      }
      claims.append(
        el(
          "div",
          { class: "claim" },
          el("span", {
            class: `badge ${c.evidence_type}`,
            text: c.evidence_type.replace("_", " "),
          }),
          el("span", { text: c.text }),
          el("span", {
            class: "meta",
            text: `${c.supporting_item_ids.length} src` +
              (c.verify_hint ? ` · verify: ${c.verify_hint}` : ""),
          }),
          links,
        ),
      );
    }
    card.append(claims);
  }
  return card;
}

function renderBriefing(b) {
  const out = [];
  out.push(
    el(
      "h2",
      { class: "section-title" },
      el("span", { class: "p", text: `briefing · ${b.topic_id} · ` }),
      `${b.narratives.length} narrative(s) · ${b.total_items} item(s) · ${b.total_claims} claim(s) · generated ${
        fmtTime(b.generated_at)
      }`,
    ),
  );

  out.push(renderCoverage(b.coverage));

  const overview = el("section", { class: "card overview" });
  overview.append(
    el("h2", { class: "section-title", text: "Overview — description only, never a verdict" }),
  );
  overview.append(
    b.overview ? el("p", { text: b.overview }) : el("p", {
      class: "placeholder",
      text:
        "(no synthesis prose — set ANTHROPIC_API_KEY to generate it; the structure below is complete)",
    }),
  );
  out.push(overview);

  out.push(
    el("h2", {
      class: "section-title",
      text: "Narratives — ranked by velocity (rate of change), not volume",
    }),
  );
  if (b.narratives.length === 0) {
    out.push(
      el("p", {
        class: "empty",
        text: "No strong matches for this topic — nothing cleared the similarity floor, or " +
          "ingest/gather need to run first.",
      }),
    );
  }
  b.narratives.forEach((n, i) => out.push(renderNarrative(n, i, b.provenance)));
  return out;
}

// ── actions ────────────────────────────────────────────────────────────────

function requestBody() {
  const topicId = $("#topic-select").value;
  const keywords = $("#keywords").value;
  const k = Number($("#k").value) || 200;
  const minSimilarity = $("#min-similarity").value;
  const since = $("#since").value;
  const until = $("#until").value;
  const base = topicId ? { topicId, k } : { keywords, k };
  if (minSimilarity !== "") base.minSimilarity = Number(minSimilarity);
  if (since) base.since = since;
  if (until) base.until = until;
  return base;
}

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `${res.status} ${res.statusText}`);
  return json;
}

function setBusy(msg) {
  const busy = Boolean(msg);
  $("#gather-btn").disabled = busy;
  $("#brief-btn").disabled = busy;
  const span = $("#busy");
  span.hidden = !busy;
  span.textContent = msg || "";
}

function showError(err) {
  const box = $("#error");
  box.hidden = false;
  box.textContent = err instanceof Error ? err.message : String(err);
}

function clearOutput() {
  $("#error").hidden = true;
  $("#results").replaceChildren();
}

async function runGather() {
  clearOutput();
  setBusy("gathering Reddit + GDELT + RSS into the corpus…");
  try {
    const { coverage } = await post("api/gather", requestBody());
    $("#results").replaceChildren(
      el("h2", {
        class: "section-title",
        text: "Gather complete — corpus updated. Now generate a briefing.",
      }),
      renderCoverage(coverage),
    );
  } catch (err) {
    showError(err);
  } finally {
    setBusy(null);
  }
}

async function runBrief() {
  clearOutput();
  setBusy("clustering, labeling, extracting claims — the Haiku batch step can take a while…");
  try {
    const briefing = await post("api/brief", requestBody());
    $("#results").replaceChildren(...renderBriefing(briefing));
  } catch (err) {
    showError(err);
  } finally {
    setBusy(null);
  }
}

// ── boot ───────────────────────────────────────────────────────────────────

initTheme();
loadStatus();
loadTopics();
$("#gather-btn").addEventListener("click", runGather);
$("#brief-btn").addEventListener("click", runBrief);
$("#keywords").addEventListener("keydown", (e) => {
  if (e.key === "Enter") runBrief();
});
