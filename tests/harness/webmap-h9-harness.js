/* H9/H10 headless harness — collision resolution (dots AND labels) +
 * drag-to-reposition pins.
 *
 * Runs the real ../../web/codemap.js in a vm sandbox with a DOM stub,
 * drives it with the real eShop hierarchy, and asserts:
 *   1. web mode (the default on load): distinct positions + NO dot overlap
 *      + ZERO overlapping label boxes at the domains view
 *   2. one-drilled-level (every domain clicked open): no dot overlap and
 *      ZERO overlapping label boxes among VISIBLE (non-faded) labels —
 *      the H10 gate; was 63 overlapping pairs before label-aware separation
 *   3. determinism — two fresh runs paint byte-identical web SVG
 *   4. click-to-expand works in web + tree (drill-down is the ONLY nav)
 *   5. pin-drag: dragging a node moves THAT node (canvas does not pan),
 *      the drop position sticks exactly through the post-drop re-settle,
 *      the pin is persisted to localStorage, and a pinring is painted
 *   6. pin survives re-render (drill another domain open + closed) and a
 *      FRESH world seeded with the same localStorage
 *   7. double-click unpins (ring gone, storage updated, sim control back)
 *   8. canvas drag still pans (no node under the pointer)
 *   9. neighbors respect a pin: no visible node overlaps the pinned node
 *  10. tree mode, deep drill on real data: dynamic columns + 24px rows —
 *      no label box touches another node's label or dot (2px margin)
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
    "cm-search", "cm-match-count", "cm-fit", "cm-deps", "cm-help",
    "cm-layout", "cm-tour", "cm-tour-title", "cm-tour-body", "cm-tour-dots",
    "cm-tour-back", "cm-tour-next", "cm-tour-skip",
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
async function search(w, q) {
  fire(w.els["cm-search"], "input", { target: { value: q } });
  await sleep(260); // past the 160ms debounce
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
/* Label boxes (renderer's own estimate: 7px/char, 18px line) parsed from
 * the painted SVG. Faded labels (.lblfade) are invisible → excluded when
 * skipFaded; anchor="end" (tree left labels) extend leftward. */
function labelBoxes(w, skipFaded) {
  const out = [];
  const gRe = /<g class="(cm-node[^"]*)" data-id="([^"]+)"[^>]*transform="translate\((-?[\d.]+),(-?[\d.]+)\)">([\s\S]*?)<\/g>/g;
  let m;
  while ((m = gRe.exec(w.els["cm-viewport"].innerHTML))) {
    if (skipFaded && /\blblfade\b/.test(m[1])) continue;
    const inner = m[5];
    const txt = /<text class="lbl" x="(-?[\d.]+)"[^>]*>([\s\S]*?)<\/text>/.exec(inner);
    const dot = /<circle class="dot" r="([\d.]+)"/.exec(inner);
    if (!txt || !dot) continue;
    const x = parseFloat(m[3]), y = parseFloat(m[4]);
    const lx = parseFloat(txt[1]);
    const chars = txt[2].replace(/<[^>]+>/g, "").length;
    const end = inner.slice(inner.indexOf("<text")).includes('text-anchor="end"');
    const w7 = chars * 7;
    out.push({
      id: m[2],
      r: parseFloat(dot[1]),
      x, y,
      x0: end ? x + lx - w7 : x + lx,
      x1: end ? x + lx : x + lx + w7,
      y0: y - 9,
      y1: y + 9,
    });
  }
  return out;
}
function labelOverlapPairs(boxes, margin) {
  const g = margin || 0;
  let bad = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.x0 - g < b.x1 && b.x0 - g < a.x1 && a.y0 - g < b.y1 && b.y0 - g < a.y1) bad++;
    }
  }
  return bad;
}

/* ==================================================================== */
(async () => {
  console.log("\n-- 1. web face, domains view: distinct dots, no dot OR label overlap --");
  // Seeded web preference: dense graphs default to the MATRIX face since
  // H11 (webmap-h11-harness.js covers that) — this harness audits the sim.
  const w1 = makeWorld({ "ontoloom.cmLayout": "web" });
  w1.CodeMap.load(DATA.name, DATA.nodes, DATA.relationships);
  const webHtml1 = w1.els["cm-viewport"].innerHTML;
  assert(webHtml1.includes("cm-w-domain"), "stored web preference opens in web mode");
  let pos = nodes(w1);
  assert(pos.size === shownCount(w1), `every shown node painted (${pos.size} of ${shownCount(w1)})`);
  assert(overlapCountAll(pos) === 0, `no pair violates min dot separation at the domains view (${pos.size} nodes)`);
  {
    const boxes = labelBoxes(w1, true);
    const bad = labelOverlapPairs(boxes, 0);
    assert(bad === 0, `ZERO overlapping label boxes at the domains view (${boxes.length} visible labels)`);
  }

  console.log("\n-- 2. one-drilled-level (every domain open): the H10 label gate --");
  const domIds = [...pos.keys()].filter((id) => id !== "t0");
  for (const id of domIds) clickNode(w1, id);
  const posU = nodes(w1);
  assert(posU.size > pos.size, `drilling every domain shows more nodes (${pos.size} -> ${posU.size})`);
  {
    const bad = overlapCountAll(posU);
    assert(bad === 0, `no pair violates min dot separation with every domain drilled (${posU.size} nodes, ${bad} overlaps)`);
    const seen = new Set();
    let dup = 0;
    for (const [, p] of posU) { const k = p.x + "," + p.y; if (seen.has(k)) dup++; seen.add(k); }
    assert(dup === 0, "all positions distinct at the drilled level");
    const boxes = labelBoxes(w1, true);
    const lbad = labelOverlapPairs(boxes, 0);
    assert(lbad === 0, `ZERO overlapping VISIBLE label boxes one level drilled (${boxes.length} visible labels; was 63 pairs pre-H10)`);
    const total = labelBoxes(w1, false).length;
    console.log(`     (${boxes.length}/${total} labels visible after separation + priority fade)`);
  }
  for (const id of domIds) clickNode(w1, id); // fold back to the domains view
  assert(nodes(w1).size === pos.size, "drilled domains fold back to the domains view");

  console.log("\n-- 3. determinism: two fresh runs, byte-identical web SVG --");
  const w2 = makeWorld({ "ontoloom.cmLayout": "web" });
  w2.CodeMap.load(DATA.name, DATA.nodes, DATA.relationships);
  assert(w2.els["cm-viewport"].innerHTML === webHtml1, "independent fresh runs paint byte-identical web SVG");

  console.log("\n-- 4. click-to-expand survives (drill-down is the only nav) --");
  const domId = domIds[0];
  {
    const before = new Set(nodes(w1).keys());
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
    // Re-render the slice the drill-only way: open another domain, close it.
    const other = domIds[1];
    clickNode(w1, other); // away…
    clickNode(w1, other); // …and back: full re-sim of the same slice
    const p = nodes(w1).get(domId);
    const err = Math.hypot(p.x - expected.x, p.y - expected.y);
    assert(err < 0.02, `pin holds through drill-open/close re-render (err ${err.toFixed(3)}px)`);

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

  console.log("\n-- 10. tree mode, deep drill: dynamic columns, labels never touch --");
  {
    const w5 = makeWorld({ "ontoloom.cmLayout": "tree" });
    w5.CodeMap.load(DATA.name, DATA.nodes, DATA.relationships);
    // Deep drill on real data: "." matches every file (extensions live in
    // names/paths), search opens the paths, clearing keeps them open.
    await search(w5, ".");
    await search(w5, "");
    const boxes = labelBoxes(w5, false); // tree never fades — audit ALL labels
    assert(boxes.length > 600, `deep-drilled tree paints the full files depth (${boxes.length} labels)`);
    // Label-vs-label: no two label boxes intersect even with 2px margin.
    const lbad = labelOverlapPairs(boxes, 2);
    assert(lbad === 0, `no two tree labels touch at the files depth, 2px margin (${lbad} pairs)`);
    // Label-vs-dot: nobody's text runs under another node's circle.
    let dotBad = 0;
    for (const a of boxes) {
      for (const b of boxes) {
        if (a === b) continue;
        const bx0 = b.x - b.r - 2, bx1 = b.x + b.r + 2;
        const by0 = b.y - b.r - 2, by1 = b.y + b.r + 2;
        if (a.x0 < bx1 && bx0 < a.x1 && a.y0 < by1 && by0 < a.y1) dotBad++;
      }
    }
    assert(dotBad === 0, `no tree label runs under another node's dot (${dotBad} hits)`);
    // Row rhythm: within a COLUMN (same depth) nodes sit ≥ 24px apart, so
    // 18px label boxes always keep ≥ 6px of air line to line. (Across
    // columns parents sit at child midpoints — the box checks above cover
    // those.)
    const byCol = new Map();
    for (const b of boxes) {
      const arr = byCol.get(b.x);
      if (arr) arr.push(b.y);
      else byCol.set(b.x, [b.y]);
    }
    let minGap = Infinity;
    for (const ys of byCol.values()) {
      ys.sort((a, b) => a - b);
      for (let i = 1; i < ys.length; i++) minGap = Math.min(minGap, ys[i] - ys[i - 1]);
    }
    assert(minGap >= 24, `same-column rows keep the 24px rhythm (min gap ${minGap}px)`);
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

  console.log(failures ? `\n${failures} FAILURES` : "\nALL ASSERTIONS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
