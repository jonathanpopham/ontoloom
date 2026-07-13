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

// Per-node label color: pick whichever of near-black / near-white contrasts
// better with the circle fill (WCAG relative luminance). Keeps captions
// readable on the whole palette in both color schemes.
function bestTextOn(hexFill) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hexFill || "");
  if (!m) return "#f2f5fb";
  const int = parseInt(m[1], 16);
  const lin = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const L =
    0.2126 * lin((int >> 16) & 255) +
    0.7152 * lin((int >> 8) & 255) +
    0.0722 * lin(int & 255);
  // Contrast of the fill against #0d1524 (L≈0.006) vs #f2f5fb (L≈0.90).
  const vsDark = (L + 0.05) / 0.056;
  const vsLight = 0.95 / (L + 0.05);
  return vsDark >= vsLight ? "#0d1524" : "#f2f5fb";
}

// Wrap a caption to at most two short lines so it stays inside its node
// instead of colliding with neighbors; overflow gets an ellipsis and the
// full text lives in a native <title> tooltip.
const CAPTION_LINE_CHARS = 12;
function captionLines(caption) {
  const text = String(caption || "").trim();
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (lines.length === 2) break;
    const cand = cur ? cur + " " + w : w;
    if (cand.length <= CAPTION_LINE_CHARS) {
      cur = cand;
      continue;
    }
    if (cur) {
      lines.push(cur);
      cur = w;
    } else {
      lines.push(w); // single word longer than a line — truncated below
      cur = "";
    }
  }
  if (cur && lines.length < 2) lines.push(cur);
  const shown = lines
    .slice(0, 2)
    .map((l) => (l.length > CAPTION_LINE_CHARS ? l.slice(0, CAPTION_LINE_CHARS - 1) + "…" : l));
  // Anything left over (or trimmed) is flagged with a trailing ellipsis.
  if (shown.join(" ").replace(/…/g, "") !== text && shown.length) {
    const last = shown[shown.length - 1];
    if (!last.endsWith("…")) {
      shown[shown.length - 1] =
        (last.length >= CAPTION_LINE_CHARS ? last.slice(0, CAPTION_LINE_CHARS - 1) : last) + "…";
    }
  }
  return shown;
}

/* ---- Overlap-free placement ----------------------------------------
 * MIN_SEP is the center-to-center distance below which two nodes start
 * eating each other's labels: 2×NODE_R for the circles plus room for the
 * caption and the :Label line underneath. Everything here is deterministic
 * — same graph in, same layout out. */
const MIN_SEP = 104;

// Deterministic spiral probe: the first free spot at (or near) a requested
// point. Repeatedly pressing "Add idea" fans new nodes out instead of
// stacking them invisibly on top of one another.
function freeSpot(x, y) {
  const collides = (X, Y) => state.nodes.some((n) => Math.hypot(n.x - X, n.y - Y) < MIN_SEP);
  if (!collides(x, y)) return { x, y };
  for (let ring = 1; ring <= 32; ring++) {
    const r = ring * MIN_SEP * 0.8;
    const steps = 6 * ring;
    for (let s = 0; s < steps; s++) {
      const a = (s / steps) * 2 * Math.PI;
      const X = x + r * Math.cos(a);
      const Y = y + r * Math.sin(a);
      if (!collides(X, Y)) return { x: X, y: Y };
    }
  }
  return { x, y };
}

// Pairwise separation: push any two nodes apart until every pair clears
// MIN_SEP. O(n²) per pass, so it only runs on force-laid graphs (≤ the
// force-layout cap); the phyllotaxis fallback is spaced by construction.
function separatePositions(px, py, n) {
  for (let pass = 0; pass < 24; pass++) {
    let crowded = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = px[j] - px[i];
        let dy = py[j] - py[i];
        let d = Math.hypot(dx, dy);
        if (d >= MIN_SEP) continue;
        if (d < 0.01) {
          // Coincident pair: split along a deterministic per-pair angle.
          const a = (((i * 2654435761 + j * 40503) >>> 0) % 360) * (Math.PI / 180);
          dx = Math.cos(a);
          dy = Math.sin(a);
          d = 1;
        }
        const push = (MIN_SEP - d) / 2 / d;
        px[i] -= dx * push;
        py[i] -= dy * push;
        px[j] += dx * push;
        py[j] += dy * push;
        crowded = true;
      }
    }
    if (!crowded) break;
  }
}

// Deterministic auto-layout: a seeded Fruchterman–Reingold pass pulls
// connected ideas together and pushes strangers apart, then the separation
// pass guarantees nothing overlaps. Beyond FORCE_CAP nodes the O(n²) physics
// would stall the tab, so large graphs take a phyllotaxis spiral instead —
// evenly spaced by construction, still deterministic.
const FORCE_CAP = 400;
function autoLayout(nodes, rels) {
  const n = nodes.length;
  if (!n) return;
  const index = new Map(nodes.map((nd, i) => [nd.id, i]));
  const edges = [];
  for (const r of rels) {
    const a = index.get(r.from);
    const b = index.get(r.to);
    if (a !== undefined && b !== undefined && a !== b) edges.push([a, b]);
  }
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = MIN_SEP * Math.sqrt(i + 0.5);
    px[i] = r * Math.cos(i * GOLDEN);
    py[i] = r * Math.sin(i * GOLDEN);
  }
  if (n <= FORCE_CAP) {
    const k = MIN_SEP * 1.45; // ideal edge length
    let temp = k * Math.max(2, Math.sqrt(n) / 2);
    const dx = new Float64Array(n);
    const dy = new Float64Array(n);
    for (let it = 0; it < 120; it++) {
      dx.fill(0);
      dy.fill(0);
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let ddx = px[i] - px[j];
          let ddy = py[i] - py[j];
          let d2 = ddx * ddx + ddy * ddy;
          if (d2 < 0.01) {
            ddx = 0.1;
            ddy = 0.1;
            d2 = 0.02;
          }
          const f = (k * k) / d2; // repulsion / distance
          dx[i] += ddx * f;
          dy[i] += ddy * f;
          dx[j] -= ddx * f;
          dy[j] -= ddy * f;
        }
      }
      for (const [a, b] of edges) {
        const ddx = px[a] - px[b];
        const ddy = py[a] - py[b];
        const d = Math.hypot(ddx, ddy) || 0.1;
        const f = d / k; // attraction / distance
        dx[a] -= ddx * f;
        dy[a] -= ddy * f;
        dx[b] += ddx * f;
        dy[b] += ddy * f;
      }
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(dx[i], dy[i]) || 1;
        const step = Math.min(d, temp);
        px[i] += (dx[i] / d) * step;
        py[i] += (dy[i] / d) * step;
      }
      temp = Math.max(temp * 0.94, 1);
    }
    separatePositions(px, py, n);
  }
  nodes.forEach((nd, i) => {
    nd.x = Math.round(px[i]);
    nd.y = Math.round(py[i]);
  });
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
  // Errors linger longer — analyzer diagnostics take a moment to read.
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), kind === "bad" ? 6000 : 2400);
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
  // Never drop a new idea on top of an existing one — nudge to a free spot.
  const spot = freeSpot(worldX, worldY);
  const node = {
    id,
    labels: [],
    caption: "Idea " + state.nodes.length,
    properties: {},
    x: spot.x,
    y: spot.y,
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
 * When the loaded graph is an analyzer-style code hierarchy (nodes carry
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
  modeBtn.innerHTML = active
    ? '<span aria-hidden="true">✎</span> Editor'
    : '<span aria-hidden="true">⌗</span> Code map';
  if (active) {
    window.CodeMap.load(state.name, state.nodes, state.rels);
    setStatus("Code map: click a node to drill in. Level buttons expand to a depth.");
  } else {
    fitEditorView(); // grid-laid imports would otherwise sit half off-screen
    render(); // rebuild the editor DOM that was skipped while hidden
    setStatus("Ready.");
  }
}

// Bring every node into view (used when the editor takes over from the code
// map — imported graphs carry grid coordinates the current pan may not show).
function fitEditorView() {
  if (!state.nodes.length) return;
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of state.nodes) {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }
  minX -= 90; maxX += 90; minY -= 90; maxY += 90;
  const scale = Math.min(
    1.5,
    Math.max(0.25, Math.min(rect.width / (maxX - minX), rect.height / (maxY - minY)))
  );
  state.view.scale = scale;
  state.view.x = (rect.width - (maxX + minX) * scale) / 2;
  state.view.y = (rect.height - (maxY + minY) * scale) / 2;
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
  // The status bar speaks each mode's language: ideas/links in the editor,
  // nodes/relationships over a code map.
  countsEl.textContent = isCodeMapActive()
    ? `${state.nodes.length} nodes · ${state.rels.length} relationships`
    : `${state.nodes.length} ideas · ${state.rels.length} links`;
  // While the code map owns the screen, skip rebuilding the (hidden) editor
  // DOM — that is what keeps a 20k-node repo from ever drawing as a
  // hairball. The editor is rebuilt on demand when switching back.
  if (isCodeMapActive()) return;
  document.getElementById("canvas-empty").classList.toggle("hidden", state.nodes.length > 0);
  if (!state.connectSource) clearTempEdge();
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

    // Caption: up to two short lines that stay on the node, colored for
    // contrast against this node's fill. The full text rides in a native
    // <title> tooltip so truncation never hides information.
    const caption = node.caption || node.id;
    const lines = captionLines(caption);
    const labelFill = bestTextOn(fill);
    const ys = lines.length > 1 ? [-3, 11] : [4];
    lines.forEach((line, i) => {
      const t = text(line, { class: "node-label", y: ys[i] });
      t.style.fill = labelFill;
      g.appendChild(t);
    });
    if (node.labels.length) {
      g.appendChild(text(":" + node.labels.join(":"), { class: "node-sublabel", y: NODE_R + 14 }));
    }
    const tip = el("title");
    tip.textContent = node.labels.length ? caption + "  ·  :" + node.labels.join(":") : caption;
    g.appendChild(tip);

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

    g.addEventListener("pointerdown", (e) => {
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
  // Pointer events (not mouse events) so dragging works with a finger or a
  // stylus too — the canvas sets touch-action: none to keep the page still.
  g.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
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
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    if (!moved) {
      select("node", node.id);
    } else {
      scheduleSave();
    }
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

/* ======================================================================
 * Canvas interaction (pan / add / deselect)
 * ==================================================================== */
/* While connecting, a dashed preview edge follows the pointer from the
 * chosen source so the gesture in progress is always visible. It lives
 * directly on the viewport (not in edges-layer) so renderEdges() can
 * rebuild real edges without touching it. */
let tempEdge = null;

function updateTempEdge(worldX, worldY) {
  const src = nodeById(state.connectSource);
  if (!src) {
    clearTempEdge();
    return;
  }
  if (!tempEdge) {
    tempEdge = el("line", { class: "temp-edge" });
    viewport.appendChild(tempEdge);
  }
  tempEdge.setAttribute("x1", src.x);
  tempEdge.setAttribute("y1", src.y);
  tempEdge.setAttribute("x2", worldX);
  tempEdge.setAttribute("y2", worldY);
}

function clearTempEdge() {
  if (tempEdge) {
    tempEdge.remove();
    tempEdge = null;
  }
}

svg.addEventListener("pointermove", (e) => {
  if (state.mode !== "connect" || !state.connectSource) return;
  const p = screenToWorld(e.clientX, e.clientY);
  updateTempEdge(p.x, p.y);
});

svg.addEventListener("dblclick", (e) => {
  if (e.target.closest(".node") || e.target.closest(".edge")) return;
  const p = screenToWorld(e.clientX, e.clientY);
  addNode(p.x, p.y);
});

svg.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse" && e.button !== 0) return;
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
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
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
  state.rels = (data.relationships || []).map((r) => ({
    id: r.id,
    type: r.type || "RELATED_TO",
    from: r.from,
    to: r.to,
    properties: r.properties && typeof r.properties === "object" ? r.properties : {},
  }));
  // Imports from JSONL / Cypher / GraphML carry no coordinates. When the
  // whole graph is unplaced, run the deterministic auto-layout so connected
  // ideas land near each other and nothing overlaps; when only some nodes
  // are new, grid them below the existing content instead of on top of it.
  const unplaced = state.nodes.filter((n) => n.x === null);
  if (unplaced.length === state.nodes.length) {
    autoLayout(state.nodes, state.rels);
  } else if (unplaced.length) {
    const cols = Math.ceil(Math.sqrt(unplaced.length)) || 1;
    const spacing = Math.max(MIN_SEP, 180);
    const anchored = state.nodes.filter((n) => n.x !== null);
    const ox = Math.min(...anchored.map((n) => n.x), 140);
    const oy = Math.max(...anchored.map((n) => n.y)) + spacing;
    unplaced.forEach((n, i) => {
      n.x = ox + (i % cols) * spacing;
      n.y = oy + Math.floor(i / cols) * spacing;
    });
  }
  // Advance the id counters past anything we just loaded.
  state.nodeSeq = maxSeq(state.nodes.map((n) => n.id), "n");
  state.relSeq = maxSeq(state.rels.map((r) => r.id), "r");
  state.selection = null;
  state.connectSource = null;
  // Hierarchy graphs open in the code map; everything else stays in the
  // editor. Must run before render() so a huge import never builds the full
  // editor DOM first.
  updateCodeMapMode(true);
  // Freshly laid-out graphs may sit anywhere in world space — bring the
  // whole thing into view before first paint of the editor.
  if (!isCodeMapActive()) fitEditorView();
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
  connectBtn.setAttribute("aria-pressed", String(state.mode === "connect"));
  svg.classList.toggle("connecting", state.mode === "connect");
  setStatus(
    state.mode === "connect"
      ? "Connect mode: click a source idea, then a target."
      : "Ready."
  );
  render();
});

document.getElementById("btn-arrange").addEventListener("click", () => {
  if (!state.nodes.length) {
    toast("Nothing to arrange yet — add an idea first.");
    return;
  }
  autoLayout(state.nodes, state.rels);
  fitEditorView();
  render();
  scheduleSave();
  setStatus("Arranged " + state.nodes.length + (state.nodes.length === 1 ? " idea." : " ideas."));
});

document.getElementById("btn-delete").addEventListener("click", deleteSelection);
document.getElementById("btn-save").addEventListener("click", saveToServer);
document.getElementById("btn-load").addEventListener("click", loadFromServer);

const exportBtn = document.getElementById("btn-export");
const exportMenu = document.getElementById("export-menu");

// Keep each popup trigger's aria-expanded truthful, whichever path closed it.
function syncMenus() {
  exportBtn.setAttribute("aria-expanded", String(!exportMenu.classList.contains("hidden")));
  analyzeBtn.setAttribute("aria-expanded", String(!analyzeMenu.classList.contains("hidden")));
}
function closeMenus() {
  exportMenu.classList.add("hidden");
  analyzeMenu.classList.add("hidden");
  syncMenus();
}

exportBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  analyzeMenu.classList.add("hidden");
  exportMenu.classList.toggle("hidden");
  syncMenus();
});
exportMenu.querySelectorAll("button").forEach((b) => {
  b.addEventListener("click", () => {
    closeMenus();
    exportAs(b.dataset.format);
  });
});
document.addEventListener("click", closeMenus);

/* ---- Analyze a repository (gs-H4) ----
 * POSTs a local path to /api/analyze; the Rust server shells to the locally
 * configured analyzer binary and returns the repo as a hierarchy graph, which
 * loadGraph() then auto-opens in code-map mode. Loopback-only, airgapped —
 * the analyzer is a local executable and nothing leaves the machine. */
const analyzeBtn = document.getElementById("btn-analyze");
const analyzeMenu = document.getElementById("analyze-menu");
const analyzePathEl = document.getElementById("analyze-path");
const analyzeGo = document.getElementById("analyze-go");

analyzeBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  exportMenu.classList.add("hidden");
  analyzeMenu.classList.toggle("hidden");
  syncMenus();
  if (!analyzeMenu.classList.contains("hidden")) analyzePathEl.focus();
});
// Clicks inside the panel (typing, selecting text) must not close it.
analyzeMenu.addEventListener("click", (e) => e.stopPropagation());
analyzePathEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runAnalyze();
  else if (e.key === "Escape") {
    closeMenus();
    analyzeBtn.focus(); // hand focus back to the trigger, not the void
  }
});
analyzeGo.addEventListener("click", runAnalyze);

// Escape closes any open dropdown no matter what has focus (Nielsen #3:
// user control & freedom). Runs on capture-independent bubble; menus that
// are already closed make this a no-op.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!exportMenu.classList.contains("hidden") || !analyzeMenu.classList.contains("hidden")) {
    closeMenus();
  }
});

let analyzing = false;
async function runAnalyze() {
  const path = analyzePathEl.value.trim();
  if (!path) {
    toast("Enter the path to a repository first.", "bad");
    analyzePathEl.focus();
    return;
  }
  if (analyzing) return;
  analyzing = true;
  analyzeGo.disabled = true;
  analyzeGo.classList.add("busy");
  analyzeGo.setAttribute("aria-busy", "true");
  analyzeGo.textContent = "Analyzing…";
  setStatus("Analyzing " + path + " — running the analyzer locally…");
  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) {
      // The server sends a specific, human-readable reason: bad path,
      // missing binary, or the analyzer's own diagnostic.
      toast(await res.text(), "bad");
      setStatus("Ready.");
      return;
    }
    const data = await res.json();
    closeMenus();
    loadGraph(data); // hierarchy graphs auto-enter the code map
    scheduleSave();
    toast("Analyzed " + path, "good");
  } catch (e) {
    toast("Analyze failed: " + e.message, "bad");
    setStatus("Ready.");
  } finally {
    analyzing = false;
    analyzeGo.disabled = false;
    analyzeGo.classList.remove("busy");
    analyzeGo.removeAttribute("aria-busy");
    analyzeGo.textContent = "Analyze";
  }
}

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
