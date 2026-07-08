/* Headless harness: run web/codemap.js against the real eShop hierarchy and
 * assert the drill-down data handling (detect / lazy expand / search / detail).
 * H10: drill-down is the ONLY navigation (no bulk expand-to-level buttons)
 * and the web layout is the default face of the map. */
"use strict";
const fs = require("fs");
const path = require("path");

function stubEl(id) {
  return {
    id,
    _listeners: {},
    innerHTML: "",
    textContent: "",
    value: "",
    dataset: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, on) { on ? this._set.add(c) : this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    setAttribute() {},
    getBoundingClientRect() { return { width: 1200, height: 800, left: 0, top: 0 }; },
    setPointerCapture() {},
    querySelectorAll() { return []; },
  };
}

const els = {};
for (const id of ["cm-wrap", "cm-svg", "cm-viewport", "cm-detail", "cm-stats", "cm-visible", "cm-search", "cm-levels", "cm-fit"]) {
  els[id] = stubEl(id);
}
global.document = {
  // Auto-create stubs for ids added after this harness was written (tour, deps, layout…)
  getElementById: (id) => (els[id] || (els[id] = stubEl(id))),
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  activeElement: null,
};
global.window = global;
global.localStorage = {
  _s: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; },
};
global.requestAnimationFrame = (fn) => fn();

const src = fs.readFileSync(path.join(__dirname, "..", "..", "web", "codemap.js"), "utf8");
eval(src);

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "eshop-hierarchy.ontoloom.json"), "utf8"));

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok  " + msg);
  else { failures++; console.log("  FAIL " + msg); }
}

// 1. Detection
assert(CodeMap.detect(data.nodes, data.relationships) === true, "detects the eShop hierarchy");
const manual = [
  { id: "n1", labels: ["Concept"], caption: "Knowledge Graph", properties: {} },
  { id: "n2", labels: ["Tool"], caption: "Ontoloom", properties: {} },
];
assert(CodeMap.detect(manual, [{ type: "RELATED_TO", from: "n1", to: "n2" }]) === false,
  "does not detect a manual-editor graph");
assert(CodeMap.detect([], []) === false, "empty graph is not a hierarchy");

// 2. Load: starts collapsed at the domain level, in WEB mode by default
CodeMap.load(data.name, data.nodes, data.relationships);
const shown0 = parseInt(els["cm-visible"].textContent.replace(/,/g, ""), 10);
assert(shown0 >= 22 && shown0 <= 25, `starts collapsed near the domain level (${shown0} shown, expected root + ~22 domains)`);
assert(els["cm-viewport"].innerHTML.includes("cm-node"), "renders nodes into the SVG viewport");
assert(els["cm-viewport"].innerHTML.includes("cm-w-domain"),
  "fresh load (no stored preference) paints the WEB layout by default");
assert(els["cm-stats"].innerHTML.includes("3,270") === false, "stats are per level, not total"); // sanity
assert(els["cm-stats"].innerHTML.includes("21") && els["cm-stats"].innerHTML.includes("2,685"),
  "stats strip shows 21 domains and 2,685 symbols");

// 3. Lazy expand: clicking a domain reveals ONLY its direct children (units)
// H9 moved node clicks to pointerdown/pointerup on cm-wrap (drag support);
// drive the same event path a real pointer takes.
function fire(el, type, ev) { for (const fn of el._listeners[type] || []) fn(ev); }
function clickNode(tid) {
  fire(els["cm-wrap"], "pointerdown", {
    target: { closest: (sel) => (sel === ".cm-node" ? { dataset: { id: tid } } : null) },
    clientX: 10, clientY: 10, pointerId: 1,
  });
  fire(els["cm-wrap"], "pointerup", { target: { closest: () => null }, clientX: 10, clientY: 10, pointerId: 1 });
}
// t0 = synthesized root, t1 = first domain (Animation)
clickNode("t1");
const shown1 = parseInt(els["cm-visible"].textContent.replace(/,/g, ""), 10);
assert(shown1 > shown0, `expanding a domain adds nodes (${shown0} -> ${shown1})`);
assert(shown1 - shown0 <= 5, `...but only its direct unit children, not the subtree (added ${shown1 - shown0})`);
assert(els["cm-detail"].innerHTML.includes("domain") && els["cm-detail"].innerHTML.toLowerCase().includes("animation"),
  "inspector shows the clicked domain");
assert(els["cm-detail"].innerHTML.includes("symbol kinds"), "inspector shows the symbol-kind mix");
assert(els["cm-detail"].innerHTML.includes("depends on"), "inspector shows DEPENDS_ON coupling chips");

// clicking again collapses
clickNode("t1");
const shown2 = parseInt(els["cm-visible"].textContent.replace(/,/g, ""), 10);
assert(shown2 === shown0, `clicking again collapses back (${shown2} === ${shown0})`);

// 4. Search opens the path to matches
const searchFn = els["cm-search"]._listeners.input[0];
searchFn({ target: { value: "RedisBasketRepository" } });
setTimeout(() => {
  const html = els["cm-viewport"].innerHTML;
  assert(html.includes("match"), "search marks matches");
  assert(html.includes("dim"), "search dims non-matches");
  const shown3 = parseInt(els["cm-visible"].textContent.replace(/,/g, ""), 10);
  assert(shown3 > shown0, `search auto-expanded the path to the match (${shown3} shown)`);
  assert(html.includes("RedisBasketRepository"), "the matched file is now visible");

  // clearing the search keeps the expanded state but clears the dim
  searchFn({ target: { value: "" } });
  setTimeout(() => {
    assert(!els["cm-viewport"].innerHTML.includes('cm-node dim'), "clearing search removes dimming");

    // 5. Drill-only navigation (H10): the bulk expand-to-level buttons are
    // gone from BOTH surfaces — clicking nodes is the only way deeper.
    assert(!src.includes("cm-levels"), "codemap.js carries no level-button wiring");
    const indexHtml = fs.readFileSync(path.join(__dirname, "..", "..", "web", "index.html"), "utf8");
    assert(!/data-d="/.test(indexHtml) && !indexHtml.includes('id="cm-levels"'),
      "index.html carries no Domains/Units/Files/Symbols buttons");
    assert(!(els["cm-levels"]._listeners.click || []).length,
      "nothing listens on the old levels group");

    // Drill deeper by clicking: search left RedisBasketRepository's path
    // open, so fold the whole map back down node by node instead — every
    // domain click collapses its entire subtree.
    const openDomains = [];
    const gRe = /<g class="cm-node[^"]*" data-id="(t\d+)"[^>]*aria-label="[^"]*, domain"[^>]*aria-expanded="true"/g;
    let gm;
    while ((gm = gRe.exec(els["cm-viewport"].innerHTML))) openDomains.push(gm[1]);
    for (const id of openDomains) clickNode(id);
    const shownFolded = parseInt(els["cm-visible"].textContent.replace(/,/g, ""), 10);
    assert(shownFolded === shown0, `clicking each open domain folds the map back to ${shown0} (got ${shownFolded})`);

    // …and a two-level drill works: domain click reveals units, unit click
    // reveals files (fresh nodes carry the ids to click next).
    clickNode("t1");
    const freshRe = /<g class="cm-node[^"]*fresh[^"]*" data-id="(t\d+)"/;
    const unitId = (freshRe.exec(els["cm-viewport"].innerHTML) || [])[1];
    assert(!!unitId, "expanding a domain paints fresh unit nodes to drill into");
    const beforeUnit = parseInt(els["cm-visible"].textContent.replace(/,/g, ""), 10);
    clickNode(unitId);
    const afterUnit = parseInt(els["cm-visible"].textContent.replace(/,/g, ""), 10);
    assert(afterUnit > beforeUnit, `clicking a unit drills to its files (${beforeUnit} -> ${afterUnit})`);
    clickNode("t1"); // collapsing the domain folds the whole branch
    const shownEnd = parseInt(els["cm-visible"].textContent.replace(/,/g, ""), 10);
    assert(shownEnd === shown0, `collapsing the domain folds the drilled branch (back to ${shownEnd})`);

    console.log(failures ? `\n${failures} FAILURES` : "\nALL ASSERTIONS PASSED");
    process.exit(failures ? 1 : 0);
  }, 250);
}, 250);
