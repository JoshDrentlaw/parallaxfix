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

// ── velocity/relevance buckets ──────────────────────────────────────────────
// Thresholds are an initial heuristic, not tuned against a real velocity/
// similarity distribution (same caveat DEFAULT_MIN_SIMILARITY in
// src/corpus/store.ts carries) — revisit once there's real usage data.
// Velocity is a magnitude (items/hour over a fixed recent window), not a
// measured trend, so the labels describe how much is happening, not whether
// it's accelerating or decelerating.
function velocityBucket(v) {
  if (v >= 3) return { label: "hot", cls: "hot" };
  if (v >= 0.5) return { label: "active", cls: "active" };
  return { label: "quiet", cls: "quiet" };
}

function relevanceBucket(r) {
  if (r >= 0.65) return { label: "strong match", cls: "strong" };
  if (r >= 0.5) return { label: "plausible match", cls: "plausible" };
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
    el("span", { class: "src-tag", text: e.source }),
    ` ${e.author ?? "(unknown)"} · ${fmtTime(e.created_at)} · `,
  );
  line.append(safeLink(e.url, "open ↗"));
  return line;
}

function renderNarrative(n, i, provenance) {
  const card = el("article", { class: "card narrative", id: `narrative-${n.cluster_id}` });
  const vb = velocityBucket(n.velocity);
  const rb = relevanceBucket(n.relevance);
  const head = el(
    "div",
    { class: "narrative-head" },
    el("span", { class: "rank", text: `#${i + 1}` }),
    el("h3", {
      class: n.label ? "label" : "label unlabeled",
      text: n.label || "(unlabeled — set ANTHROPIC_API_KEY for labels)",
    }),
    el(
      "span",
      { class: "narrative-meta" },
      el("span", {
        class: `velocity-bucket ${vb.cls}`,
        title: `${n.velocity.toFixed(2)} items/h`,
        text: vb.label,
      }),
      el("span", {
        class: `relevance-bucket ${rb.cls}`,
        title: `relevance score ${n.relevance.toFixed(2)}`,
        text: rb.label,
      }),
      ` · ${n.size} item(s) · first seen ${fmtTime(n.first_seen)}`,
    ),
  );
  card.append(head);

  // Evidence (exemplars + claims) collapses by default past the first
  // couple narratives — the head above stays outside this <details> so
  // it's always visible, giving the ToC and heading-based screen-reader
  // navigation something real to land on even when collapsed.
  const evidence = el("details", { class: "narrative-evidence" });
  if (i < 2) evidence.open = true;
  evidence.append(
    el("summary", {
      text:
        `Evidence — ${n.representative_item_ids.length} exemplar(s), ${n.claims.length} claim(s)`,
    }),
  );

  for (const id of n.representative_item_ids) {
    const e = provenance[id];
    if (!e) continue;
    evidence.append(
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
    evidence.append(claims);
  }
  card.append(evidence);
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

  // A jump list, shown only when there's more than one narrative to jump
  // between — otherwise it's dead weight above the fold.
  if (b.narratives.length > 1) {
    const list = el("ol");
    b.narratives.forEach((n, i) => {
      list.append(
        el(
          "li",
          {},
          el("a", {
            href: `#narrative-${n.cluster_id}`,
            text: n.label || `Narrative #${i + 1}`,
          }),
        ),
      );
    });
    out.push(el("nav", { class: "narrative-toc", "aria-label": "Jump to narrative" }, list));
  }

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

  // Background (Track B): general context for the topic's subject matter,
  // independent of this run's narratives — kept structurally separate from
  // claims, which are pulled from the discourse and may be wrong.
  if (b.background_facts.length) {
    const background = el("section", { class: "card background" });
    background.append(
      el("h2", {
        class: "section-title",
        text: "Background — general context, not specific to this run",
      }),
    );
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
    el("h2", {
      class: "section-title",
      text: "Narratives — ranked by velocity (rate of change, not volume, shown as " +
        "hot/active/quiet); relevance is shown as a match-strength bucket — hover either " +
        "for the raw number",
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
    $("#results").replaceChildren(...renderBriefing(briefing));
    focusResults();
    await loadBriefingsLibrary($("#topic-select").value);
    await loadHomeView();
  } catch (err) {
    showError(err);
  } finally {
    setBusy(null);
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
    if (!Array.isArray(list) || list.length === 0) {
      section.hidden = true;
      return;
    }
    $("#briefings-library-list").replaceChildren(
      ...list.map((b) => briefingLibraryItem(b, viewStoredBriefing)),
    );
    section.hidden = false;
  } catch {
    section.hidden = true;
  }
}

async function viewStoredBriefing(id) {
  clearOutput();
  setBusy("loading saved briefing…");
  try {
    const briefing = await get(`api/briefings/${encodeURIComponent(id)}`);
    $("#results").replaceChildren(...renderBriefing(briefing));
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
    await loadTopics(created.id);
    await loadTopicForEdit(created.id);
    switchTab("edit");
  } catch (err) {
    setStatus(status, err.message, false);
  }
}

// -- "edit topic" panel: reads/writes the topic currently selected in the
//    main controls' dropdown; feed add/remove persist immediately. --

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
    $("#tm-edit-keywords").value = topic.keywords.join(", ");
    $("#tm-edit-entities").value = topic.entities.join(", ");
    $("#tm-edit-description").value = topic.description;
    $("#tm-edit-exclude").value = topic.exclude.join(", ");
    renderFeedList($("#tm-edit-feed-list"), topic.feeds, (url) => removeEditFeed(id, url));
    renderFeedCheck($("#tm-edit-feed-result"), null);
    setStatus($("#tm-edit-status"), "");
    hint.hidden = true;
    form.hidden = false;
    loadTopicTags(id);
    loadTopicFacts(id);
  } catch {
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

function factListItem(fact, onRemove) {
  const li = el(
    "li",
    { class: "fact-item" },
    el(
      "div",
      { class: "fact-item-body" },
      el("p", { class: "fact-text", text: fact.text }),
      el("p", {
        class: "fact-meta",
        text: `${fact.source_name} · as of ${fact.as_of.slice(0, 10)}`,
      }),
    ),
  );
  if (onRemove) {
    const btn = el("button", { type: "button", text: "×", title: "detach this fact" });
    btn.addEventListener("click", onRemove);
    li.append(btn);
  }
  return li;
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
    renderTagListUI(ul, tags, (tagId) => removeEditTag(id, tagId));
  } catch {
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
    renderFactListUI(ul, facts, (factId) => removeEditFact(id, factId));
  } catch {
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
    if (!suggestions.length) {
      box.replaceChildren();
      return;
    }
    const list = el("ul", { class: "fact-list" });
    for (const f of suggestions) {
      const li = el(
        "li",
        { class: "fact-item" },
        el(
          "div",
          { class: "fact-item-body" },
          el("p", { class: "fact-text", text: f.text }),
          el("p", {
            class: "fact-meta",
            text: `${f.source_name} · as of ${f.as_of.slice(0, 10)}`,
          }),
        ),
      );
      const btn = el("button", { type: "button", text: "+ attach" });
      btn.addEventListener("click", () => attachSuggestedFact(id, f.id));
      li.append(btn);
      list.append(li);
    }
    box.replaceChildren(
      el("p", { class: "tm-subtitle", text: "Suggested (shares a tag with this topic)" }),
      list,
    );
  } catch {
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
initInfoChips();
$("#update-btn").addEventListener("click", runUpdate);
$("#keywords").addEventListener("keydown", (e) => {
  if (e.key === "Enter") runUpdate();
});
