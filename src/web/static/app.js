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

// Parses via Date rather than slicing/replacing on an assumed fixed ISO
// shape — a string that isn't perfectly formatted (e.g. one containing an
// early literal "T") used to silently mangle into the wrong text instead of
// failing loudly, which matters here since these are provenance timestamps
// a reader may be verifying a claim against.
function fmtTime(iso) {
  if (!iso) return "?";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "?";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
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

/**
 * The always-on Bluesky ingest service makes one connection attempt per
 * process lifetime and never retries (CLAUDE.md: it's a small, shrinking
 * source — not worth reconnect/backoff engineering) — "stopped" just means
 * it isn't running right now, not that anything is actively wrong.
 */
function blueskyChip(ingest) {
  switch (ingest.state) {
    case "connected":
      return chip(
        "on",
        `bluesky: live (${ingest.topicsWatched} topic${ingest.topicsWatched === 1 ? "" : "s"})`,
      );
    case "connecting":
      return chip("warn", "bluesky: connecting…");
    case "idle":
      return chip("warn", "bluesky: idle (no topics)");
    case "stopped":
      return chip("off", "bluesky: stopped (restart to reconnect)");
    default:
      return chip("off", "bluesky: disabled (no DATABASE_URL)");
  }
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
      blueskyChip(s.bluesky_ingest),
      chip("off", "blind: " + s.declared_blind_spots.map((b) => b.source).join(", ")),
    );
  } catch { /* status is cosmetic; the actions surface real errors */ }
}

// A saved topic already carries its own keywords/entities/description/exclude
// (edited in the topic manager); the ad hoc Keywords field is ignored
// server-side once a topicId is sent (see requestBody()), so hide it rather
// than show an input whose value silently does nothing.
function updateKeywordsVisibility() {
  $("#keywords-field").hidden = Boolean($("#topic-select").value);
}

/** (Re)populate the saved-topic dropdown. Pass an id to select afterward (falls back to ad hoc). */
async function loadTopics(selectId) {
  const select = $("#topic-select");
  const prior = selectId !== undefined ? selectId : select.value;
  select.replaceChildren(el("option", { value: "", text: "— ad hoc —" }));
  try {
    const topics = await (await fetch("api/topics")).json();
    for (const t of topics) select.append(el("option", { value: t.id, text: t.id }));
  } catch { /* no saved topics is fine */ }
  select.value = [...select.options].some((o) => o.value === prior) ? prior : "";
  // select.options[0] is the always-present "— ad hoc —" placeholder, so
  // length 1 means zero real saved topics.
  $("#topic-select-hint").hidden = select.options.length > 1;
  updateKeywordsVisibility();
  loadBriefingsLibrary(select.value);
}

// ── renderers (coverage first, always — P1) ────────────────────────────────

// A slim collapsible pill row — what this run could and couldn't see, at a
// glance — that expands into the fuller per-gap breakdown and blind-spot
// signal text rather than always showing all of it up front.
function renderCoverage(c) {
  const details = el("details", { class: "coverage" });
  const row = el("div", { class: "coverage-row" });

  const queried = c.sources_queried || [];
  if (queried.length === 0) {
    row.append(el("span", { class: "empty", text: "no sources queried" }));
  }
  for (const s of queried) {
    row.append(
      el(
        "span",
        { class: "cov-pill ok" },
        el("span", { class: "dot" }),
        `${s} ${c.items_per_source[s] ?? 0}`,
      ),
    );
  }
  for (const u of c.sources_unavailable || []) {
    row.append(
      el(
        "span",
        { class: "cov-pill gap" },
        el("span", { class: "dot" }),
        u.source,
      ),
    );
  }
  if (c.excluded && c.excluded.count > 0) {
    row.append(
      el(
        "span",
        { class: "cov-pill warn", title: "dropped by this topic's exclude list before scoring" },
        el("span", { class: "dot" }),
        `${c.excluded.count} excluded`,
      ),
    );
  }
  row.append(el("span", { class: "coverage-toggle", text: "coverage details" }));
  details.append(el("summary", {}, row));

  const detail = el("div", { class: "coverage-detail" });
  detail.append(el("p", {
    class: "meta",
    text: `topic "${c.topic_id}" · run ${fmtTime(c.run_at)} · window ${fmtTime(c.window[0])} → ${
      fmtTime(c.window[1])
    }`,
  }));
  for (const u of c.sources_unavailable || []) {
    detail.append(
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
      detail.append(el("div", {
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
    detail.append(el("p", {
      class: "signal-note",
      text: "references = attention, not content; links can be gamed — treat as a lead.",
    }));
  }
  // A topic's own exclude list is a self-inflicted coverage gap (P1): show
  // what it actually dropped, not just a count, so over-excluding is
  // something you can catch by looking, not something you have to trust.
  if (c.excluded && c.excluded.count > 0) {
    const block = el("div", { class: "excluded-block" });
    block.append(el("p", {
      class: "heading",
      text: `Excluded by your topic's exclude list: ${c.excluded.count} item(s)` +
        (c.excluded.sample.length < c.excluded.count
          ? ` (showing ${c.excluded.sample.length})`
          : ""),
    }));
    for (const s of c.excluded.sample) {
      block.append(
        el(
          "div",
          { class: "excluded-sample" },
          el("span", { class: "term", text: `"${s.matched_term}"` }),
          el("span", { class: "text", text: `[${s.source}] ${s.text}` }),
        ),
      );
    }
    detail.append(block);
  }
  details.append(detail);
  return details;
}

// ── velocity/relevance buckets ──────────────────────────────────────────────
// Thresholds used to be hardcoded here — "an initial heuristic, not tuned
// against a real distribution, revisit once there's real usage data." That
// revisiting mechanism now exists (src/briefing/thresholds.ts + the Tuning
// card below): thresholds live server-side and are fetched once at boot
// (loadTuningThresholds), with these values as the fallback before that
// fetch resolves (and if it never does — e.g. no DATABASE_URL) so buckets
// never silently break. Velocity is a magnitude (items/hour over a fixed
// recent window), not a measured trend, so the labels describe how much is
// happening, not whether it's accelerating or decelerating.
let bucketThresholds = { hot: 3, active: 0.5, strong: 0.65, plausible: 0.5 };

function velocityBucket(v) {
  if (v >= bucketThresholds.hot) return { label: "hot", cls: "hot" };
  if (v >= bucketThresholds.active) return { label: "active", cls: "active" };
  return { label: "quiet", cls: "quiet" };
}

function relevanceBucket(r) {
  if (r >= bucketThresholds.strong) return { label: "strong match", cls: "strong" };
  if (r >= bucketThresholds.plausible) return { label: "plausible match", cls: "plausible" };
  return { label: "weak match", cls: "weak" };
}

// Definitions for the P4 evidence-type tags — legible to whoever wrote the
// extraction prompt (src/llm/anthropic.ts), not necessarily to a first-time
// reader of a briefing.
const EVIDENCE_TYPE_DEFINITIONS = {
  primary_record: "A document, filing, or official record being described directly — not " +
    "someone's account of one.",
  reported: "Reported by a journalist or outlet, attributed to a source.",
  opinion: "A stated opinion or interpretation, not an assertion of fact.",
  unsourced: "An assertion with no clear origin given — treat with the most caution.",
};

/** An evidence-type badge that doubles as a tap-to-define info-chip (same mechanism as
 *  the topic manager's field descriptions). */
function evidenceBadge(evidenceType) {
  return el(
    "span",
    { class: "info-chip-wrap" },
    el("button", {
      type: "button",
      class: `badge info-chip ${evidenceType}`,
      "aria-expanded": "false",
      "aria-label": "What does this evidence type mean?",
      text: evidenceType.replace("_", " "),
    }),
    el("span", {
      class: "info-popover",
      role: "tooltip",
      hidden: "",
      text: EVIDENCE_TYPE_DEFINITIONS[evidenceType] ?? "",
    }),
  );
}

function provenanceLine(e) {
  const line = el(
    "p",
    { class: "provenance" },
    el("span", {
      class: `src-tag ${e.source}`,
      text: e.source ? e.source[0].toUpperCase() : "?",
    }),
    `${e.source} · ${e.author ?? "(unknown)"} · ${fmtTime(e.created_at)} · `,
  );
  line.append(safeLink(e.url, "open ↗"));
  return line;
}

// Each narrative is a collapsible card: the head (rank/title/pills) is the
// always-visible <summary>, evidence+claims are the collapsible body. Only
// the first narrative opens by default — a run with a dozen-plus narratives
// still opens as a short, scannable list of headlines instead of everything
// unrolled at once.
// ── quick-exclude: a one-click escape hatch from inside a narrative you
//    immediately recognize as off-topic, without leaving the briefing to open
//    the topic manager. Saves directly (PUT), unlike the AI-suggested
//    excludes (suggestExcludesFromNoise) — this is the user's own explicit
//    judgment call on a specific narrative in front of them, not a guess
//    needing review. The term is editable before confirming since a
//    narrative's LLM-generated label is often too long or too specific to be
//    a good substring match against raw post text (isExcluded in
//    src/ingestion/topic.ts matches literal substrings). ───────────────────

function quickExcludeControl(narrative, topicId) {
  const wrap = el("div", { class: "quick-exclude" });
  const btn = el("button", {
    type: "button",
    class: "quick-exclude-btn",
    text: "Not relevant? Quick-exclude",
  });
  const status = el("span", { class: "tm-status" });
  wrap.append(btn, status);

  btn.addEventListener("click", () => {
    if (wrap.querySelector(".quick-exclude-form")) return;
    btn.hidden = true;
    const form = el("div", { class: "quick-exclude-form" });
    const input = el("input", { type: "text", value: narrative.label || "" });
    const confirmBtn = el("button", { type: "button", class: "primary", text: "Add to exclude" });
    const cancelBtn = el("button", { type: "button", text: "Cancel" });
    form.append(input, confirmBtn, cancelBtn);
    wrap.append(form);
    input.focus();
    input.select();

    const closeForm = () => {
      form.remove();
      btn.hidden = false;
    };
    cancelBtn.addEventListener("click", closeForm);

    confirmBtn.addEventListener("click", async () => {
      const term = input.value.trim();
      if (!term) return;
      confirmBtn.disabled = true;
      try {
        const topic = await get(`api/topics/${encodeURIComponent(topicId)}`);
        const existing = topic.exclude || [];
        if (!existing.some((e) => e.toLowerCase() === term.toLowerCase())) {
          await put(`api/topics/${encodeURIComponent(topicId)}`, {
            exclude: [...existing, term].join(", "),
          });
        }
        closeForm();
        setStatus(status, `excluded "${term}" — rerun the briefing to apply it`, true);
        // Keep the topic manager's exclude field in sync if it's open on this topic right now.
        if ($("#topic-select").value === topicId) {
          $("#tm-edit-exclude").value = [...existing, term].join(", ");
        }
      } catch (err) {
        confirmBtn.disabled = false;
        setStatus(status, err.message, false);
      }
    });
  });
  return wrap;
}

function renderNarrative(n, i, provenance, savedTopicId) {
  const details = el("details", { class: "narrative", id: `narrative-${n.cluster_id}` });
  if (i === 0) details.open = true;

  const vb = velocityBucket(n.velocity);
  const rb = relevanceBucket(n.relevance);
  const head = el(
    "summary",
    { class: "narrative-head" },
    el("span", { class: "rank mono", text: String(i + 1).padStart(2, "0") }),
    el(
      "span",
      { class: "title-block" },
      el("h3", {
        class: n.label ? "label" : "label unlabeled",
        text: n.label || "(unlabeled — set ANTHROPIC_API_KEY for labels)",
      }),
      el("span", {
        class: "sub",
        text: `${n.size} item(s) · first seen ${fmtTime(n.first_seen)}`,
      }),
    ),
    el(
      "span",
      { class: "pills" },
      el(
        "span",
        {
          class: `pill ${vb.cls}`,
          title: `${n.velocity.toFixed(2)} items/h`,
        },
        el("span", { class: "dot" }),
        vb.label,
      ),
      el(
        "span",
        {
          class: `pill ${rb.cls}`,
          title: `relevance score ${n.relevance.toFixed(2)}`,
        },
        el("span", { class: "dot" }),
        rb.label,
      ),
    ),
    el("span", { class: "chev", text: "›" }),
  );
  details.append(head);

  const body = el("div", { class: "narrative-body" });
  const inner = el("div", { class: "narrative-body-inner" });

  if (savedTopicId) inner.append(quickExcludeControl(n, savedTopicId));

  if (n.representative_item_ids.length) {
    inner.append(el("div", { class: "evidence-label", text: "Representative posts" }));
    for (const id of n.representative_item_ids) {
      const e = provenance[id];
      if (!e) continue;
      inner.append(
        el(
          "div",
          { class: "exemplar" },
          el("p", { class: "excerpt", text: e.excerpt }),
          provenanceLine(e),
        ),
      );
    }
  }

  if (n.claims.length) {
    inner.append(
      el("div", { class: "evidence-label claims-label", text: "Claims — tagged by evidence type" }),
    );
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
          evidenceBadge(c.evidence_type),
          el("span", { class: "text", text: c.text }),
          el("span", {
            class: "meta",
            text: `${c.supporting_item_ids.length} src` +
              (c.verify_hint ? ` · verify: ${c.verify_hint}` : ""),
          }),
          links,
        ),
      );
    }
    inner.append(claims);
  }
  body.append(inner);
  details.append(body);
  return details;
}

function renderBriefing(b, savedTopicId) {
  const out = [];

  // Case header: headline, generated-at meta, at-a-glance stat tiles, and
  // (folded in below the tiles) the coverage strip — what this run could and
  // couldn't see is context for those numbers, not a separate topic.
  const caseHead = el("section", { class: "case-head" });
  caseHead.append(el("p", { class: "eyebrow", text: "Briefing" }));
  caseHead.append(el("h2", { class: "serif", text: b.topic_id }));
  caseHead.append(el("p", { class: "meta mono", text: `generated ${fmtTime(b.generated_at)}` }));
  const stats = el("div", { class: "stat-row" });
  for (
    const [n, l] of [
      [b.narratives.length, "narrative(s)"],
      [b.total_items, "item(s)"],
      [b.total_claims, "claim(s)"],
    ]
  ) {
    stats.append(
      el(
        "div",
        { class: "stat" },
        el("div", { class: "n mono", text: String(n) }),
        el("div", { class: "l", text: l }),
      ),
    );
  }
  caseHead.append(stats);
  caseHead.append(renderCoverage(b.coverage));
  out.push(caseHead);

  out.push(
    el(
      "div",
      { class: "section-head" },
      el("h3", { text: "What's happening" }),
      el("span", { class: "cap", text: "— description only, never a verdict" }),
    ),
  );
  const overview = el("section", { class: "card overview" });
  overview.append(
    b.overview ? el("p", { text: b.overview }) : el("p", {
      class: "placeholder",
      text:
        "(no synthesis prose — set ANTHROPIC_API_KEY to generate it; the structure below is complete)",
    }),
  );
  out.push(overview);

  // Background (Track B): general context for the topic's subject matter,
  // independent of this run's narratives — kept structurally separate from
  // claims, which are pulled from the discourse and may be wrong.
  if (b.background_facts.length) {
    out.push(
      el(
        "div",
        { class: "section-head" },
        el("h3", { text: "Background" }),
        el("span", { class: "cap", text: "— general context, not specific to this run" }),
      ),
    );
    const background = el("section", { class: "card background" });
    for (const f of b.background_facts) {
      const item = el("div", { class: "background-fact" });
      item.append(el("p", { class: "text", text: f.text }));
      const meta = el("p", { class: "meta" }, `${f.source_name} · as of ${fmtTime(f.as_of)} · `);
      meta.append(safeLink(f.source_url, "source ↗"));
      item.append(meta);
      background.append(item);
    }
    out.push(background);
  }

  out.push(
    el(
      "div",
      { class: "section-head" },
      el("h3", { text: "Narratives" }),
      el("span", {
        class: "cap",
        text: "— ranked by velocity (rate of change), not raw volume",
      }),
    ),
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
  b.narratives.forEach((n, i) => out.push(renderNarrative(n, i, b.provenance, savedTopicId)));
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

async function request(method, path, body) {
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { "content-type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${res.status} ${res.statusText}`);
  return json;
}
const post = (path, body) => request("POST", path, body);
const put = (path, body) => request("PUT", path, body);
const del = (path) => request("DELETE", path);
const get = (path) => request("GET", path);

function setBusy(msg) {
  const busy = Boolean(msg);
  $("#update-btn").disabled = busy;
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

// #results has tabindex="-1" (not otherwise focusable, but a valid
// programmatic focus target) so a screen-reader user isn't left in total
// silence after a run — the standard "route change" focus-management
// pattern in place of a giant aria-live region trying to announce an
// entire briefing's worth of new content at once.
function focusResults() {
  $("#results").focus();
}

async function runUpdate() {
  clearOutput();
  const body = requestBody();
  try {
    setBusy("gathering Reddit + GDELT + RSS into the corpus…");
    await post("api/gather", body);
    setBusy("clustering, labeling, extracting claims — the Haiku batch step can take a while…");
    const briefing = await post("api/brief", body);
    $("#results").replaceChildren(...renderBriefing(briefing, $("#topic-select").value || null));
    focusResults();
    await loadBriefingsLibrary($("#topic-select").value);
    await loadHomeView();
  } catch (err) {
    showError(err);
  } finally {
    setBusy(null);
  }
}

// Cost-conscious escape hatch from the merged "Update briefing" action above:
// refreshes the corpus without ever reaching the paid Haiku/Sonnet step, so a
// user can poll sources on their own schedule and only pay for analysis when
// they actually want a briefing.
async function runGatherOnly() {
  const btn = $("#gather-only-btn");
  const status = $("#gather-only-status");
  const body = requestBody();
  btn.disabled = true;
  $("#update-btn").disabled = true;
  setStatus(status, "gathering…");
  try {
    const { coverage } = await post("api/gather", body);
    const total = Object.values(coverage.items_per_source).reduce((a, b) => a + b, 0);
    setStatus(
      status,
      `gathered ${total} item(s) across ${coverage.sources_queried.length} source(s)`,
      true,
    );
  } catch (err) {
    setStatus(status, err.message, false);
  } finally {
    btn.disabled = false;
    $("#update-btn").disabled = false;
  }
}

// ── briefings library (Track A #5) — past briefings for a saved topic. Scoped
//    to saved topics only: their id is always the slug saveTopic() persisted,
//    matching briefing.topic_id exactly; an ad hoc topic's id is built from
//    free-text keywords and isn't a stable return point the way a saved
//    topic is. ─────────────────────────────────────────────────────────────

function briefingLibraryItem(b, onView) {
  const vb = b.top_velocity !== null ? velocityBucket(b.top_velocity) : null;
  const summary = `${b.narrative_count} narrative(s) · ${b.total_items} item(s) · ` +
    `${b.total_claims} claim(s)` +
    (vb ? ` · top: ${vb.label}${b.top_label ? ` (${b.top_label})` : ""}` : "");
  const btn = el(
    "button",
    { type: "button", class: "briefing-link" },
    el("span", { class: "briefing-time", text: fmtTime(b.generated_at) }),
    el("span", { class: "briefing-summary-text", text: summary }),
  );
  btn.addEventListener("click", () => onView(b.id));
  return el("li", {}, btn);
}

async function loadBriefingsLibrary(topicId) {
  const section = $("#briefings-library");
  if (!topicId) {
    section.hidden = true;
    return;
  }
  try {
    const list = await (await fetch(`api/topics/${encodeURIComponent(topicId)}/briefings`)).json();
    if (!isCurrentEditTopic(topicId)) return; // user switched topics while this was in flight
    if (!Array.isArray(list) || list.length === 0) {
      section.hidden = true;
      return;
    }
    $("#briefings-library-list").replaceChildren(
      ...list.map((b) => briefingLibraryItem(b, viewStoredBriefing)),
    );
    section.hidden = false;
  } catch {
    if (!isCurrentEditTopic(topicId)) return;
    section.hidden = true;
  }
}

async function viewStoredBriefing(id) {
  clearOutput();
  setBusy("loading saved briefing…");
  try {
    const briefing = await get(`api/briefings/${encodeURIComponent(id)}`);
    // The briefings library is scoped to saved topics only (see the section
    // comment above), so briefing.topic_id is always a real saved topic id.
    $("#results").replaceChildren(...renderBriefing(briefing, briefing.topic_id));
    focusResults();
  } catch (err) {
    showError(err);
  } finally {
    setBusy(null);
  }
}

// ── home view (Track A #6): a velocity-ranked snapshot across every saved
//    topic's latest briefing — the thing that puts a rising topic in front
//    of you without first having to think to open it. ──────────────────────

function homeViewItem(entry, onView) {
  const vb = entry.top_velocity !== null ? velocityBucket(entry.top_velocity) : null;
  const summary = vb
    ? `${vb.label}${entry.top_label ? ` — ${entry.top_label}` : ""}`
    : "no narratives in the latest run";
  const btn = el(
    "button",
    { type: "button", class: `home-view-link ${vb ? vb.cls : ""}` },
    el("span", { class: "home-view-topic", text: entry.topic_id }),
    el("span", { class: "home-view-summary", text: summary }),
    el("span", { class: "home-view-time", text: fmtTime(entry.generated_at) }),
  );
  btn.addEventListener("click", () => onView(entry));
  return el("li", {}, btn);
}

async function selectHomeViewEntry(entry) {
  const select = $("#topic-select");
  if ([...select.options].some((o) => o.value === entry.topic_id)) {
    select.value = entry.topic_id;
    loadTopicForEdit(entry.topic_id);
    updateKeywordsVisibility();
    loadBriefingsLibrary(entry.topic_id);
  }
  await viewStoredBriefing(entry.id);
}

async function loadHomeView() {
  const section = $("#home-view");
  try {
    const entries = await (await fetch("api/briefings/latest")).json();
    if (!Array.isArray(entries) || entries.length === 0) {
      section.hidden = true;
      return;
    }
    // Nulls (an empty briefing with no narratives) sort last, not first.
    const ranked = [...entries].sort((a, b) => (b.top_velocity ?? -1) - (a.top_velocity ?? -1));
    $("#home-view-list").replaceChildren(
      ...ranked.map((e) => homeViewItem(e, selectHomeViewEntry)),
    );
    section.hidden = false;
  } catch {
    section.hidden = true;
  }
}

// ── topic manager (create/edit topics, add/remove + verify RSS feeds) ──────

let newTopicFeeds = [];

function feedListItem(url, onRemove) {
  const li = el("li", {}, el("span", { class: "feed-url", text: url }));
  if (onRemove) {
    const btn = el("button", { type: "button", text: "×", title: `remove ${url}` });
    btn.addEventListener("click", () => onRemove(url));
    li.append(btn);
  }
  return li;
}

function renderFeedList(ul, feeds, onRemove) {
  if (!feeds || feeds.length === 0) {
    ul.replaceChildren(el("li", { class: "empty", text: "no feeds configured" }));
    return;
  }
  ul.replaceChildren(...feeds.map((f) => feedListItem(f, onRemove)));
}

/** Render a feed-validation result: title + entry count + preview, or the failure reason. */
function renderFeedCheck(container, result) {
  if (!result) {
    container.replaceChildren();
    return;
  }
  const box = el("div", { class: `feed-check ${result.ok ? "ok" : "bad"}` });
  if (result.ok) {
    const n = result.entryCount;
    box.append(
      el("div", {
        class: "fc-title",
        text: `✓ ${result.title} — ${n} entr${n === 1 ? "y" : "ies"}`,
      }),
    );
    if (result.preview?.length) {
      const list = el("ul", { class: "fc-preview" });
      for (const p of result.preview) {
        list.append(
          el("li", { text: p.title + (p.published ? ` (${fmtTime(p.published)})` : "") }),
        );
      }
      box.append(list);
    }
  } else {
    box.append(el("div", { class: "fc-title", text: `✗ ${result.reason}` }));
  }
  container.replaceChildren(box);
}

function setStatus(node, msg, ok) {
  node.textContent = msg;
  node.className = `tm-status${ok === undefined ? "" : ok ? " ok" : " bad"}`;
}

function switchTab(tab) {
  for (const btn of document.querySelectorAll(".tm-tab")) {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  }
  $("#tm-edit").hidden = tab !== "edit";
  $("#tm-new").hidden = tab !== "new";
}

// -- "new topic" panel: feeds are staged client-side, validated as added,
//    and only sent to the server once "Create topic" is submitted. --

function renderNewFeedList() {
  renderFeedList($("#tm-new-feed-list"), newTopicFeeds, (url) => {
    newTopicFeeds = newTopicFeeds.filter((f) => f !== url);
    renderNewFeedList();
  });
}

async function addNewTopicFeed() {
  const input = $("#tm-new-feed-url");
  const url = input.value.trim();
  if (!url) return;
  const result = await post("api/feeds/validate", { url }).catch((err) => ({
    ok: false,
    reason: err.message,
  }));
  renderFeedCheck($("#tm-new-feed-result"), result);
  if (result.ok && !newTopicFeeds.includes(url)) {
    newTopicFeeds.push(url);
    renderNewFeedList();
    input.value = "";
  }
}

async function createNewTopic() {
  const status = $("#tm-new-status");
  const id = $("#tm-new-id").value.trim();
  if (!id) {
    setStatus(status, "a topic name is required", false);
    return;
  }
  try {
    const created = await post("api/topics", {
      id,
      keywords: $("#tm-new-keywords").value,
      entities: $("#tm-new-entities").value,
      description: $("#tm-new-description").value,
      exclude: $("#tm-new-exclude").value,
      feeds: newTopicFeeds,
    });
    setStatus(status, `created "${created.id}"`, true);
    for (
      const fieldId of [
        "tm-new-id",
        "tm-new-keywords",
        "tm-new-entities",
        "tm-new-description",
        "tm-new-exclude",
      ]
    ) {
      $(`#${fieldId}`).value = "";
    }
    newTopicFeeds = [];
    renderNewFeedList();
    renderFeedCheck($("#tm-new-feed-result"), null);
    $("#tm-new-suggest-result").replaceChildren();
    setStatus($("#tm-new-suggest-status"), "");
    await loadTopics(created.id);
    await loadTopicForEdit(created.id);
    switchTab("edit");
  } catch (err) {
    setStatus(status, err.message, false);
  }
}

// -- "edit topic" panel: reads/writes the topic currently selected in the
//    main controls' dropdown; feed add/remove persist immediately. --

// #topic-select is the single source of truth for "which topic is being
// edited right now." The loaders below are async and fire on every topic
// switch; without this check, a slow response for a topic the user has
// since navigated away from can land after a faster one and overwrite it
// with stale data.
function isCurrentEditTopic(id) {
  return $("#topic-select").value === id;
}

async function loadTopicForEdit(id) {
  const hint = $("#tm-edit-hint");
  const form = $("#tm-edit-form");
  if (!id) {
    form.hidden = true;
    hint.hidden = false;
    hint.textContent = "Select a saved topic above to edit it.";
    return;
  }
  try {
    const topic = await (await fetch(`api/topics/${encodeURIComponent(id)}`)).json();
    if (!isCurrentEditTopic(id)) return;
    $("#tm-edit-keywords").value = topic.keywords.join(", ");
    $("#tm-edit-entities").value = topic.entities.join(", ");
    $("#tm-edit-description").value = topic.description;
    $("#tm-edit-exclude").value = topic.exclude.join(", ");
    renderFeedList($("#tm-edit-feed-list"), topic.feeds, (url) => removeEditFeed(id, url));
    renderFeedCheck($("#tm-edit-feed-result"), null);
    setStatus($("#tm-edit-status"), "");
    hint.hidden = true;
    form.hidden = false;
    $("#tm-edit-fact-drafts").replaceChildren();
    setStatus($("#tm-edit-fact-draft-status"), "");
    $("#tm-edit-suggest-result").replaceChildren();
    setStatus($("#tm-edit-suggest-status"), "");
    $("#tm-edit-exclude-suggestions").replaceChildren();
    setStatus($("#tm-edit-exclude-suggest-status"), "");
    loadTopicTags(id);
    loadTopicFacts(id);
  } catch {
    if (!isCurrentEditTopic(id)) return;
    form.hidden = true;
    hint.hidden = false;
    hint.textContent = `Could not load "${id}".`;
  }
}

async function saveEditedTopic() {
  const id = $("#topic-select").value;
  if (!id) return;
  const status = $("#tm-edit-status");
  try {
    await put(`api/topics/${encodeURIComponent(id)}`, {
      keywords: $("#tm-edit-keywords").value,
      entities: $("#tm-edit-entities").value,
      description: $("#tm-edit-description").value,
      exclude: $("#tm-edit-exclude").value,
    });
    setStatus(status, "saved", true);
  } catch (err) {
    setStatus(status, err.message, false);
  }
}

async function deleteEditedTopic() {
  const id = $("#topic-select").value;
  if (!id) return;
  if (!confirm(`Delete topic "${id}"? This cannot be undone.`)) return;
  try {
    await del(`api/topics/${encodeURIComponent(id)}`);
    await loadTopics("");
    await loadTopicForEdit("");
  } catch (err) {
    setStatus($("#tm-edit-status"), err.message, false);
  }
}

async function addEditFeed() {
  const id = $("#topic-select").value;
  if (!id) return;
  const input = $("#tm-edit-feed-url");
  const url = input.value.trim();
  if (!url) return;
  const result = await post(`api/topics/${encodeURIComponent(id)}/feeds`, { url }).catch((err) => ({
    ok: false,
    reason: err.message,
  }));
  renderFeedCheck($("#tm-edit-feed-result"), result);
  if (result.ok) {
    renderFeedList($("#tm-edit-feed-list"), result.topic.feeds, (u) => removeEditFeed(id, u));
    input.value = "";
  }
}

async function removeEditFeed(id, url) {
  try {
    const topic = await del(
      `api/topics/${encodeURIComponent(id)}/feeds?url=${encodeURIComponent(url)}`,
    );
    renderFeedList($("#tm-edit-feed-list"), topic.feeds, (u) => removeEditFeed(id, u));
  } catch (err) {
    setStatus($("#tm-edit-status"), err.message, false);
  }
}

// ── Track B: tags + background facts (topic manager) ───────────────────────
// Postgres-backed (DATABASE_URL) like gather/brief — a fetch failure here
// (most commonly "no DATABASE_URL configured") degrades to an inline notice
// rather than breaking the rest of the topic manager.

function removableListItem(label, title, onRemove) {
  const li = el("li", {}, el("span", { class: "feed-url", text: label }));
  if (onRemove) {
    const btn = el("button", { type: "button", text: "×", title });
    btn.addEventListener("click", onRemove);
    li.append(btn);
  }
  return li;
}

function renderTagListUI(ul, tags, onRemove) {
  if (!tags || tags.length === 0) {
    ul.replaceChildren(el("li", { class: "empty", text: "no tags attached" }));
    return;
  }
  ul.replaceChildren(
    ...tags.map((t) => removableListItem(t.name, `remove tag ${t.name}`, () => onRemove(t.id))),
  );
}

// One "fact card" <li>: text + meta line + action buttons — the shared shape
// for attached facts, tag-based suggestions, and auto-drafted candidates.
// `buttons` is [{ label, title?, onClick }, ...].
function factCard(text, meta, buttons = []) {
  const li = el(
    "li",
    { class: "fact-item" },
    el(
      "div",
      { class: "fact-item-body" },
      el("p", { class: "fact-text", text }),
      el("p", { class: "fact-meta", text: meta }),
    ),
  );
  for (const { label, title, onClick } of buttons) {
    const btn = el("button", { type: "button", text: label, title });
    btn.addEventListener("click", onClick);
    li.append(btn);
  }
  return li;
}

function factListItem(fact, onRemove) {
  const meta = `${fact.source_name} · as of ${fact.as_of.slice(0, 10)}`;
  const buttons = onRemove ? [{ label: "×", title: "detach this fact", onClick: onRemove }] : [];
  return factCard(fact.text, meta, buttons);
}

function renderFactListUI(ul, facts, onRemove) {
  if (!facts || facts.length === 0) {
    ul.replaceChildren(el("li", { class: "empty", text: "no background facts attached" }));
    return;
  }
  ul.replaceChildren(...facts.map((f) => factListItem(f, () => onRemove(f.id))));
}

/** Populate the "attach existing tag" <select> from the full tag vocabulary. */
async function loadAllTags() {
  const select = $("#tm-edit-tag-select");
  const prior = select.value;
  select.replaceChildren(el("option", { value: "", text: "— choose a tag —" }));
  try {
    const tags = await (await fetch("api/tags")).json();
    for (const t of tags) select.append(el("option", { value: t.id, text: t.name }));
  } catch { /* Postgres not configured — the select just stays empty */ }
  select.value = [...select.options].some((o) => o.value === prior) ? prior : "";
}

async function loadTopicTags(id) {
  const ul = $("#tm-edit-tag-list");
  try {
    const tags = await (await fetch(`api/topics/${encodeURIComponent(id)}/tags`)).json();
    if (!isCurrentEditTopic(id)) return;
    renderTagListUI(ul, tags, (tagId) => removeEditTag(id, tagId));
  } catch {
    if (!isCurrentEditTopic(id)) return;
    ul.replaceChildren(el("li", { class: "empty", text: "tags unavailable — set DATABASE_URL" }));
  }
  await loadAllTags();
}

async function attachExistingTag() {
  const id = $("#topic-select").value;
  const select = $("#tm-edit-tag-select");
  const tagId = select.value;
  if (!id || !tagId) return;
  try {
    await post(`api/topics/${encodeURIComponent(id)}/tags`, { tagId });
    select.value = "";
    await loadTopicTags(id);
  } catch (err) {
    setStatus($("#tm-edit-status"), err.message, false);
  }
}

async function createAndAttachTag() {
  const id = $("#topic-select").value;
  if (!id) return;
  const nameInput = $("#tm-edit-new-tag-name");
  const descInput = $("#tm-edit-new-tag-description");
  const name = nameInput.value.trim();
  if (!name) return;
  try {
    await post(`api/topics/${encodeURIComponent(id)}/tags`, {
      name,
      description: descInput.value.trim() || undefined,
    });
    nameInput.value = "";
    descInput.value = "";
    await loadTopicTags(id);
  } catch (err) {
    setStatus($("#tm-edit-status"), err.message, false);
  }
}

async function removeEditTag(id, tagId) {
  try {
    await del(`api/topics/${encodeURIComponent(id)}/tags?tagId=${encodeURIComponent(tagId)}`);
    await loadTopicTags(id);
  } catch (err) {
    setStatus($("#tm-edit-status"), err.message, false);
  }
}

async function loadTopicFacts(id) {
  const ul = $("#tm-edit-fact-list");
  try {
    const facts = await (await fetch(`api/topics/${encodeURIComponent(id)}/facts`)).json();
    if (!isCurrentEditTopic(id)) return;
    renderFactListUI(ul, facts, (factId) => removeEditFact(id, factId));
  } catch {
    if (!isCurrentEditTopic(id)) return;
    ul.replaceChildren(el("li", { class: "empty", text: "facts unavailable — set DATABASE_URL" }));
  }
  await loadFactSuggestions(id);
}

/** Facts sharing a tag with this topic that aren't attached yet — a one-click attach. */
async function loadFactSuggestions(id) {
  const box = $("#tm-edit-fact-suggestions");
  try {
    const suggestions = await (
      await fetch(`api/topics/${encodeURIComponent(id)}/fact-suggestions`)
    ).json();
    if (!isCurrentEditTopic(id)) return;
    if (!suggestions.length) {
      box.replaceChildren();
      return;
    }
    const list = el("ul", { class: "fact-list" });
    for (const f of suggestions) {
      list.append(factCard(
        f.text,
        `${f.source_name} · as of ${f.as_of.slice(0, 10)}`,
        [{ label: "+ attach", onClick: () => attachSuggestedFact(id, f.id) }],
      ));
    }
    box.replaceChildren(
      el("p", { class: "tm-subtitle", text: "Suggested (shares a tag with this topic)" }),
      list,
    );
  } catch {
    if (!isCurrentEditTopic(id)) return;
    box.replaceChildren();
  }
}

async function attachSuggestedFact(id, factId) {
  try {
    await post(`api/topics/${encodeURIComponent(id)}/facts`, { factId });
    await loadTopicFacts(id);
  } catch (err) {
    setStatus($("#tm-edit-status"), err.message, false);
  }
}

async function addBackgroundFact() {
  const id = $("#topic-select").value;
  if (!id) return;
  const result = $("#tm-edit-fact-result");
  const text = $("#tm-edit-fact-text").value.trim();
  const sourceName = $("#tm-edit-fact-source-name").value.trim();
  const sourceUrl = $("#tm-edit-fact-source-url").value.trim();
  const asOf = $("#tm-edit-fact-as-of").value;
  if (!text || !sourceName || !sourceUrl) {
    setStatus(result, "text, source name, and source URL are all required", false);
    return;
  }
  try {
    await post(`api/topics/${encodeURIComponent(id)}/facts`, {
      text,
      source_name: sourceName,
      source_url: sourceUrl,
      as_of: asOf || undefined,
    });
    for (
      const fieldId of ["tm-edit-fact-text", "tm-edit-fact-source-name", "tm-edit-fact-source-url"]
    ) {
      $(`#${fieldId}`).value = "";
    }
    $("#tm-edit-fact-as-of").value = "";
    setStatus(result, "added", true);
    await loadTopicFacts(id);
  } catch (err) {
    setStatus(result, err.message, false);
  }
}

async function removeEditFact(id, factId) {
  try {
    await del(`api/topics/${encodeURIComponent(id)}/facts?factId=${encodeURIComponent(factId)}`);
    await loadTopicFacts(id);
  } catch (err) {
    setStatus($("#tm-edit-status"), err.message, false);
  }
}

// ── Track B auto-draft: Claude + web search proposes candidate facts;
//    nothing is saved until a human approves one (draft-and-approve, never
//    auto-publish). Approval reuses the same create-fact flow the manual
//    "+ New background fact" form uses. ───────────────────────────────────

function draftFactItem(draft, onApprove, onDiscard) {
  return factCard(
    draft.text,
    `${draft.source_name} · as of ${draft.as_of} · ${draft.source_url}`,
    [
      { label: "Approve & attach", onClick: onApprove },
      { label: "Discard", onClick: onDiscard },
    ],
  );
}

async function draftBackgroundFacts() {
  const id = $("#topic-select").value;
  if (!id) return;
  const status = $("#tm-edit-fact-draft-status");
  const list = $("#tm-edit-fact-drafts");
  setStatus(status, "researching…");
  try {
    const drafts = await post(`api/topics/${encodeURIComponent(id)}/facts/draft`, {});
    if (!drafts.length) {
      setStatus(status, "no verifiable facts found", false);
      list.replaceChildren();
      return;
    }
    setStatus(status, `${drafts.length} candidate(s) — review before attaching`, true);
    list.replaceChildren(
      ...drafts.map((draft) => {
        const li = draftFactItem(
          draft,
          async () => {
            try {
              await post(`api/topics/${encodeURIComponent(id)}/facts`, draft);
              li.remove();
              await loadTopicFacts(id);
            } catch (err) {
              setStatus(status, err.message, false);
            }
          },
          () => li.remove(),
        );
        return li;
      }),
    );
  } catch (err) {
    setStatus(status, err.message, false);
  }
}

// ── topic-assist: LLM-drafted keyword/entity/exclude vocabulary. Like the
//    background-facts auto-draft above, this is draft-and-approve — nothing
//    is written to the topic until the user clicks an "Add to ..." button,
//    which merges into the plain text field the manual Save flow already
//    reads. Exists because a topic's keyword/entity/exclude lists are the
//    fields hardest to fill in well without already being a domain expert,
//    unlike the description, which is easy to write regardless. ───────────

function mergeIntoCommaField(selector, values) {
  const input = $(selector);
  const existing = input.value.split(",").map((s) => s.trim()).filter(Boolean);
  const seen = new Set(existing.map((s) => s.toLowerCase()));
  for (const v of values) {
    if (!seen.has(v.toLowerCase())) {
      existing.push(v);
      seen.add(v.toLowerCase());
    }
  }
  input.value = existing.join(", ");
}

function renderFieldSuggestions(container, statusEl, suggestions, targets) {
  const { keywords, entities, exclude, rationale } = suggestions;
  if (!keywords.length && !entities.length && !exclude.length) {
    setStatus(statusEl, "no suggestions found", false);
    container.replaceChildren();
    return;
  }
  setStatus(statusEl, "review before applying", true);
  const rows = [];
  for (
    const [field, values] of [["keywords", keywords], ["entities", entities], [
      "exclude",
      exclude,
    ]]
  ) {
    if (!values.length) continue;
    const btn = el("button", { type: "button", text: `Add to ${field}` });
    btn.addEventListener("click", () => {
      mergeIntoCommaField(targets[field], values);
      btn.disabled = true;
      btn.textContent = "added";
    });
    rows.push(
      el(
        "div",
        { class: "fact-item" },
        el(
          "div",
          { class: "fact-item-body" },
          el("p", { class: "fact-meta", text: `${field}: ${values.join(", ")}` }),
        ),
        btn,
      ),
    );
  }
  if (rationale) rows.push(el("p", { class: "hint", text: rationale }));
  container.replaceChildren(...rows);
}

async function suggestTopicFields(
  descriptionSelector,
  keywordsSelector,
  entitiesSelector,
  statusSelector,
  resultSelector,
  targets,
) {
  const status = $(statusSelector);
  const description = $(descriptionSelector).value.trim();
  if (!description) {
    setStatus(status, "write a description first", false);
    return;
  }
  setStatus(status, "thinking…");
  try {
    const suggestions = await post("api/topics/suggest-fields", {
      description,
      keywords: $(keywordsSelector).value,
      entities: $(entitiesSelector).value,
    });
    renderFieldSuggestions($(resultSelector), status, suggestions, targets);
  } catch (err) {
    setStatus(status, err.message, false);
  }
}

function suggestNewTopicFields() {
  return suggestTopicFields(
    "#tm-new-description",
    "#tm-new-keywords",
    "#tm-new-entities",
    "#tm-new-suggest-status",
    "#tm-new-suggest-result",
    { keywords: "#tm-new-keywords", entities: "#tm-new-entities", exclude: "#tm-new-exclude" },
  );
}

function suggestEditTopicFields() {
  return suggestTopicFields(
    "#tm-edit-description",
    "#tm-edit-keywords",
    "#tm-edit-entities",
    "#tm-edit-suggest-status",
    "#tm-edit-suggest-result",
    { keywords: "#tm-edit-keywords", entities: "#tm-edit-entities", exclude: "#tm-edit-exclude" },
  );
}

// ── exclude-suggestions: mines the topic's own most recent briefing for
//    low-relevance ("weak") narratives that cleared retrieval anyway, and
//    asks Claude which look like genuine noise. Only available once a topic
//    has been briefed at least once. Same draft-and-approve pattern as
//    background-facts auto-draft, reusing its factCard renderer. ──────────

async function suggestExcludesFromNoise() {
  const id = $("#topic-select").value;
  if (!id) return;
  const status = $("#tm-edit-exclude-suggest-status");
  const list = $("#tm-edit-exclude-suggestions");
  setStatus(status, "reviewing latest briefing…");
  try {
    const { weak_narrative_count, suggestions } = await post(
      `api/topics/${encodeURIComponent(id)}/exclude-suggestions`,
      {},
    );
    if (!weak_narrative_count) {
      setStatus(status, "no low-relevance narratives in the latest briefing", false);
      list.replaceChildren();
      return;
    }
    if (!suggestions.length) {
      setStatus(
        status,
        `${weak_narrative_count} low-relevance narrative(s), none look like genuine noise`,
        true,
      );
      list.replaceChildren();
      return;
    }
    setStatus(
      status,
      `${suggestions.length} candidate(s) from ${weak_narrative_count} low-relevance narratives`,
      true,
    );
    list.replaceChildren(
      ...suggestions.map((s) => {
        const li = factCard(s.term, s.reason, [
          {
            label: "Add to exclude",
            onClick: () => {
              mergeIntoCommaField("#tm-edit-exclude", [s.term]);
              li.remove();
            },
          },
          { label: "Discard", onClick: () => li.remove() },
        ]);
        return li;
      }),
    );
  } catch (err) {
    setStatus(status, err.message, false);
  }
}

// ── field-description popovers: tap the "?" chip to see what a field is
//    for. Click-triggered, not hover-only — a tooltip a touch device can't
//    reach isn't one tap away. Outside-tap or Escape dismisses; opening one
//    closes any other that's open. ──────────────────────────────────────────

function closeInfoChips(except) {
  for (const chip of document.querySelectorAll('.info-chip[aria-expanded="true"]')) {
    if (chip === except) continue;
    chip.setAttribute("aria-expanded", "false");
    chip.nextElementSibling.hidden = true;
  }
}

function initInfoChips() {
  document.addEventListener("click", (e) => {
    const chip = e.target.closest(".info-chip");
    if (chip) {
      e.preventDefault();
      const popover = chip.nextElementSibling;
      const willOpen = popover.hidden;
      closeInfoChips();
      popover.style.left = "";
      popover.hidden = !willOpen;
      chip.setAttribute("aria-expanded", String(willOpen));
      // The popover defaults to left:0 relative to its chip — fine for a
      // chip with room to its right, but a chip near either screen edge
      // (e.g. "Topic name", flush left) would otherwise push it off-screen.
      // Nudge it back on-screen with a pixel offset rather than a fixed
      // left/right side, since either fixed side can overflow depending on
      // where the chip sits.
      if (willOpen) {
        const margin = 12;
        const wrapLeft = chip.parentElement.getBoundingClientRect().left;
        const width = popover.getBoundingClientRect().width;
        const maxLeft = globalThis.innerWidth - margin - width;
        const clampedLeft = Math.max(margin, Math.min(wrapLeft, maxLeft));
        const offset = clampedLeft - wrapLeft;
        if (offset !== 0) popover.style.left = `${offset}px`;
      }
      return;
    }
    if (!e.target.closest(".info-popover")) closeInfoChips();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeInfoChips();
  });
}

// ── tuning (2026-08) — bucket thresholds, live from the server instead of
//    hardcoded, with a histogram of every stored narrative's raw velocity/
//    relevance so they get set where the real distribution separates
//    (src/briefing/thresholds.ts). ─────────────────────────────────────────

/** Evenly-binned counts over [domainMin, domainMax] — values outside are clamped into the edge bins. */
function histogramBins(values, binCount, domainMin, domainMax) {
  const span = domainMax - domainMin || 1;
  const width = span / binCount;
  const counts = new Array(binCount).fill(0);
  for (const v of values) {
    const clamped = Math.min(Math.max(v, domainMin), domainMax - 1e-9);
    counts[Math.floor((clamped - domainMin) / width)] += 1;
  }
  return counts.map((count, i) => ({
    from: domainMin + i * width,
    to: domainMin + (i + 1) * width,
    count,
  }));
}

/** Renders a row of bars into `container`; `classify(bin)` returns the pill class each bar borrows its color from. */
function renderHistogramBars(container, bins, classify) {
  const peak = Math.max(1, ...bins.map((b) => b.count));
  container.replaceChildren(
    ...bins.map((bin) =>
      el("div", {
        class: `hist-bar ${classify(bin)}`,
        style: `height: ${Math.round((bin.count / peak) * 100)}%`,
        title: `${bin.from.toFixed(2)}–${bin.to.toFixed(2)}: ${bin.count}`,
      })
    ),
  );
}

/** Draft thresholds straight from the input fields — not yet saved, but what the histogram colors against live. */
function draftThresholds() {
  return {
    hot: Number($("#tuning-hot").value),
    active: Number($("#tuning-active").value),
    strong: Number($("#tuning-strong").value),
    plausible: Number($("#tuning-plausible").value),
  };
}

/** Scores fetched once per page load; re-binned live as the draft threshold inputs change. */
let tuningScores = [];

function renderTuningHistograms() {
  const t = draftThresholds();
  const velocities = tuningScores.map((s) => s.velocity);
  const relevances = tuningScores.map((s) => s.relevance);

  const vMax = Math.max(1, ...velocities, t.hot * 1.2);
  const velocityBins = histogramBins(velocities, 20, 0, vMax);
  renderHistogramBars(
    $("#tuning-hist-velocity"),
    velocityBins,
    (bin) => (bin.from >= t.hot ? "hot" : bin.from >= t.active ? "active" : "quiet"),
  );

  const relevanceBins = histogramBins(relevances, 20, 0, 1);
  renderHistogramBars(
    $("#tuning-hist-relevance"),
    relevanceBins,
    (bin) => (bin.from >= t.strong ? "strong" : bin.from >= t.plausible ? "plausible" : "weak"),
  );

  $("#tuning-hist-count").textContent = tuningScores.length
    ? `${tuningScores.length} narrative(s) across every stored briefing`
    : "no briefings stored yet — run one to populate this";
}

function fillTuningInputs(t) {
  $("#tuning-hot").value = t.hot;
  $("#tuning-active").value = t.active;
  $("#tuning-strong").value = t.strong;
  $("#tuning-plausible").value = t.plausible;
}

async function loadTuning() {
  try {
    const { thresholds, scores } = await get("api/tuning");
    bucketThresholds = thresholds;
    tuningScores = scores;
    fillTuningInputs(thresholds);
    renderTuningHistograms();
  } catch {
    // No DATABASE_URL — bucketThresholds keeps its fallback value (declared
    // above) and the card just shows no data.
    $("#tuning-hist-count").textContent = "unavailable — set DATABASE_URL";
  }
}

async function saveTuning() {
  const status = $("#tuning-status");
  try {
    const saved = await put("api/tuning", draftThresholds());
    bucketThresholds = saved;
    fillTuningInputs(saved);
    setStatus(status, "saved", true);
  } catch (err) {
    setStatus(status, err.message, false);
  }
}

function initTuning() {
  for (const id of ["#tuning-hot", "#tuning-active", "#tuning-strong", "#tuning-plausible"]) {
    $(id).addEventListener("input", renderTuningHistograms);
  }
  $("#tuning-save").addEventListener("click", saveTuning);
}

function initTopicManager() {
  for (const btn of document.querySelectorAll(".tm-tab")) {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  }
  $("#topic-select").addEventListener("change", (e) => {
    loadTopicForEdit(e.target.value);
    updateKeywordsVisibility();
    loadBriefingsLibrary(e.target.value);
  });
  $("#tm-new-feed-add").addEventListener("click", addNewTopicFeed);
  $("#tm-new-create").addEventListener("click", createNewTopic);
  $("#tm-edit-feed-add").addEventListener("click", addEditFeed);
  $("#tm-edit-save").addEventListener("click", saveEditedTopic);
  $("#tm-edit-delete").addEventListener("click", deleteEditedTopic);
  $("#tm-edit-tag-attach").addEventListener("click", attachExistingTag);
  $("#tm-edit-new-tag-create").addEventListener("click", createAndAttachTag);
  $("#tm-edit-fact-add").addEventListener("click", addBackgroundFact);
  $("#tm-edit-fact-draft").addEventListener("click", draftBackgroundFacts);
  $("#tm-new-suggest-fields").addEventListener("click", suggestNewTopicFields);
  $("#tm-edit-suggest-fields").addEventListener("click", suggestEditTopicFields);
  $("#tm-edit-exclude-suggest").addEventListener("click", suggestExcludesFromNoise);
  renderNewFeedList();
  loadTopicForEdit($("#topic-select").value);
}

// ── boot ───────────────────────────────────────────────────────────────────

initTheme();
loadStatus();
// The Bluesky chip can move connecting → connected shortly after page load;
// everything else in /api/status is effectively static per process lifetime.
setInterval(loadStatus, 15_000);
loadTopics();
loadHomeView();
initTopicManager();
initTuning();
loadTuning();
initInfoChips();
$("#update-btn").addEventListener("click", runUpdate);
$("#gather-only-btn").addEventListener("click", runGatherOnly);
$("#keywords").addEventListener("keydown", (e) => {
  if (e.key === "Enter") runUpdate();
});
