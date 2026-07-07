/* Headless harness for the H7 web (force-directed) layout in codemap.js.
 *
 * Runs the real web/codemap.js in an isolated vm sandbox with a DOM stub,
 * drives it with the real eShop hierarchy, and asserts:
 *   1. web layout assigns DISTINCT positions to every visible node
 *   2. determinism — two independent runs produce byte-identical SVG
 *   3. expanding a node spawns its children NEAR the parent
 *   4. toggling web -> tree round-trips to the identical tree layout
 *   5. level buttons / search / deps toggle work in web mode
 *   6. domains form clusters (members sit nearest their own hub)
 *   7. localStorage persistence of the chosen mode
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

/* ---- DOM stub world, one per isolated run ---- */
function makeWorld(storageSeed) {
  const store = Object.assign({ "ontoloom.cmTourDone": "1" }, storageSeed || {});
  function stubEl(id) {
    return {
      id,
      _listeners: {},
      innerHTML: "",
      textContent: "",
      value: "",
      hidden: false,
      dataset: {},
      style: {},
      classList: {
        _set: new Set(id === "cm-tour" ? ["hidden"] : []),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        toggle(c, on) { on ? this._set.add(c) : this._set.delete(c); },
        contains(c) { return this._set.has(c); },
      },
      addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
      setAttribute() {},
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
    "cm-search", "cm-match-count", "cm-levels", "cm-fit", "cm-deps", "cm-help",
    "cm-layout", "cm-tour", "cm-tour-title", "cm-tour-body", "cm-tour-dots",
    "cm-tour-back", "cm-tour-next", "cm-tour-skip",
  ];
  const els = {};
  for (const id of ids) els[id] = stubEl(id);

  const document = {
    getElementById: (id) => els[id] || stubEl(id),
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
function clickLevel(w, d) {
  fire(w.els["cm-levels"], "click", { target: { closest: () => ({ dataset: { d: String(d) } }) } });
}
function clickNode(w, tid) {
  const t = { closest: () => ({ dataset: { id: tid } }) };
  fire(w.els["cm-wrap"], "pointerdown", { target: t, clientX: 10, clientY: 10 });
  fire(w.els["cm-wrap"], "pointerup", { target: t, clientX: 10, clientY: 10 });
}
function positions(w) {
  // data-id -> {x, y} parsed straight out of the painted SVG string
  const out = new Map();
  const re = /<g class="cm-node[^"]*" data-id="([^"]+)"[^>]*transform="translate\((-?[\d.]+),(-?[\d.]+)\)"/g;
  let m;
  while ((m = re.exec(w.els["cm-viewport"].innerHTML))) {
    out.set(m[1], { x: parseFloat(m[2]), y: parseFloat(m[3]) });
  }
  return out;
}
function shownCount(w) {
  return parseInt(w.els["cm-visible"].textContent.replace(/,/g, ""), 10);
}

/* ==================================================================== */
console.log("\n-- 1. distinct positions for every visible node (web mode) --");
const w1 = makeWorld();
w1.CodeMap.load(DATA.name, DATA.nodes, DATA.relationships);
const treeHtmlBefore = w1.els["cm-viewport"].innerHTML;
clickLayout(w1, "web");
const webHtml1 = w1.els["cm-viewport"].innerHTML;
let pos = positions(w1);
assert(pos.size === shownCount(w1), `every shown node painted (${pos.size} of ${shownCount(w1)})`);
{
  const seen = new Set();
  let dup = 0;
  for (const [, p] of pos) {
    const k = p.x + "," + p.y;
    if (seen.has(k)) dup++;
    seen.add(k);
  }
  assert(dup === 0, `all ${pos.size} visible nodes hold distinct positions`);
}
assert(webHtml1.includes("cm-depweb"), "DEPENDS_ON drawn as solid web lines");
assert(webHtml1.includes("cm-dep-count"), "dep lines carry count labels");
assert(webHtml1.includes("cm-weblink"), "containment drawn as faint links");
assert(w1.store["ontoloom.cmLayout"] === "web", "chosen mode persisted to localStorage");

console.log("\n-- 2. determinism: independent run, identical picture --");
const w2 = makeWorld();
w2.CodeMap.load(DATA.name, DATA.nodes, DATA.relationships);
const w2TreeHtml = w2.els["cm-viewport"].innerHTML;
clickLayout(w2, "web");
assert(w2.els["cm-viewport"].innerHTML === webHtml1, "two fresh runs paint byte-identical web SVG");

console.log("\n-- 3. expand: children spawn near their parent --");
const domId = [...pos.keys()].find((id) => id !== "t0"); // first domain
const before = new Set(pos.keys());
const parentBefore = pos.get(domId);
clickNode(w1, domId);
const pos2 = positions(w1);
const fresh = [...pos2.keys()].filter((id) => !before.has(id));
assert(fresh.length > 0, `expanding ${domId} revealed ${fresh.length} children`);
{
  const par = pos2.get(domId);
  let maxD = 0, sum = 0;
  for (const id of fresh) {
    const p = pos2.get(id);
    const d = Math.hypot(p.x - par.x, p.y - par.y);
    sum += d;
    if (d > maxD) maxD = d;
  }
  const mean = sum / fresh.length;
  assert(mean < 260, `children settle near the parent (mean ${mean.toFixed(1)}px, max ${maxD.toFixed(1)}px)`);
  const drift = Math.hypot(par.x - parentBefore.x, par.y - parentBefore.y);
  assert(drift < 200, `existing layout barely shifts on incremental expand (parent drift ${drift.toFixed(1)}px)`);
}
// collapse back — the visible set matches step 1 again
clickNode(w1, domId);
assert(positions(w1).size === pos.size, "collapse returns to the previous visible set");

console.log("\n-- 4. toggle round-trip: web -> tree is byte-identical tree --");
// On the untouched world (no clicks in between that would change selection):
clickLayout(w2, "tree");
assert(w2.els["cm-viewport"].innerHTML === w2TreeHtml, "tree layout after round-trip === original tree layout (byte-identical)");
assert(w2.store["ontoloom.cmLayout"] === "tree", "mode persistence follows the toggle");
clickLayout(w1, "tree"); // w1 continues in tree mode (selection changed there, so no byte compare)
void treeHtmlBefore;

console.log("\n-- 5. level buttons, search, deps toggle in web mode --");
clickLayout(w1, "web");
clickLevel(w1, 2); // Units
const posUnits = positions(w1);
assert(posUnits.size > pos.size, `Units level shows more nodes in web mode (${pos.size} -> ${posUnits.size})`);
{
  const seen = new Set();
  let dup = 0;
  for (const [, p] of posUnits) { const k = p.x + "," + p.y; if (seen.has(k)) dup++; seen.add(k); }
  assert(dup === 0, "distinct positions hold at the Units level");
}
// deps toggle off removes the solid lines
fire(w1.els["cm-deps"], "click", {});
assert(!w1.els["cm-viewport"].innerHTML.includes("cm-depweb"), "deps toggle hides DEPENDS_ON lines in web mode");
fire(w1.els["cm-deps"], "click", {});
assert(w1.els["cm-viewport"].innerHTML.includes("cm-depweb"), "deps toggle brings them back");

clickLevel(w1, 1); // back to Domains
fire(w1.els["cm-search"], "input", { target: { value: "RedisBasketRepository" } });
const searchDone = new Promise((res) => setTimeout(res, 300));

console.log("\n-- 6. domains form clusters --");
const w3 = makeWorld({ "ontoloom.cmLayout": "web" });
w3.CodeMap.load(DATA.name, DATA.nodes, DATA.relationships);
assert(positions(w3).size === pos.size, "persisted web mode: fresh load opens straight into the web");
clickLevel(w3, 3); // Files: domains + units + files, the cluster-readability LOD
const posF = positions(w3);
{
  // hubs = the domain nodes; members = everything deeper. A member counts
  // as "well clustered" when its nearest domain hub is its own ancestor.
  const treeHtml = w3.els["cm-viewport"].innerHTML;
  // recover each node's domain by re-walking CodeMap's own expansion state
  // via aria-labels: instead, use geometry over w3-internal ids — the tree
  // ids are deterministic (t0 root, domains in build order), so map members
  // to hubs through the drawn containment links.
  const links = [];
  const re = /<line class="cm-weblink[^"]*" x1="(-?[\d.]+)" y1="(-?[\d.]+)" x2="(-?[\d.]+)" y2="(-?[\d.]+)"/g;
  let m;
  while ((m = re.exec(treeHtml))) links.push(m.slice(1).map(parseFloat));
  assert(links.length > 500, `containment links drawn at Files LOD (${links.length})`);

  // hub for every node: BFS over painted links from each domain position
  const hubs = [];
  const byPos = new Map();
  for (const [id, p] of posF) byPos.set(p.x + "," + p.y, id);
  // domain ids are the direct children of t0 in paint order; find them via
  // links that touch t0's position
  const rootP = posF.get("t0");
  const parentOf = new Map();
  for (const [x1, y1, x2, y2] of links) {
    const a = byPos.get(x1 + "," + y1), b = byPos.get(x2 + "," + y2);
    if (a && b) parentOf.set(b, a);
  }
  function hubOf(id) {
    let cur = id, guard = 0;
    while (parentOf.has(cur) && parentOf.get(cur) !== "t0" && guard++ < 10) cur = parentOf.get(cur);
    return parentOf.get(cur) === "t0" ? cur : null;
  }
  const hubIds = new Set();
  for (const id of posF.keys()) { const h = hubOf(id); if (h) hubIds.add(h); }
  let good = 0, total = 0;
  for (const id of posF.keys()) {
    const own = hubOf(id);
    if (!own || own === id || id === "t0") continue;
    const p = posF.get(id);
    let best = null, bestD = Infinity;
    for (const h of hubIds) {
      const hp = posF.get(h);
      const d = Math.hypot(p.x - hp.x, p.y - hp.y);
      if (d < bestD) { bestD = d; best = h; }
    }
    total++;
    if (best === own) good++;
  }
  const fracV = total ? good / total : 0;
  assert(fracV > 0.7, `domain clustering: ${(fracV * 100).toFixed(1)}% of members sit nearest their own domain hub (${good}/${total})`);
}

console.log("\n-- 7. symbols LOD: scale + timing --");
const t0 = Date.now();
clickLevel(w3, 4);
const dtBig = Date.now() - t0;
const posAll = positions(w3);
{
  const seen = new Set();
  let dup = 0;
  for (const [, p] of posAll) { const k = p.x + "," + p.y; if (seen.has(k)) dup++; seen.add(k); }
  assert(posAll.size > 3000, `symbols level lays out the full graph (${posAll.size} nodes)`);
  assert(dup === 0, "distinct positions hold at full scale");
  assert(dtBig < 15000, `full-scale web sim + paint completed in ${dtBig}ms`);
  console.log(`     (full sim+paint: ${dtBig}ms for ${posAll.size} nodes)`);
}

searchDone.then(() => {
  console.log("\n-- 8. search in web mode --");
  const html = w1.els["cm-viewport"].innerHTML;
  assert(html.includes("match"), "search marks matches in web mode");
  assert(html.includes("dim"), "search dims non-matches in web mode");
  assert(html.includes("RedisBasketRepository"), "search auto-expanded the path to the match");

  console.log(failures ? `\n${failures} FAILURES` : "\nALL ASSERTIONS PASSED");
  process.exit(failures ? 1 : 0);
});
