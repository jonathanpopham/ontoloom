/* Headless harness: run web/codemap.js against the real eShop hierarchy and
 * assert the drill-down data handling (detect / lazy expand / search / detail). */
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
  getElementById: (id) => els[id],
  querySelectorAll: () => [],
};
global.window = global;
global.requestAnimationFrame = (fn) => fn();

const src = fs.readFileSync("/Users/jag/geist/ontoloom-ui/web/codemap.js", "utf8");
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

// 2. Load: starts collapsed at the domain level
CodeMap.load(data.name, data.nodes, data.relationships);
const shown0 = parseInt(els["cm-visible"].textContent.replace(/,/g, ""), 10);
assert(shown0 >= 22 && shown0 <= 25, `starts collapsed near the domain level (${shown0} shown, expected root + ~22 domains)`);
assert(els["cm-viewport"].innerHTML.includes("cm-node"), "renders nodes into the SVG viewport");
assert(els["cm-stats"].innerHTML.includes("3,270") === false, "stats are per level, not total"); // sanity
assert(els["cm-stats"].innerHTML.includes("21") && els["cm-stats"].innerHTML.includes("2,685"),
  "stats strip shows 21 domains and 2,685 symbols");

// 3. Lazy expand: clicking a domain reveals ONLY its direct children (units)
const click = els["cm-viewport"]._listeners.click[0];
function clickNode(tid) {
  click({ target: { closest: () => ({ dataset: { id: tid } }) } });
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

    // 5. Level filter = expand-all-to-depth (simulate the Symbols button by
    // walking every level button handler path through search-free render)
    const levels = els["cm-levels"]._listeners.click[0];
    // stub the button lookup used inside the handler
    global.document.querySelectorAll = () => [];
    levels({ target: { closest: () => ({ dataset: { d: "4" } }) } });
    const shownAll = parseInt(els["cm-visible"].textContent.replace(/,/g, ""), 10);
    assert(shownAll > 3000, `Symbols level filter expands everything (${shownAll} nodes laid out & rendered)`);

    levels({ target: { closest: () => ({ dataset: { d: "1" } }) } });
    const shownBack = parseInt(els["cm-visible"].textContent.replace(/,/g, ""), 10);
    assert(shownBack === shown0, `Domains level filter collapses back to ${shown0}`);

    console.log(failures ? `\n${failures} FAILURES` : "\nALL ASSERTIONS PASSED");
    process.exit(failures ? 1 : 0);
  }, 250);
}, 250);
