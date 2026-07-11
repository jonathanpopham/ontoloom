/* H11 headless harness — matrix face, ontology lens, physics spread,
 * radial drill clusters.
 *
 * Runs the real ../../web/codemap.js in a vm sandbox with a DOM stub,
 * drives it with the real eShop hierarchy, and asserts:
 *   1. DENSE DEFAULT: a fresh load (no stored preference) of the dense
 *      eShop graph opens the MATRIX face — no force soup as first contact —
 *      and writes no preference the user never chose
 *   2. matrix structure: 21×21 domain grid, one cell per ordered pair,
 *      exactly N cells per row (overlap-free BY CONSTRUCTION), diagonal
 *      blanked, real aggregated DEPENDS_ON counts (Property→Catalog 19,
 *      Order→Bus 17, total 397)
 *   3. ontology lens drives the matrix: layers lens cross-tabulates layer
 *      flow and flags exactly the outward-pointing cells red
 *      (Domain→Application, Application→Infrastructure); containment lens
 *      shows presence-only density; matrix repaints byte-identically
 *      through a matrix → web → matrix round-trip
 *   4. a SMALL graph still defaults to the web face
 *   5. ontology lens drives the web: coupling paints DEPENDS_ON, containment
 *      hides it, layers flags exactly the 5 outward unit→unit edges red
 *   6. physics/spread control: raising the slider spreads the layout
 *      (mean pairwise distance grows), the result is deterministic across
 *      worlds, and sliding back to 1× restores the seeded layout
 *      byte-identically
 *   7. drill = clean local cluster: children ring their parent (radial
 *      orbit), and NO drill depth — domains, all units, file→symbols —
 *      leaves any two nodes stacked (min-separation violations: 0; was 29
 *      residuals at the files depth pre-H11) or any file/symbol node
 *      visible before its parent was drilled (H10 directive re-check)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "..", "web", "codemap.js"), "utf8");
const DATA = JSON.parse(
  fs.readFileSync(path.join(__dirname, "eshop-hierarchy.ontoloom.json"), "utf8")
);

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok  " + msg);
  else { failures++; console.log("  FAIL " + msg); }
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/* ---- DOM stub world, one per isolated run ---- */
function makeWorld(storageSeed) {
  const store = Object.assign({ "ontoloom.cmTourDone": "1" }, storageSeed || {});
  function stubEl(id) {
    return {
      id,
      _listeners: {},
      _attrs: {},
      innerHTML: "",
      textContent: "",
      value: "",
      hidden: false,
      dataset: {},
      style: {},
      classList: {
        _set: new Set(id === "cm-tour" || id === "cm-matrix" ? ["hidden"] : []),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        toggle(c, on) { on ? this._set.add(c) : this._set.delete(c); },
        contains(c) { return this._set.has(c); },
      },
      addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
      setAttribute(k, v) { this._attrs[k] = v; },
      getBoundingClientRect() { return { width: 1200, height: 800, left: 0, top: 0 }; },
      setPointerCapture() {},
      releasePointerCapture() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      focus() {},
    };
  }
  const ids = [
    "cm-wrap", "cm-svg", "cm-viewport", "cm-detail", "cm-stats", "cm-visible",
    "cm-search", "cm-match-count", "cm-fit", "cm-help", "cm-layout", "cm-lens",
    "cm-phys", "cm-phys-wrap", "cm-matrix", "cm-tour", "cm-tour-title",
    "cm-tour-body", "cm-tour-dots", "cm-tour-back", "cm-tour-next", "cm-tour-skip",
  ];
  const els = {};
  for (const id of ids) els[id] = stubEl(id);

  const document = {
    getElementById: (id) => els[id] || (els[id] = stubEl(id)),
    querySelectorAll: () => [],
    addEventListener() {},
    contains: () => false,
    activeElement: null,
    body: { classList: { contains: () => false } },
  };
  const sandbox = {
    document,
    console,
    setTimeout, clearTimeout,
    requestAnimationFrame: () => {}, // settle animation never runs headless
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    Math, JSON,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { els, store, CodeMap: sandbox.CodeMap };
}

/* ---- Driver helpers (same event paths a real pointer takes) ---- */
function fire(el, type, ev) {
  for (const fn of el._listeners[type] || []) fn(ev);
}
function clickLayout(w, mode) {
  fire(w.els["cm-layout"], "click", { target: { closest: () => ({ dataset: { m: mode } }) } });
}
function clickLens(w, l) {
  fire(w.els["cm-lens"], "click", { target: { closest: () => ({ dataset: { l } }) } });
}
function slidePhys(w, v) {
  fire(w.els["cm-phys"], "input", { target: { value: String(v) } });
}
function nodeTarget(tid) {
  return { closest: (sel) => (sel === ".cm-node" ? { dataset: { id: tid } } : null) };
}
function emptyTarget() {
  return { closest: () => null };
}
function clickNode(w, tid) {
  fire(w.els["cm-wrap"], "pointerdown", { target: nodeTarget(tid), clientX: 10, clientY: 10 });
  fire(w.els["cm-wrap"], "pointerup", { target: emptyTarget(), clientX: 10, clientY: 10 });
}
// data-id -> {x, y, r, cls} parsed straight out of the painted SVG string
function nodes(w) {
  const out = new Map();
  const re = /<g class="(cm-node[^"]*)" data-id="([^"]+)"[^>]*transform="translate\((-?[\d.]+),(-?[\d.]+)\)">(?:<circle class="selring"[^>]*\/>)?<circle class="dot" r="([\d.]+)"/g;
  let m;
  while ((m = re.exec(w.els["cm-viewport"].innerHTML))) {
    out.set(m[2], { cls: m[1], x: parseFloat(m[3]), y: parseFloat(m[4]), r: parseFloat(m[5]) });
  }
  return out;
}
const SEP_PAD = 12; // must match WEB.sepPad in codemap.js
function sepViolations(pos) {
  const list = [...pos.values()];
  let bad = 0;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d + 1e-6 < a.r + b.r + SEP_PAD) bad++;
    }
  }
  return bad;
}
// The anti-mess gate, straight from the brief: "no >N stacked nodes within
// R pixels". stackMax(pos, R) = the largest number of OTHER nodes any node
// has within R px of its center.
function stackMax(pos, R) {
  const list = [...pos.values()];
  let worst = 0;
  for (let i = 0; i < list.length; i++) {
    let c = 0;
    for (let j = 0; j < list.length; j++) {
      if (i !== j && Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y) <= R) c++;
    }
    if (c > worst) worst = c;
  }
  return worst;
}
function meanPairDist(pos) {
  const list = [...pos.values()];
  let sum = 0, n = 0;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      sum += Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y);
      n++;
    }
  }
  return n ? sum / n : 0;
}
/* ---- Matrix parsing ---- */
function matrixRows(w) {
  // -> [{ label, cells: ["", "19", "●", ...] }] straight from the table
  const html = w.els["cm-matrix"].innerHTML;
  const rows = [];
  const rowRe = /<tr><th scope="row"[^>]*>(?:<i[^>]*><\/i>)?([^<]*)<\/th>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(html))) {
    const cells = [];
    const cellRe = /<td class="cell[^"]*"[^>]*>([^<]*)<\/td>/g;
    let c;
    while ((c = cellRe.exec(m[2]))) cells.push(c[1]);
    rows.push({ label: m[1], cells });
  }
  return rows;
}

/* ---- A minimal NON-dense hierarchy (2 domains) for the default check ---- */
function tinyGraph() {
  const H = { view: "hierarchy" };
  return {
    name: "tiny",
    nodes: [
      { id: "d1", labels: ["Domain"], caption: "Alpha", properties: Object.assign({ level: "domain" }, H) },
      { id: "d2", labels: ["Domain"], caption: "Beta", properties: Object.assign({ level: "domain" }, H) },
      { id: "f1", labels: ["File"], caption: "a.rs", properties: Object.assign({ level: "file", path: "src/a.rs" }, H) },
      { id: "f2", labels: ["File"], caption: "b.rs", properties: Object.assign({ level: "file", path: "src/b.rs" }, H) },
    ],
    relationships: [
      { type: "CONTAINS", from: "d1", to: "f1", properties: {} },
      { type: "CONTAINS", from: "d2", to: "f2", properties: {} },
      { type: "DEPENDS_ON", from: "d1", to: "d2", properties: { count: 3 } },
    ],
  };
}

/* ==================================================================== */
(async () => {
  console.log("\n-- 1. dense graph, no stored preference: MATRIX is the default face --");
  const w1 = makeWorld();
  w1.CodeMap.load(DATA.name, DATA.nodes, DATA.relationships);
  assert(w1.els["cm-matrix"].innerHTML.includes("<table"), "fresh dense load renders the matrix grid");
  assert(!w1.els["cm-matrix"].classList.contains("hidden"), "matrix overlay is revealed");
  assert(!w1.els["cm-viewport"].innerHTML.includes("cm-node"), "no force layout painted as first contact");
  assert(!("ontoloom.cmLayout" in w1.store), "density default writes no preference the user never chose");
  assert(/21×21/.test(w1.els["cm-visible"].textContent), `status reads the grid size (${w1.els["cm-visible"].textContent})`);

  console.log("\n-- 2. matrix structure: real counts, overlap-free by construction --");
  {
    const rows = matrixRows(w1);
    assert(rows.length === 21, `21 domain rows (got ${rows.length})`);
    assert(rows.every((r) => r.cells.length === 21), "every row carries exactly 21 cells — one per ordered pair, nothing can stack");
    const headerCols = (w1.els["cm-matrix"].innerHTML.match(/<th scope="col">/g) || []).length;
    assert(headerCols === 21, `21 column headers (got ${headerCols})`);
    const diag = (w1.els["cm-matrix"].innerHTML.match(/class="cell diag"/g) || []).length;
    assert(diag === 21, `diagonal blanked (${diag} cells)`);
    const html = w1.els["cm-matrix"].innerHTML;
    assert(html.includes("Property depends on Catalog — 19 references"), "Property→Catalog cell counts 19 (real aggregated DEPENDS_ON)");
    assert(html.includes("Order depends on Bus — 17 references"), "Order→Bus cell counts 17");
    let sum = 0;
    for (const r of rows) for (const c of r.cells) sum += parseInt(c, 10) || 0;
    assert(sum === 397, `matrix total equals the fixture's aggregate coupling (${sum} = 397)`);
  }

  console.log("\n-- 3. lens drives the matrix: layer flow flags outward cells red --");
  {
    clickLens(w1, "layers");
    let html = w1.els["cm-matrix"].innerHTML;
    const viol = (html.match(/class="cell viol"/g) || []).length;
    assert(viol === 2, `exactly the 2 outward layer cells flag red (got ${viol})`);
    assert(html.includes("Domain depends outward on Application — 5 references (LAYER VIOLATION: points outward)"),
      "Domain→Application (5) is one of them");
    assert(html.includes("Application depends outward on Infrastructure — 20 references (LAYER VIOLATION: points outward)"),
      "Application→Infrastructure (20) is the other");
    assert(html.includes("point outward"), "caption calls out the outward flow");

    clickLens(w1, "containment");
    html = w1.els["cm-matrix"].innerHTML;
    assert(html.includes("●"), "containment lens shows presence-only density dots");
    assert(!/<td class="cell[^"]*"[^>]*>\d/.test(html), "…and no cell carries a magnitude");

    clickLens(w1, "coupling");
    const back = w1.els["cm-matrix"].innerHTML;
    assert(back.includes("Property depends on Catalog — 19 references"), "coupling lens restores the count grid");

    // mode round-trip repaints the same grid byte-identically
    clickLayout(w1, "web");
    assert(w1.els["cm-matrix"].classList.contains("hidden"), "switching to web hides the matrix overlay");
    assert(w1.els["cm-viewport"].innerHTML.includes("cm-w-domain"), "…and paints the web");
    clickLayout(w1, "matrix");
    assert(w1.els["cm-matrix"].innerHTML === back, "matrix → web → matrix repaints byte-identically");
  }

  console.log("\n-- 4. a small graph still defaults to the web face --");
  {
    const tiny = tinyGraph();
    const wt = makeWorld();
    wt.CodeMap.load(tiny.name, tiny.nodes, tiny.relationships);
    assert(wt.els["cm-viewport"].innerHTML.includes("cm-w-domain"), "2-domain graph opens in the web");
    assert(wt.els["cm-matrix"].classList.contains("hidden"), "matrix overlay stays hidden");
    assert(!("ontoloom.cmLayout" in wt.store), "…still without writing a preference");
  }

  console.log("\n-- 5. lens drives the web: containment hides, layers flag red --");
  const w2 = makeWorld({ "ontoloom.cmLayout": "web" });
  w2.CodeMap.load(DATA.name, DATA.nodes, DATA.relationships);
  const domIds = [...nodes(w2).keys()].filter((id) => id !== "t0");
  {
    assert(w2.els["cm-viewport"].innerHTML.includes("cm-depweb"), "coupling lens (default) paints DEPENDS_ON lines");
    assert(!w2.els["cm-viewport"].innerHTML.includes("viol"), "…none red: domains carry no layer");
    clickLens(w2, "containment");
    assert(!w2.els["cm-viewport"].innerHTML.includes("cm-depweb"), "containment lens hides every DEPENDS_ON line");
    clickLens(w2, "layers");
    for (const id of domIds) clickNode(w2, id); // units (which carry layers) into view
    const html = w2.els["cm-viewport"].innerHTML;
    const viol = (html.match(/cm-depweb viol/g) || []).length;
    assert(viol === 5, `layers lens flags exactly the 5 outward unit→unit edges red (got ${viol})`);
    for (const id of domIds) clickNode(w2, id); // fold back
    clickLens(w2, "coupling");
  }

  console.log("\n-- 6. physics/spread: live, deterministic, reversible --");
  {
    // Pristine worlds: no clicks/selection, so the paint is a pure
    // function of (visible slice, spread, pins).
    const wa = makeWorld({ "ontoloom.cmLayout": "web" });
    wa.CodeMap.load(DATA.name, DATA.nodes, DATA.relationships);
    const html1 = wa.els["cm-viewport"].innerHTML;
    const d1 = meanPairDist(nodes(wa));
    slidePhys(wa, 1.8);
    await sleep(300); // past the 120ms reseed debounce
    const html18 = wa.els["cm-viewport"].innerHTML;
    const d18 = meanPairDist(nodes(wa));
    assert(html18 !== html1, "moving the slider changes the painted layout");
    assert(d18 > d1 * 1.25, `1.8× spread loosens the picture (mean pair distance ${d1.toFixed(0)} → ${d18.toFixed(0)}px)`);
    assert(sepViolations(nodes(wa)) === 0, "no min-separation violations at 1.8× spread");

    // deterministic across worlds: an independent session lands on the
    // exact same spread picture
    const wb = makeWorld({ "ontoloom.cmLayout": "web" });
    wb.CodeMap.load(DATA.name, DATA.nodes, DATA.relationships);
    slidePhys(wb, 1.8);
    await sleep(300);
    assert(wb.els["cm-viewport"].innerHTML === html18, "same spread in a fresh world paints byte-identical SVG");

    // reversible: back to 1× restores the seeded deterministic layout
    slidePhys(wa, 1.0);
    await sleep(300);
    assert(wa.els["cm-viewport"].innerHTML === html1, "sliding back to 1× restores the seeded layout byte-identically");
  }

  console.log("\n-- 7. drill = clean local cluster, at every depth, no stacking --");
  {
    const w4 = makeWorld({ "ontoloom.cmLayout": "web" });
    w4.CodeMap.load(DATA.name, DATA.nodes, DATA.relationships);
    let pos = nodes(w4);
    // H10 directive re-check: nothing below the domain level is in view.
    assert(![...pos.values()].some((p) => /cm-w-file|cm-w-sym|cm-w-unit/.test(p.cls)),
      "load shows domains only — no file/symbol/unit free-floaters");

    // Drill ONE domain: its children ring it — near the parent, not soup.
    const doms = [...pos.keys()].filter((id) => id !== "t0");
    const before = new Set(pos.keys());
    clickNode(w4, doms[0]);
    pos = nodes(w4);
    const par = pos.get(doms[0]);
    const kids = [...pos.keys()].filter((id) => !before.has(id));
    assert(kids.length > 0, `drilling ${doms[0]} revealed ${kids.length} children`);
    let maxD = 0;
    for (const id of kids) {
      const p = pos.get(id);
      maxD = Math.max(maxD, Math.hypot(p.x - par.x, p.y - par.y));
    }
    assert(maxD < 350, `children orbit their parent (max ${maxD.toFixed(0)}px), not the global soup`);
    assert(stackMax(pos, 14) === 0, "no two nodes within 14px after the drill");
    clickNode(w4, doms[0]);

    // The mess scenario: EVERY domain drilled, then EVERY unit (files
    // depth, 670 nodes), then one file down to symbols. At no depth do
    // dots stack or violate min separation. (Pre-H11 the 96-pass budget
    // left 29 residual violations at the files depth.)
    for (const id of doms) clickNode(w4, id);
    pos = nodes(w4);
    assert(sepViolations(pos) === 0 && stackMax(pos, 14) === 0,
      `all domains drilled (${pos.size} nodes): zero violations, zero stacking`);
    const units = [...pos.keys()].filter((id) => /cm-w-unit/.test(pos.get(id).cls));
    for (const id of units) clickNode(w4, id);
    pos = nodes(w4);
    assert(pos.size > 600, `all units drilled reaches the files depth (${pos.size} nodes)`);
    assert(sepViolations(pos) === 0, "files depth: ZERO min-separation violations (was 29 residuals pre-H11)");
    assert(stackMax(pos, 14) === 0, "files depth: no node has ANY neighbor within 14px — nothing stacks");
    const fileId = [...pos.keys()].find((id) => /cm-w-file/.test(pos.get(id).cls) && pos.get(id).cls);
    clickNode(w4, fileId);
    pos = nodes(w4);
    assert(sepViolations(pos) === 0 && stackMax(pos, 14) === 0,
      `file drilled to symbols (${pos.size} nodes): still zero violations, zero stacking`);
  }

  console.log(failures ? `\n${failures} FAILURES` : "\nALL ASSERTIONS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
