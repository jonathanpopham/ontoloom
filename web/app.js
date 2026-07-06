/*
 * Ontoloom front-end — a vanilla-JS, dependency-free SVG graph editor.
 *
 * No frameworks, no CDN, no build step. Everything here is plain DOM + SVG so
 * the whole app runs from a single embedded file with zero network access.
 */
"use strict";

const SVG_NS = "http://www.w3.org/2000/svg";
const NODE_R = 28;
const PALETTE = ["#5b8def", "#7cc4a4", "#d98b6a", "#b98bd9", "#e0b15f", "#67c0d0", "#d97aa6", "#8fb069"];

/* ---- Application state ---- */
const state = {
  name: "Untitled ontology", // becomes the export file name
  nodes: [],          // {id, labels:[], caption, properties:{}, x, y}
  rels: [],           // {id, type, from, to, properties:{}}
  selection: null,    // {kind:'node'|'edge', id} or null
  mode: "select",     // 'select' | 'connect'
  connectSource: null,
  view: { x: 0, y: 0, scale: 1 },
  nodeSeq: 0,
  relSeq: 0,
};

/* ---- DOM handles ---- */
const svg = document.getElementById("canvas");
const viewport = document.getElementById("viewport");
const edgesLayer = document.getElementById("edges-layer");
const nodesLayer = document.getElementById("nodes-layer");
const inspector = document.getElementById("inspector");
const inspectorForm = document.getElementById("inspector-form");
const statusText = document.getElementById("status-text");
const countsEl = document.getElementById("counts");
const toastEl = document.getElementById("toast");
const docTitleEl = document.getElementById("doc-title");

/* ======================================================================
 * Utilities
 * ==================================================================== */
function el(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const child of children) node.appendChild(child);
  return node;
}

function nextNodeId() {
  let id;
  do {
    id = "n" + ++state.nodeSeq;
  } while (state.nodes.some((n) => n.id === id));
  return id;
}

function nextRelId() {
  let id;
  do {
    id = "r" + ++state.relSeq;
  } while (state.rels.some((r) => r.id === id));
  return id;
}

function colorForLabel(label) {
  if (!label) return "#3a4763";
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

function nodeById(id) {
  return state.nodes.find((n) => n.id === id);
}

// Turn a user-typed value into the most natural JSON type.
function coerceValue(raw) {
  const t = raw.trim();
  if (t === "") return "";
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}

function displayValue(v) {
  if (v === null) return "null";
  return String(v);
}

let toastTimer = null;
function toast(message, kind = "") {
  toastEl.textContent = message;
  toastEl.className = "toast " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 2400);
}

function setStatus(text) {
  statusText.textContent = text;
}

/* ======================================================================
 * Coordinate transforms (screen <-> world)
 * ==================================================================== */
function screenToWorld(clientX, clientY) {
  const rect = svg.getBoundingClientRect();
  const sx = clientX - rect.left;
  const sy = clientY - rect.top;
  return {
    x: (sx - state.view.x) / state.view.scale,
    y: (sy - state.view.y) / state.view.scale,
  };
}

function applyView() {
  viewport.setAttribute(
    "transform",
    `translate(${state.view.x} ${state.view.y}) scale(${state.view.scale})`
  );
}

/* ======================================================================
 * Graph mutations
 * ==================================================================== */
function addNode(worldX, worldY) {
  const id = nextNodeId();
  const node = {
    id,
    labels: [],
    caption: "Idea " + state.nodes.length,
    properties: {},
    x: worldX,
    y: worldY,
  };
  state.nodes.push(node);
  select("node", id);
  render();
  scheduleSave();
  return node;
}

function addRelationship(fromId, toId) {
  if (fromId === toId) {
    toast("Can't connect an idea to itself.", "bad");
    return;
  }
  const rel = {
    id: nextRelId(),
    type: "RELATED_TO",
    from: fromId,
    to: toId,
    properties: {},
  };
  state.rels.push(rel);
  select("edge", rel.id);
  render();
  scheduleSave();
}

function deleteSelection() {
  if (!state.selection) return;
  if (state.selection.kind === "node") {
    const id = state.selection.id;
    state.nodes = state.nodes.filter((n) => n.id !== id);
    state.rels = state.rels.filter((r) => r.from !== id && r.to !== id);
  } else {
    state.rels = state.rels.filter((r) => r.id !== state.selection.id);
  }
  state.selection = null;
  render();
  scheduleSave();
}

function select(kind, id) {
  state.selection = id ? { kind, id } : null;
  renderInspector();
  // Re-mark selection classes without a full rebuild.
  for (const g of nodesLayer.children) {
    g.classList.toggle("selected", kind === "node" && g.dataset.id === id);
  }
  for (const g of edgesLayer.children) {
    g.classList.toggle("selected", kind === "edge" && g.dataset.id === id);
  }
}

/* ======================================================================
 * Code map mode (gs-H5 big-graph rendering + gs-H2 lazy expand)
 *
 * When the loaded graph is a TrailTracker-style code hierarchy (nodes carry
 * properties.view === "hierarchy" plus a domain/unit/file/symbol level and
 * CONTAINS edges), a "Code map" toggle appears and the drill-down viewer in
 * codemap.js takes over rendering. The manual editor is untouched: the same
 * state.nodes / state.rels back both modes, and switching is lossless.
 * ==================================================================== */
const modeBtn = document.getElementById("btn-mode");

function isCodeMapActive() {
  return document.body.classList.contains("codemap-mode");
}

function setUiMode(mode) {
  const active = mode === "codemap";
  document.body.classList.toggle("codemap-mode", active);
  document.getElementById("editor").classList.toggle("hidden", active);
  document.getElementById("codemap").classList.toggle("hidden", !active);
  modeBtn.textContent = active ? "✎ Editor" : "⌗ Code map";
  if (active) {
    window.CodeMap.load(state.name, state.nodes, state.rels);
    setStatus("Code map: click a node to drill in. Level buttons expand to a depth.");
  } else {
    render(); // rebuild the editor DOM that was skipped while hidden
    setStatus("Ready.");
  }
}

// Called after every graph (re)load: show or hide the toggle, and optionally
// jump straight into the code map when a hierarchy arrives.
function updateCodeMapMode(autoEnter) {
  const isHierarchy = window.CodeMap && window.CodeMap.detect(state.nodes, state.rels);
  modeBtn.classList.toggle("hidden", !isHierarchy);
  if (isHierarchy && autoEnter) {
    setUiMode("codemap");
  } else if (!isHierarchy && isCodeMapActive()) {
    window.CodeMap.clear();
    setUiMode("editor");
  } else if (isHierarchy && isCodeMapActive()) {
    window.CodeMap.load(state.name, state.nodes, state.rels);
  }
}

modeBtn.addEventListener("click", () => {
  setUiMode(isCodeMapActive() ? "editor" : "codemap");
});

/* ======================================================================
 * Rendering
 * ==================================================================== */
function render() {
  countsEl.textContent = `${state.nodes.length} ideas · ${state.rels.length} links`;
  // While the code map owns the screen, skip rebuilding the (hidden) editor
  // DOM — that is what keeps a 20k-node repo from ever drawing as a
  // hairball. The editor is rebuilt on demand when switching back.
  if (isCodeMapActive()) return;
  applyView();
  renderEdges();
  renderNodes();
  renderInspector();
}

function renderNodes() {
  nodesLayer.replaceChildren();
  for (const node of state.nodes) {
    const fill = colorForLabel(node.labels[0]);
    const g = el("g", { class: "node", "data-id": node.id, transform: `translate(${node.x} ${node.y})` });
    if (state.selection && state.selection.kind === "node" && state.selection.id === node.id)
      g.classList.add("selected");
    if (state.connectSource === node.id) g.classList.add("connect-source");

    g.appendChild(el("circle", { class: "node-circle", r: NODE_R, fill }));

    const caption = node.caption || node.id;
    g.appendChild(text(caption, { class: "node-label", y: 5 }));
    if (node.labels.length) {
      g.appendChild(text(":" + node.labels.join(":"), { class: "node-sublabel", y: NODE_R + 14 }));
    }

    bindNodeEvents(g, node);
    nodesLayer.appendChild(g);
  }
}

function text(content, attrs) {
  const t = el("text", attrs);
  t.textContent = content;
  return t;
}

function renderEdges() {
  edgesLayer.replaceChildren();
  for (const rel of state.rels) {
    const a = nodeById(rel.from);
    const b = nodeById(rel.to);
    if (!a || !b) continue;
    const geom = edgeGeometry(a, b);
    const selected = state.selection && state.selection.kind === "edge" && state.selection.id === rel.id;

    const g = el("g", { class: "edge" + (selected ? " selected" : ""), "data-id": rel.id });
    g.appendChild(el("line", {
      class: "edge-line",
      x1: geom.x1, y1: geom.y1, x2: geom.x2, y2: geom.y2,
      "marker-end": selected ? "url(#arrow-active)" : "url(#arrow)",
    }));
    // Wide invisible line for easy clicking.
    g.appendChild(el("line", { class: "edge-hit", x1: geom.x1, y1: geom.y1, x2: geom.x2, y2: geom.y2 }));

    const mx = (geom.x1 + geom.x2) / 2;
    const my = (geom.y1 + geom.y2) / 2;
    const label = rel.type || "RELATED_TO";
    g.appendChild(el("rect", {
      class: "edge-label-bg",
      x: mx - label.length * 3.4 - 4, y: my - 9, width: label.length * 6.8 + 8, height: 16, rx: 3,
    }));
    g.appendChild(text(label, { class: "edge-label", x: mx, y: my + 3 }));

    g.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      select("edge", rel.id);
    });
    edgesLayer.appendChild(g);
  }
}

function edgeGeometry(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  return {
    x1: a.x + ux * NODE_R,
    y1: a.y + uy * NODE_R,
    x2: b.x - ux * (NODE_R + 4),
    y2: b.y - uy * (NODE_R + 4),
  };
}

/* ======================================================================
 * Node interaction (drag / click / connect)
 * ==================================================================== */
function bindNodeEvents(g, node) {
  g.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    if (state.mode === "connect") {
      handleConnectClick(node);
      return;
    }
    startNodeDrag(e, node, g);
  });
}

function handleConnectClick(node) {
  if (state.connectSource === null) {
    state.connectSource = node.id;
    setStatus("Connecting from “" + (node.caption || node.id) + "” — now click the target idea.");
    render();
  } else {
    const from = state.connectSource;
    state.connectSource = null;
    addRelationship(from, node.id);
    setStatus("Link created. Connect mode still on — pick another pair, or press Esc.");
  }
}

function startNodeDrag(e, node, g) {
  const start = screenToWorld(e.clientX, e.clientY);
  const origin = { x: node.x, y: node.y };
  let moved = false;

  function onMove(ev) {
    const p = screenToWorld(ev.clientX, ev.clientY);
    node.x = origin.x + (p.x - start.x);
    node.y = origin.y + (p.y - start.y);
    if (Math.abs(p.x - start.x) + Math.abs(p.y - start.y) > 2) moved = true;
    g.setAttribute("transform", `translate(${node.x} ${node.y})`);
    renderEdges(); // edges follow the moving node
  }
  function onUp() {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    if (!moved) {
      select("node", node.id);
    } else {
      scheduleSave();
    }
  }
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

/* ======================================================================
 * Canvas interaction (pan / add / deselect)
 * ==================================================================== */
let tempEdge = null;

svg.addEventListener("dblclick", (e) => {
  if (e.target.closest(".node") || e.target.closest(".edge")) return;
  const p = screenToWorld(e.clientX, e.clientY);
  addNode(p.x, p.y);
});

svg.addEventListener("mousedown", (e) => {
  if (e.target.closest(".node") || e.target.closest(".edge")) return;
  if (state.mode === "connect") {
    // Clicking empty space cancels an in-progress connection.
    state.connectSource = null;
    render();
    return;
  }
  // Otherwise pan the canvas.
  select(null, null);
  const startX = e.clientX;
  const startY = e.clientY;
  const origin = { x: state.view.x, y: state.view.y };
  function onMove(ev) {
    state.view.x = origin.x + (ev.clientX - startX);
    state.view.y = origin.y + (ev.clientY - startY);
    applyView();
  }
  function onUp() {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  }
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
});

svg.addEventListener("wheel", (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const newScale = Math.min(3, Math.max(0.25, state.view.scale * factor));
  // Zoom toward the cursor.
  const rect = svg.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  state.view.x = sx - (sx - state.view.x) * (newScale / state.view.scale);
  state.view.y = sy - (sy - state.view.y) * (newScale / state.view.scale);
  state.view.scale = newScale;
  applyView();
}, { passive: false });

/* ======================================================================
 * Inspector panel
 * ==================================================================== */
function renderInspector() {
  if (!state.selection) {
    inspector.classList.add("empty");
    inspectorForm.classList.add("hidden");
    return;
  }
  inspector.classList.remove("empty");
  inspectorForm.classList.remove("hidden");
  inspectorForm.replaceChildren();

  if (state.selection.kind === "node") {
    renderNodeInspector(nodeById(state.selection.id));
  } else {
    renderEdgeInspector(state.rels.find((r) => r.id === state.selection.id));
  }
}

function fieldWrap(labelText, input, sub) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const label = document.createElement("label");
  label.textContent = labelText;
  wrap.appendChild(label);
  wrap.appendChild(input);
  if (sub) {
    const s = document.createElement("div");
    s.className = "sub";
    s.textContent = sub;
    wrap.appendChild(s);
  }
  return wrap;
}

function renderNodeInspector(node) {
  if (!node) return;
  const title = document.createElement("div");
  title.className = "inspector-title";
  const swatch = document.createElement("span");
  swatch.className = "swatch";
  swatch.style.background = colorForLabel(node.labels[0]);
  title.appendChild(swatch);
  title.appendChild(document.createTextNode("Idea · " + node.id));
  inspectorForm.appendChild(title);

  const caption = document.createElement("input");
  caption.type = "text";
  caption.value = node.caption;
  caption.placeholder = "Name this idea";
  caption.addEventListener("input", () => {
    node.caption = caption.value;
    renderNodes();
    scheduleSave();
  });
  inspectorForm.appendChild(fieldWrap("Name", caption));

  const labels = document.createElement("input");
  labels.type = "text";
  labels.value = node.labels.join(", ");
  labels.placeholder = "e.g. Person, Author";
  labels.addEventListener("input", () => {
    node.labels = labels.value.split(",").map((s) => s.trim()).filter(Boolean);
    renderNodes();
    swatch.style.background = colorForLabel(node.labels[0]);
    scheduleSave();
  });
  inspectorForm.appendChild(
    fieldWrap("Types / labels", labels, "Comma-separated. These become Neo4j labels.")
  );

  inspectorForm.appendChild(propsEditor(node.properties));
  inspectorForm.appendChild(deleteButton("Delete idea"));
}

function renderEdgeInspector(rel) {
  if (!rel) return;
  const title = document.createElement("div");
  title.className = "inspector-title";
  title.textContent = "Link · " + rel.id;
  inspectorForm.appendChild(title);

  const from = nodeById(rel.from);
  const to = nodeById(rel.to);
  const ends = document.createElement("div");
  ends.className = "field";
  ends.innerHTML = `<label>Direction</label><div class="sub" style="font-size:13px;color:var(--text-dim)">${
    escapeHtml(from ? from.caption || from.id : rel.from)
  } &nbsp;→&nbsp; ${escapeHtml(to ? to.caption || to.id : rel.to)}</div>`;
  inspectorForm.appendChild(ends);

  const type = document.createElement("input");
  type.type = "text";
  type.value = rel.type;
  type.placeholder = "e.g. KNOWS, PART_OF";
  type.addEventListener("input", () => {
    rel.type = type.value.trim();
    renderEdges();
    scheduleSave();
  });
  inspectorForm.appendChild(
    fieldWrap("Relationship type", type, "Conventionally UPPER_SNAKE_CASE for Neo4j.")
  );

  inspectorForm.appendChild(propsEditor(rel.properties));
  inspectorForm.appendChild(deleteButton("Delete link"));
}

function propsEditor(properties) {
  const field = document.createElement("div");
  field.className = "field";
  const label = document.createElement("label");
  label.textContent = "Properties";
  field.appendChild(label);

  const table = document.createElement("div");
  table.className = "props-table";
  field.appendChild(table);

  function addRow(key, value) {
    const row = document.createElement("div");
    row.className = "prop-row";

    const keyInput = document.createElement("input");
    keyInput.className = "prop-key";
    keyInput.placeholder = "key";
    keyInput.value = key;

    const valInput = document.createElement("input");
    valInput.placeholder = "value";
    valInput.value = displayValue(value);

    const remove = document.createElement("button");
    remove.className = "prop-remove";
    remove.textContent = "×";

    function commit() {
      // Rebuild the properties object from the live rows to keep it in sync.
      const fresh = {};
      for (const r of table.children) {
        const k = r.querySelector(".prop-key").value.trim();
        const v = r.querySelector("input:not(.prop-key)").value;
        if (k) fresh[k] = coerceValue(v);
      }
      // Mutate in place so the caller's reference stays valid.
      for (const k of Object.keys(properties)) delete properties[k];
      Object.assign(properties, fresh);
      scheduleSave();
    }

    keyInput.addEventListener("input", commit);
    valInput.addEventListener("input", commit);
    remove.addEventListener("click", () => {
      row.remove();
      commit();
    });

    row.appendChild(keyInput);
    row.appendChild(valInput);
    row.appendChild(remove);
    table.appendChild(row);
  }

  for (const [k, v] of Object.entries(properties)) addRow(k, v);

  const add = document.createElement("button");
  add.className = "prop-add";
  add.textContent = "+ Add property";
  add.addEventListener("click", () => addRow("", ""));
  field.appendChild(add);

  return field;
}

function deleteButton(labelText) {
  const btn = document.createElement("button");
  btn.className = "inspector-delete";
  btn.textContent = labelText;
  btn.addEventListener("click", deleteSelection);
  return btn;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ======================================================================
 * Persistence & export
 * ==================================================================== */
function serialize() {
  return {
    name: state.name,
    nodes: state.nodes.map((n) => ({
      id: n.id,
      labels: n.labels,
      caption: n.caption,
      properties: n.properties,
      x: Math.round(n.x),
      y: Math.round(n.y),
    })),
    relationships: state.rels.map((r) => ({
      id: r.id,
      type: r.type,
      from: r.from,
      to: r.to,
      properties: r.properties,
    })),
  };
}

function loadGraph(data) {
  state.name = (typeof data.name === "string" && data.name.trim()) || "Untitled ontology";
  docTitleEl.value = state.name;
  document.title = state.name + " — Ontoloom";
  state.nodes = (data.nodes || []).map((n) => ({
    id: n.id,
    labels: Array.isArray(n.labels) ? n.labels : [],
    caption: n.caption || "",
    properties: n.properties && typeof n.properties === "object" ? n.properties : {},
    x: typeof n.x === "number" ? n.x : null,
    y: typeof n.y === "number" ? n.y : null,
  }));
  // Imports from JSONL / Cypher / GraphML carry no coordinates — lay those
  // nodes out on a tidy grid so nothing overlaps.
  const placed = state.nodes.filter((n) => n.x === null);
  if (placed.length) {
    const cols = Math.ceil(Math.sqrt(placed.length)) || 1;
    const spacing = 180;
    const ox = 140;
    const oy = 120;
    placed.forEach((n, i) => {
      n.x = ox + (i % cols) * spacing;
      n.y = oy + Math.floor(i / cols) * spacing;
    });
  }
  state.rels = (data.relationships || []).map((r) => ({
    id: r.id,
    type: r.type || "RELATED_TO",
    from: r.from,
    to: r.to,
    properties: r.properties && typeof r.properties === "object" ? r.properties : {},
  }));
  // Advance the id counters past anything we just loaded.
  state.nodeSeq = maxSeq(state.nodes.map((n) => n.id), "n");
  state.relSeq = maxSeq(state.rels.map((r) => r.id), "r");
  state.selection = null;
  state.connectSource = null;
  // Hierarchy graphs open in the code map; everything else stays in the
  // editor. Must run before render() so a huge import never builds the full
  // editor DOM first.
  updateCodeMapMode(true);
  render();
}

function maxSeq(ids, prefix) {
  let max = 0;
  for (const id of ids) {
    const m = new RegExp("^" + prefix + "(\\d+)$").exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

let saveTimer = null;
function scheduleSave() {
  // Always keep a local copy immediately (survives refresh, fully offline).
  try {
    localStorage.setItem("ontoloom.graph", JSON.stringify(serialize()));
  } catch (_) { /* storage may be unavailable; ignore */ }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveToServer, 600);
}

async function saveToServer() {
  try {
    const res = await fetch("/api/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(serialize()),
    });
    if (res.ok) setStatus("Saved to disk · " + new Date().toLocaleTimeString());
    else setStatus("Save rejected: " + (await res.text()));
  } catch (_) {
    setStatus("Saved locally (disk save unavailable).");
  }
}

async function exportAs(format) {
  try {
    const res = await fetch("/api/export/" + format + "?name=" + encodeURIComponent(state.name), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(serialize()),
    });
    if (!res.ok) {
      toast("Export failed: " + (await res.text()), "bad");
      return;
    }
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") || "";
    const m = /filename="([^"]+)"/.exec(cd);
    const filename = m ? m[1] : "ontology." + format;
    triggerDownload(blob, filename);
    toast("Exported " + filename, "good");
  } catch (e) {
    toast("Export failed: " + e.message, "bad");
  }
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ======================================================================
 * Toolbar wiring
 * ==================================================================== */
docTitleEl.addEventListener("input", () => {
  state.name = docTitleEl.value.trim() || "Untitled ontology";
  document.title = state.name + " — Ontoloom";
  scheduleSave();
});

document.getElementById("btn-add").addEventListener("click", () => {
  const p = screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
  addNode(p.x, p.y);
});

const connectBtn = document.getElementById("btn-connect");
connectBtn.addEventListener("click", () => {
  state.mode = state.mode === "connect" ? "select" : "connect";
  state.connectSource = null;
  connectBtn.classList.toggle("active", state.mode === "connect");
  svg.classList.toggle("connecting", state.mode === "connect");
  setStatus(
    state.mode === "connect"
      ? "Connect mode: click a source idea, then a target."
      : "Ready."
  );
  render();
});

document.getElementById("btn-delete").addEventListener("click", deleteSelection);
document.getElementById("btn-save").addEventListener("click", saveToServer);
document.getElementById("btn-load").addEventListener("click", loadFromServer);

const exportBtn = document.getElementById("btn-export");
const exportMenu = document.getElementById("export-menu");
exportBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  exportMenu.classList.toggle("hidden");
});
exportMenu.querySelectorAll("button").forEach((b) => {
  b.addEventListener("click", () => {
    exportMenu.classList.add("hidden");
    exportAs(b.dataset.format);
  });
});
document.addEventListener("click", () => exportMenu.classList.add("hidden"));

document.getElementById("btn-clear").addEventListener("click", () => {
  if (state.nodes.length === 0 || confirm("Clear the entire canvas? This cannot be undone.")) {
    state.nodes = [];
    state.rels = [];
    state.selection = null;
    state.connectSource = null;
    updateCodeMapMode(false); // an emptied graph is no hierarchy — back to the editor
    render();
    scheduleSave();
  }
});

const fileInput = document.getElementById("file-input");
document.getElementById("btn-import").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      // The Rust backend auto-detects JSON / JSONL / Cypher / GraphML and
      // returns an Ontoloom graph. The file name is a hint for detection.
      const res = await fetch("/api/import?name=" + encodeURIComponent(file.name), {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: reader.result,
      });
      if (!res.ok) {
        toast("Could not import: " + (await res.text()), "bad");
      } else {
        loadGraph(await res.json());
        scheduleSave();
        toast("Imported " + file.name, "good");
      }
    } catch (e) {
      toast("Could not read that file: " + e.message, "bad");
    }
    fileInput.value = "";
  };
  reader.readAsText(file);
});

/* ---- Keyboard shortcuts ---- */
window.addEventListener("keydown", (e) => {
  const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName);
  if (typing) return;
  if (isCodeMapActive()) return; // editing shortcuts belong to the editor
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    deleteSelection();
  } else if (e.key === "Escape") {
    state.connectSource = null;
    if (state.mode === "connect") connectBtn.click();
    select(null, null);
    render();
  } else if (e.key === "c" || e.key === "C") {
    connectBtn.click();
  }
});

/* ======================================================================
 * Boot
 * ==================================================================== */
async function loadFromServer() {
  try {
    const res = await fetch("/api/state");
    const data = await res.json();
    loadGraph(data);
    setStatus("Loaded from disk.");
  } catch (_) {
    // Fall back to the local copy if the server is unreachable.
    const local = localStorage.getItem("ontoloom.graph");
    if (local) {
      loadGraph(JSON.parse(local));
      setStatus("Loaded local copy.");
    } else {
      setStatus("Started a fresh graph.");
    }
  }
}

function seedExample() {
  if (state.nodes.length > 0) return;
  const cx = window.innerWidth / 2 - 160;
  const cy = window.innerHeight / 2 - 120;
  state.nodes = [
    { id: "n1", labels: ["Concept"], caption: "Knowledge Graph", properties: {}, x: cx, y: cy },
    { id: "n2", labels: ["Tool"], caption: "Ontoloom", properties: {}, x: cx + 220, y: cy - 60 },
    { id: "n3", labels: ["Format"], caption: "Neo4j", properties: {}, x: cx + 220, y: cy + 90 },
  ];
  state.rels = [
    { id: "r1", type: "BUILT_WITH", from: "n1", to: "n2", properties: {} },
    { id: "r2", type: "EXPORTS_TO", from: "n2", to: "n3", properties: {} },
  ];
  state.nodeSeq = 3;
  state.relSeq = 2;
}

(async function boot() {
  await loadFromServer();
  if (state.nodes.length === 0) {
    seedExample();
    render();
  }
  setStatus("Ready. Double-click anywhere to add an idea.");
})();
