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
  const card = el("article", { class: "card narrative", id: `narrative-${n.cluster_id}` });
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
      el("span", { class: "velocity", text: `${n.velocity.toFixed(2)}/h` }),
      el("span", { class: "relevance", text: `relevance ${n.relevance.toFixed(2)}` }),
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
          el("span", {
            class: `badge ${c.evidence_type}`,
            text: c.evidence_type.replace("_", " "),
          }),
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

  out.push(
    el("h2", {
      class: "section-title",
      text: "Narratives — ranked by velocity (rate of change, not volume); " +
        "relevance (0–1) is topic-match strength",
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

// #results has tabindex="-1" (not otherwise focusable, but a valid
// programmatic focus target) so a screen-reader user isn't left in total
// silence after a run — the standard "route change" focus-management
// pattern in place of a giant aria-live region trying to announce an
// entire briefing's worth of new content at once.
function focusResults() {
  $("#results").focus();
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
    focusResults();
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
    focusResults();
  } catch (err) {
    showError(err);
  } finally {
    setBusy(null);
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
  $("#topic-select").addEventListener("change", (e) => loadTopicForEdit(e.target.value));
  $("#tm-new-feed-add").addEventListener("click", addNewTopicFeed);
  $("#tm-new-create").addEventListener("click", createNewTopic);
  $("#tm-edit-feed-add").addEventListener("click", addEditFeed);
  $("#tm-edit-save").addEventListener("click", saveEditedTopic);
  $("#tm-edit-delete").addEventListener("click", deleteEditedTopic);
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
initTopicManager();
initInfoChips();
$("#gather-btn").addEventListener("click", runGather);
$("#brief-btn").addEventListener("click", runBrief);
$("#keywords").addEventListener("keydown", (e) => {
  if (e.key === "Enter") runBrief();
});
