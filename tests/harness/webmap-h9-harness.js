/* H9 headless harness — collision resolution + drag-to-reposition pins.
 *
 * Runs the real /Users/jag/geist/ontoloom-h9/web/codemap.js in a vm sandbox
 * with a DOM stub, drives it with the real eShop hierarchy, and asserts:
 *   1. web mode: distinct positions + NO OVERLAP at the domains LOD
 *   2. no overlap at the domains+units LOD (min-separation honored)
 *   3. determinism — two fresh runs paint byte-identical web SVG
 *   4. click-to-expand still works after the pointer changes (web + tree)
 *   5. pin-drag: dragging a node moves THAT node (canvas does not pan),
 *      the drop position sticks exactly through the post-drop re-settle,
 *      the pin is persisted to localStorage, and a pinring is painted
 *   6. pin survives re-render (level away + back) and a FRESH world seeded
 *      with the same localStorage (position restored on load)
 *   7. double-click unpins (ring gone, storage updated, sim control back)
 *   8. canvas drag still pans (no node under the pointer)
 *   9. neighbors respect a pin: no visible node overlaps the pinned node
 *  10. tree mode: right-side labels never reach the next column's x
 *  11. keyboard: Enter still toggles; arrows move+pin the focused node
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
      _attrs: {},
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
function clickLevel(w, d) {
  fire(w.els["cm-levels"], "click", { target: { closest: () => ({ dataset: { d: String(d) } }) } });
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
// Drag: pointerdown on the node, a couple of moves past the 4px threshold,
// then pointerup. dxs/dys are SCREEN deltas.
function dragNode(w, tid, dx, dy) {
  fire(w.els["cm-wrap"], "pointerdown", { target: nodeTarget(tid), clientX: 100, clientY: 100, pointerId: 1 });
  fire(w.els["cm-wrap"], "pointermove", { clientX: 100 + dx / 2, clientY: 100 + dy / 2, pointerId: 1 });
  fire(w.els["cm-wrap"], "pointermove", { clientX: 100 + dx, clientY: 100 + dy, pointerId: 1 });
  fire(w.els["cm-wrap"], "pointerup", { target: emptyTarget(), clientX: 100 + dx, clientY: 100 + dy, pointerId: 1 });
}
function dragCanvas(w, dx, dy) {
  fire(w.els["cm-wrap"], "pointerdown", { target: emptyTarget(), clientX: 100, clientY: 100, pointerId: 1 });
  fire(w.els["cm-wrap"], "pointermove", { clientX: 100 + dx, clientY: 100 + dy, pointerId: 1 });
  fire(w.els["cm-wrap"], "pointerup", { target: emptyTarget(), clientX: 100 + dx, clientY: 100 + dy, pointerId: 1 });
}
function dblclickNode(w, tid) {
  fire(w.els["cm-wrap"], "dblclick", { target: nodeTarget(tid) });
}
// data-id -> {x, y, r} parsed straight out of the painted SVG string
function nodes(w) {
  const out = new Map();
  const re = /<g class="cm-node[^"]*" data-id="([^"]+)"[^>]*transform="translate\((-?[\d.]+),(-?[\d.]+)\)">(?:<circle class="selring"[^>]*\/>)?<circle class="dot" r="([\d.]+)"/g;
  let m;
  while ((m = re.exec(w.els["cm-viewport"].innerHTML))) {
    out.set(m[1], { x: parseFloat(m[2]), y: parseFloat(m[3]), r: parseFloat(m[4]) });
  }
  return out;
}
function shownCount(w) {
  return parseInt(w.els["cm-visible"].textContent.replace(/,/g, ""), 10);
}
function currentZoom(w) {
  // vp transform: translate(x,y) scale(k)
  const t = w.els["cm-viewport"]._attrs.transform || "";
  const m = /scale\((-?[\d.]+)\)/.exec(t);
  return m ? parseFloat(m[1]) : 1;
}
const SEP_PAD = 12; // must match WEB.sepPad in codemap.js
function overlapCount(pos, exceptId) {
  const list = [...pos.entries()];
  let bad = 0;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (exceptId && list[i][0] !== exceptId && list[j][0] !== exceptId) continue;
      const a = list[i][1], b = list[j][1];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d + 1e-6 < a.r + b.r + SEP_PAD) bad++;
    }
  }
  return bad;
}
function overlapCountAll(pos) {
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

/* ==================================================================== */
console.log("\n-- 1. web mode, domains LOD: distinct positions, no overlap --");
const w1 = makeWorld();
w1.CodeMap.load(DATA.name, DATA.nodes, DATA.relationships);
clickLayout(w1, "web");
const webHtml1 = w1.els["cm-viewport"].innerHTML;
let pos = nodes(w1);
assert(pos.size === shownCount(w1), `every shown node painted (${pos.size} of ${shownCount(w1)})`);
assert(overlapCountAll(pos) === 0, `no pair violates min separation at domains LOD (${pos.size} nodes)`);

console.log("\n-- 2. no overlap at domains+units LOD (the bead's LOD) --");
clickLevel(w1, 2);
const posU = nodes(w1);
assert(posU.size > pos.size, `Units LOD shows more nodes (${pos.size} -> ${posU.size})`);
{
  const bad = overlapCountAll(posU);
  assert(bad === 0, `no pair violates min separation at domains+units LOD (${posU.size} nodes, ${bad} overlaps)`);
  const seen = new Set();
  let dup = 0;
  for (const [, p] of posU) { const k = p.x + "," + p.y; if (seen.has(k)) dup++; seen.add(k); }
  assert(dup === 0, "all positions distinct at units LOD");
}
clickLevel(w1, 1);

console.log("\n-- 3. determinism: two fresh runs, byte-identical web SVG --");
const w2 = makeWorld();
w2.CodeMap.load(DATA.name, DATA.nodes, DATA.relationships);
clickLayout(w2, "web");
assert(w2.els["cm-viewport"].innerHTML === webHtml1, "independent fresh runs paint byte-identical web SVG");

console.log("\n-- 4. click-to-expand survives the pointer changes --");
const domId = [...pos.keys()].find((id) => id !== "t0");
{
  const before = new Set(pos.keys());
  clickNode(w1, domId);
  const after = nodes(w1);
  const freshIds = [...after.keys()].filter((id) => !before.has(id));
  assert(freshIds.length > 0, `web mode: clicking ${domId} expanded ${freshIds.length} children`);
  clickNode(w1, domId);
  assert(nodes(w1).size === pos.size, "web mode: second click collapses back");
  // tree mode too
  clickLayout(w1, "tree");
  const treeBefore = nodes(w1).size;
  clickNode(w1, domId);
  assert(nodes(w1).size > treeBefore, "tree mode: click-to-expand still works");
  clickNode(w1, domId);
  assert(nodes(w1).size === treeBefore, "tree mode: click-to-collapse still works");
  clickLayout(w1, "web");
}

console.log("\n-- 5. pin-drag: node moves, sticks exactly, persists, ring painted --");
const k1 = currentZoom(w1);
const start = nodes(w1).get(domId);
dragNode(w1, domId, 120, 80); // screen deltas
const expected = { x: start.x + 120 / k1, y: start.y + 80 / k1 };
{
  const p = nodes(w1).get(domId);
  const err = Math.hypot(p.x - expected.x, p.y - expected.y);
  assert(err < 0.02, `dragged node sits exactly at the drop point after re-settle (err ${err.toFixed(3)}px)`);
  const zoomAfter = currentZoom(w1);
  assert(Math.abs(zoomAfter - k1) < 1e-9, "node drag did not pan/zoom the canvas");
  const pinKey = Object.keys(w1.store).find((k) => k.startsWith("ontoloom.cmPins."));
  assert(!!pinKey, "pin persisted to a per-graph localStorage key");
  const saved = pinKey ? JSON.parse(w1.store[pinKey]) : {};
  assert(domId in saved, `saved pin entry keyed by node id (${domId})`);
  const gRe = new RegExp(`<g class="cm-node[^"]*pinned[^"]*" data-id="${domId}"[\\s\\S]*?</g>`);
  const gm = gRe.exec(w1.els["cm-viewport"].innerHTML);
  assert(!!gm && gm[0].includes("pinring"), "pinned node carries the visual pin ring");
  assert(!!gm && gm[0].includes(", pinned"), "aria-label announces the pinned state");
}

console.log("\n-- 6. pin survives re-render and a fresh load from storage --");
{
  clickLevel(w1, 2); // away…
  clickLevel(w1, 1); // …and back: full re-sim of the same slice
  const p = nodes(w1).get(domId);
  const err = Math.hypot(p.x - expected.x, p.y - expected.y);
  assert(err < 0.02, `pin holds through level-change re-render (err ${err.toFixed(3)}px)`);

  // fresh world, same storage: position must be restored on load
  const w4 = makeWorld(Object.assign({ "ontoloom.cmLayout": "web" }, w1.store));
  w4.CodeMap.load(DATA.name, DATA.nodes, DATA.relationships);
  const p4 = nodes(w4).get(domId);
  const err4 = Math.hypot(p4.x - expected.x, p4.y - expected.y);
  assert(err4 < 0.02, `fresh session restores the pinned position from localStorage (err ${err4.toFixed(3)}px)`);
  assert(nodes(w4).size === pos.size, "restored session shows the same slice");

  // 9. neighbors respect the pin: nothing overlaps the pinned node
  const bad = overlapCount(nodes(w4), domId);
  assert(bad === 0, "no visible node overlaps the pinned node after re-settle");
}

console.log("\n-- 7. double-click unpins --");
{
  dblclickNode(w1, domId);
  const pinKey = Object.keys(w1.store).find((k) => k.startsWith("ontoloom.cmPins."));
  const saved = pinKey && w1.store[pinKey] ? JSON.parse(w1.store[pinKey]) : {};
  assert(!(domId in saved), "unpin removes the stored pin");
  const gRe = new RegExp(`<g class="cm-node[^"]*" data-id="${domId}"[\\s\\S]*?</g>`);
  const gm = gRe.exec(w1.els["cm-viewport"].innerHTML);
  assert(!!gm && !gm[0].includes("pinring"), "pin ring disappears on unpin");
}

console.log("\n-- 8. canvas drag still pans --");
{
  const before = w1.els["cm-viewport"]._attrs.transform;
  const nodesBefore = JSON.stringify([...nodes(w1)].slice(0, 3));
  dragCanvas(w1, 55, -30);
  const after = w1.els["cm-viewport"]._attrs.transform;
  assert(before !== after, "empty-canvas drag changes the pan transform");
  assert(nodesBefore === JSON.stringify([...nodes(w1)].slice(0, 3)), "empty-canvas drag moves no node");
}

console.log("\n-- 10. tree mode: right labels stay out of the next column --");
{
  const w5 = makeWorld({ "ontoloom.cmLayout": "tree" });
  w5.CodeMap.load(DATA.name, DATA.nodes, DATA.relationships);
  clickLevel(w5, 4); // everything expanded: files collapsed nowhere, symbols visible
  const html = w5.els["cm-viewport"].innerHTML;
  // every right-anchored label: x position + estimated text width must stay
  // left of the next column. Parse <g …translate(X,_)>…<text class="lbl" x="LX" …>NAME<
  const re = /<g class="cm-node[^"]*"[^>]*transform="translate\((-?[\d.]+),(-?[\d.]+)\)">(?:<circle[^>]*\/>)*<circle class="dot"[^>]*\/>(?:<circle[^>]*\/>)?<text class="lbl" x="(-?[\d.]+)"[^>]*>([^<]*)/g;
  const COLS = [0, 130, 350, 590, 810];
  let m, checked = 0, spill = 0;
  while ((m = re.exec(html))) {
    const gx = parseFloat(m[1]);
    const lx = parseFloat(m[3]);
    if (lx < 0) continue; // left-anchored labels have their own guard
    const nextCol = COLS.find((c) => c > gx + 1);
    if (nextCol === undefined) continue; // last column: nothing to the right
    checked++;
    const w = m[4].length * 7; // same estimate the renderer uses
    if (gx + lx + w > nextCol - 4) spill++;
  }
  // Most symbols sit in the LAST column (skipped: nothing to their right),
  // so the measurable population is the collapsed/leaf nodes upstream.
  assert(checked >= 50, `right-anchored labels measured (${checked})`);
  assert(spill === 0, `no right label reaches the next column (${spill} spills)`);
}

console.log("\n-- 11. keyboard: Enter toggles; arrows move + pin --");
{
  const w6 = makeWorld({ "ontoloom.cmLayout": "web" });
  w6.CodeMap.load(DATA.name, DATA.nodes, DATA.relationships);
  const dom = [...nodes(w6).keys()].find((id) => id !== "t0");
  const before = nodes(w6).size;
  const keyTarget = { closest: (sel) => (sel === ".cm-node" ? { dataset: { id: dom } } : null) };
  fire(w6.els["cm-svg"], "keydown", { key: "Enter", target: keyTarget, preventDefault() {} });
  assert(nodes(w6).size > before, "Enter on a focused node still expands");
  fire(w6.els["cm-svg"], "keydown", { key: "Enter", target: keyTarget, preventDefault() {} });
  assert(nodes(w6).size === before, "Enter again still collapses");
  const p0 = nodes(w6).get(dom);
  fire(w6.els["cm-svg"], "keydown", { key: "ArrowRight", target: keyTarget, preventDefault() {} });
  const p1 = nodes(w6).get(dom);
  assert(Math.abs(p1.x - (p0.x + 12)) < 0.02 && Math.abs(p1.y - p0.y) < 0.02, "ArrowRight nudges the node 12px");
  const pinKey = Object.keys(w6.store).find((k) => k.startsWith("ontoloom.cmPins."));
  assert(!!pinKey && dom in JSON.parse(w6.store[pinKey]), "keyboard nudge pins + persists");
  fire(w6.els["cm-svg"], "keydown", { key: "p", target: keyTarget, preventDefault() {} });
  const saved = w6.store[pinKey] ? JSON.parse(w6.store[pinKey]) : {};
  assert(!(dom in saved), "P unpins the focused node");
}

console.log("\n-- 12. symbols LOD: full-scale sim + collision pass timing --");
{
  const w7 = makeWorld({ "ontoloom.cmLayout": "web" });
  w7.CodeMap.load(DATA.name, DATA.nodes, DATA.relationships);
  const t0 = Date.now();
  clickLevel(w7, 4);
  const dt = Date.now() - t0;
  const posAll = nodes(w7);
  const seen = new Set();
  let dup = 0;
  for (const [, p] of posAll) { const k = p.x + "," + p.y; if (seen.has(k)) dup++; seen.add(k); }
  assert(posAll.size > 3000, `symbols level lays out the full graph (${posAll.size} nodes)`);
  assert(dup === 0, "distinct positions hold at full scale");
  assert(dt < 20000, `full-scale sim + collision pass + paint in ${dt}ms`);
  console.log(`     (full sim+paint: ${dt}ms for ${posAll.size} nodes)`);
}

console.log(failures ? `\n${failures} FAILURES` : "\nALL ASSERTIONS PASSED");
process.exit(failures ? 1 : 0);
