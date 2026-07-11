/* Headless harness for the web (force-directed) layout in codemap.js.
 *
 * Runs the real web/codemap.js in an isolated vm sandbox with a DOM stub,
 * drives it with the real eShop hierarchy, and asserts:
 *   1. WEB IS THE DEFAULT: a fresh load (no stored preference) paints the
 *      web layout, with distinct positions for every visible node
 *   2. determinism — two independent runs produce byte-identical SVG
 *   3. a stored "tree" preference is still honored on load
 *   4. expanding a node spawns its children NEAR the parent
 *   5. mode toggle round-trips (web -> tree -> web byte-identical web)
 *      and persists the choice
 *   6. drill-down + search + deps toggle work in web mode (drilling every
 *      domain is the only bulk-ish gesture left — no level buttons exist)
 *   7. domains form clusters at the files depth (reached by search, the
 *      only legitimate mass-open: "." matches every file's name/path)
 *   8. full-scale: cumulative searches open thousands of nodes; positions
 *      stay distinct and NON-FADED labels never overlap (priority fade)
 *   9. search marks + dims + auto-expands in web mode
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
function clickNode(w, tid) {
  const t = { closest: () => ({ dataset: { id: tid } }) };
  fire(w.els["cm-wrap"], "pointerdown", { target: t, clientX: 10, clientY: 10 });
  fire(w.els["cm-wrap"], "pointerup", { target: t, clientX: 10, clientY: 10 });
}
async function search(w, q) {
  fire(w.els["cm-search"], "input", { target: { value: q } });
  await sleep(260); // past the 160ms debounce
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
/* Label boxes (same estimate the renderer uses: 7px/char, 18px line) for
 * the VISIBLE (non-faded) labels in the painted web SVG. */
function visibleLabelBoxes(w) {
  const out = [];
  const gRe = /<g class="(cm-node[^"]*)" data-id="([^"]+)"[^>]*transform="translate\((-?[\d.]+),(-?[\d.]+)\)">([\s\S]*?)<\/g>/g;
  let m;
  while ((m = gRe.exec(w.els["cm-viewport"].innerHTML))) {
    if (/\blblfade\b/.test(m[1])) continue;
    const inner = m[5];
    const txt = /<text class="lbl" x="(-?[\d.]+)"[^>]*>([\s\S]*?)<\/text>/.exec(inner);
    if (!txt) continue;
    const x = parseFloat(m[3]), y = parseFloat(m[4]);
    const lx = parseFloat(txt[1]);
    const chars = txt[2].replace(/<[^>]+>/g, "").length;
    out.push({ id: m[2], x0: x + lx, x1: x + lx + chars * 7, y0: y - 9, y1: y + 9 });
  }
  return out;
}
function labelOverlapPairs(boxes) {
  let bad = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) bad++;
    }
  }
  return bad;
}

/* ==================================================================== */
(async () => {
  console.log("\n-- 1. web face: distinct positions for every visible node --");
  // Seeded web preference: dense graphs like eShop default to the MATRIX
  // face since H11 (covered by webmap-h11-harness.js) — this harness
  // audits the web sim itself.
  const w1 = makeWorld({ "ontoloom.cmLayout": "web" });
  w1.CodeMap.load(DATA.name, DATA.nodes, DATA.relationships);
  const webHtml1 = w1.els["cm-viewport"].innerHTML;
  assert(webHtml1.includes("cm-w-domain"), "stored web preference opens in WEB mode");
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

  console.log("\n-- 2. determinism: independent run, identical picture --");
  const w2 = makeWorld({ "ontoloom.cmLayout": "web" });
  w2.CodeMap.load(DATA.name, DATA.nodes, DATA.relationships);
  assert(w2.els["cm-viewport"].innerHTML === webHtml1, "two fresh runs paint byte-identical web SVG");

  console.log("\n-- 3. a stored 'tree' preference is honored --");
  {
    const wt = makeWorld({ "ontoloom.cmLayout": "tree" });
    wt.CodeMap.load(DATA.name, DATA.nodes, DATA.relationships);
    const html = wt.els["cm-viewport"].innerHTML;
    assert(!html.includes("cm-w-domain") && html.includes("cm-edge"),
      "seeded tree preference: fresh load opens the tidy tree");
  }

  console.log("\n-- 4. expand: children spawn near their parent --");
  const domId = [...pos.keys()].find((id) => id !== "t0"); // first domain
  {
    const before = new Set(pos.keys());
    const parentBefore = pos.get(domId);
    clickNode(w1, domId);
    const pos2 = positions(w1);
    const fresh = [...pos2.keys()].filter((id) => !before.has(id));
    assert(fresh.length > 0, `expanding ${domId} revealed ${fresh.length} children`);
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
    // collapse back — the visible set matches step 1 again
    clickNode(w1, domId);
    assert(positions(w1).size === pos.size, "collapse returns to the previous visible set");
  }

  console.log("\n-- 5. toggle round-trip: web -> tree -> web, persisted --");
  {
    clickLayout(w2, "tree");
    assert(w2.store["ontoloom.cmLayout"] === "tree", "choosing tree persists");
    const treeHtml = w2.els["cm-viewport"].innerHTML;
    assert(treeHtml.includes("cm-edge") && !treeHtml.includes("cm-w-domain"), "tree paints the tidy tree");
    clickLayout(w2, "web");
    assert(w2.store["ontoloom.cmLayout"] === "web", "…and back to web persists");
    assert(w2.els["cm-viewport"].innerHTML === webHtml1, "web after round-trip === original web (byte-identical)");
    clickLayout(w2, "tree");
    assert(w2.els["cm-viewport"].innerHTML === treeHtml, "tree after round-trip === original tree (byte-identical)");
  }

  console.log("\n-- 6. drill-down + containment/coupling lens in web mode (no level buttons exist) --");
  {
    // Drilling every domain open is the only way to see all units — click
    // by click, exactly what a user does.
    const domIds = [...pos.keys()].filter((id) => id !== "t0");
    for (const id of domIds) clickNode(w1, id);
    const posUnits = positions(w1);
    assert(posUnits.size > pos.size, `drilling every domain shows the units (${pos.size} -> ${posUnits.size})`);
    const seen = new Set();
    let dup = 0;
    for (const [, p] of posUnits) { const k = p.x + "," + p.y; if (seen.has(k)) dup++; seen.add(k); }
    assert(dup === 0, "distinct positions hold with every domain drilled open");
    // the containment lens hides the coupling arcs; coupling restores them
    const clickLens = (l) =>
      fire(w1.els["cm-lens"], "click", { target: { closest: () => ({ dataset: { l } }) } });
    clickLens("containment");
    assert(!w1.els["cm-viewport"].innerHTML.includes("cm-depweb"), "containment lens hides DEPENDS_ON lines in web mode");
    clickLens("coupling");
    assert(w1.els["cm-viewport"].innerHTML.includes("cm-depweb"), "coupling lens brings them back");
    // fold everything back down
    for (const id of domIds) clickNode(w1, id);
    assert(positions(w1).size === pos.size, "drilled domains fold back to the domains view");
  }

  console.log("\n-- 7. domains form clusters at the files depth (opened by search) --");
  const w3 = makeWorld({ "ontoloom.cmLayout": "web" });
  w3.CodeMap.load(DATA.name, DATA.nodes, DATA.relationships);
  assert(positions(w3).size === pos.size, "persisted web mode: fresh load opens straight into the web");
  // "." matches every file (name/path carry extensions), so search opens the
  // path to all of them — the one legitimate mass-open left. Clearing the
  // search keeps the expansion.
  await search(w3, ".");
  await search(w3, "");
  const posF = positions(w3);
  assert(posF.size > 500, `search-opened files depth shows the bulk of the tree (${posF.size} nodes)`);
  {
    const treeHtml = w3.els["cm-viewport"].innerHTML;
    const links = [];
    const re = /<line class="cm-weblink[^"]*" x1="(-?[\d.]+)" y1="(-?[\d.]+)" x2="(-?[\d.]+)" y2="(-?[\d.]+)"/g;
    let m;
    while ((m = re.exec(treeHtml))) links.push(m.slice(1).map(parseFloat));
    assert(links.length > 500, `containment links drawn at the files depth (${links.length})`);

    // hub for every node: walk painted links upward from each position
    const byPos = new Map();
    for (const [id, p] of posF) byPos.set(p.x + "," + p.y, id);
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

  console.log("\n-- 8. full scale via cumulative searches: distinct + faded-label guarantee --");
  {
    const t0 = Date.now();
    for (const q of ["e", "a", "o", "i"]) await search(w3, q); // symbols matching open their files
    await search(w3, "");
    const dtBig = Date.now() - t0;
    const posAll = positions(w3);
    const seen = new Set();
    let dup = 0;
    for (const [, p] of posAll) { const k = p.x + "," + p.y; if (seen.has(k)) dup++; seen.add(k); }
    assert(posAll.size > 3000, `cumulative searches opened the bulk of the graph (${posAll.size} nodes)`);
    assert(dup === 0, "distinct positions hold at full scale");
    const boxes = visibleLabelBoxes(w3);
    const bad = labelOverlapPairs(boxes);
    assert(bad === 0, `no two VISIBLE labels overlap at full scale (${boxes.length} visible of ${posAll.size}; priority fade covers the rest)`);
    assert(dtBig < 60000, `full-scale sims + paints completed in ${dtBig}ms`);
    console.log(`     (full-scale: ${dtBig}ms, ${posAll.size} nodes, ${boxes.length} visible labels)`);
  }

  console.log("\n-- 9. search in web mode --");
  await search(w1, "RedisBasketRepository");
  {
    const html = w1.els["cm-viewport"].innerHTML;
    assert(html.includes("match"), "search marks matches in web mode");
    assert(html.includes("dim"), "search dims non-matches in web mode");
    assert(html.includes("RedisBasketRepository"), "search auto-expanded the path to the match");
  }

  console.log(failures ? `\n${failures} FAILURES` : "\nALL ASSERTIONS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
