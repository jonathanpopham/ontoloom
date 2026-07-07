/*
 * Ontoloom code map — a lazy drill-down viewer for TrailTracker-style
 * hierarchy graphs (gs-H5 big-graph rendering + gs-H2 lazy click-to-expand).
 *
 * A hierarchy graph marks every node with properties.view === "hierarchy" and
 * a level of domain / unit / file / symbol. CONTAINS edges bind the levels
 * together (domain→file, unit→file, file→symbol) and DEPENDS_ON edges carry
 * domain/unit coupling. Because a file has two CONTAINS parents (its domain
 * and its unit), the viewer synthesizes the drill path Domain → Unit → File
 * → Symbol by grouping each domain's files by their unit.
 *
 * The big-graph strategy: the viewer never renders the whole graph. It keeps
 * one collapse bit per tree node and lays out + draws only the expanded
 * slice, so a 20k-node repo stays a ~10-node picture until you drill in.
 * Everything starts collapsed at the domain level; clicking a node expands
 * only its direct children, never the whole subtree.
 *
 * Vanilla JS, no dependencies, airgap-safe — same rules as the rest of the
 * Ontoloom front-end. This file only reads the graph; it never mutates the
 * editor's nodes/relationships, so switching back to the manual editor is
 * always lossless.
 *
 * Determinism + user pins: every untouched node keeps the seeded
 * deterministic layout (hash-seeded starts, fixed tick budgets, ordered
 * iteration, no Math.random) — the same graph in the same expansion state
 * always paints the same picture. Dragging a node in web mode PINS it: the
 * sim holds it exactly where the user dropped it while springs keep pulling
 * its neighbors. Pins are user state layered ON TOP of the deterministic
 * layout — persisted per graph in localStorage (key derived from the graph
 * name + node/edge counts, value keyed by tree node id) and never consulted
 * for unpinned nodes, so clearing the pins restores the seeded layout
 * exactly. Double-click (or the P key) unpins and hands the node back to
 * the sim.
 */
"use strict";

(function () {
  const DOMAIN_HUES = [
    "#5b8def", "#7cc4a4", "#b98bd9", "#e0b15f", "#67c0d0",
    "#d97aa6", "#8fb069", "#d98b6a", "#9aa6ff", "#c9b458",
  ];
  const KIND_COLOR = { T: "var(--cm-type)", F: "var(--cm-func)", C: "var(--cm-const)" };
  const KIND_LABEL = { T: "type", F: "function", C: "const" };
  const COL = [0, 130, 350, 590, 810]; // x column per depth: root..symbol
  const ROW = 19;                      // vertical rhythm of the tidy tree

  /* ---- DOM handles (all inside the #codemap subtree; the manual editor's
   *      DOM is never touched from here) ---- */
  const wrap = document.getElementById("cm-wrap");
  const svg = document.getElementById("cm-svg");
  const vp = document.getElementById("cm-viewport");
  const detail = document.getElementById("cm-detail");
  const statsEl = document.getElementById("cm-stats");
  const visibleEl = document.getElementById("cm-visible");
  const searchInput = document.getElementById("cm-search");
  const matchCountEl = document.getElementById("cm-match-count");

  const EMPTY_DETAIL =
    `<div class="empty-hint"><span class="glyph" aria-hidden="true">◎</span>` +
    `click a node to expand it and inspect it here</div>`;

  /* ---- State ---- */
  let root = null;      // synthesized tree (root → domains → units → files → symbols)
  let byId = {};        // tree id -> tree node
  let realById = {};    // wire node id -> wire node
  let deps = {};        // wire node id -> [{id, count}] from DEPENDS_ON
  let matchSet = null;  // search results (tree nodes), null = no active search
  let selectedId = null;
  let showDeps = true;  // draw DEPENDS_ON arcs between visible nodes
  let T = { x: 60, y: 40, k: 1 }; // pan/zoom transform
  let prevShown = new Set(); // tree ids drawn in the previous frame → "fresh" fade-in

  /* ---- Web (force-directed) layout state ---- */
  const LAYOUT_KEY = "ontoloom.cmLayout";
  let layoutMode = "tree"; // "tree" | "web" — persisted across sessions
  try { if (localStorage.getItem(LAYOUT_KEY) === "web") layoutMode = "web"; } catch (_) {}
  let webPos = new Map(); // tree id -> {x, y} settled force-sim position
  let webSig = "";        // signature of the visible set the sim last ran for
  let webAnim = 0;        // settle-animation token; bump to cancel a running one
  let webPins = new Map(); // tree id -> {x, y} user-pinned positions (drag-to-move)
  let pinsKey = "";        // localStorage key for the current graph's pins
  let webShown = null;     // last-painted web slice (for cheap drag repaints)
  let webEdges = null;

  function prop(n, key) {
    return n && n.properties && typeof n.properties === "object" ? n.properties[key] : undefined;
  }
  function level(n) { return prop(n, "level"); }

  /* ====================================================================
   * Detection — is this wire graph a code hierarchy?
   * ================================================================== */
  function detect(nodes, rels) {
    if (!Array.isArray(nodes) || nodes.length < 2) return false;
    const LV = { domain: true, unit: true, file: true, symbol: true };
    let hier = 0;
    for (const n of nodes) {
      if (prop(n, "view") === "hierarchy" && LV[level(n)]) hier++;
    }
    // Most of the graph must carry hierarchy markers, and the tree edges
    // must exist — otherwise this is just an ontology that happens to have
    // a "view" property somewhere.
    if (hier < 2 || hier < nodes.length * 0.5) return false;
    return (rels || []).some((r) => r.type === "CONTAINS");
  }

  /* ====================================================================
   * Tree building
   * ================================================================== */
  function symbolKind(n) {
    const k = String(prop(n, "symbol_kind") || "");
    if (/^func/i.test(k)) return "F";
    if (/^const/i.test(k)) return "C";
    if (/^type/i.test(k)) return "T";
    const labels = Array.isArray(n.labels) ? n.labels : [];
    if (labels.includes("Function")) return "F";
    if (labels.includes("Constant")) return "C";
    if (labels.includes("Type")) return "T";
    return "F";
  }

  function buildTree(name, nodes, rels) {
    realById = {};
    deps = {};
    byId = {};
    for (const n of nodes) realById[n.id] = n;

    const kidsOf = {};    // CONTAINS: parent id -> [child ids]
    const parentsOf = {}; // CONTAINS: child id -> [parent ids]
    for (const r of rels) {
      if (r.type === "CONTAINS") {
        (kidsOf[r.from] = kidsOf[r.from] || []).push(r.to);
        (parentsOf[r.to] = parentsOf[r.to] || []).push(r.from);
      } else if (r.type === "DEPENDS_ON") {
        (deps[r.from] = deps[r.from] || []).push({ id: r.to, count: prop(r, "count") });
      }
    }

    // Real unit nodes by caption, for linking synthetic per-domain unit groups
    // back to their wire node (layer, DEPENDS_ON, ...).
    const unitByName = {};
    for (const n of nodes) {
      if (level(n) === "unit") unitByName[n.caption || prop(n, "unit") || n.id] = n;
    }

    let seq = 0;
    function tnode(type, label, real, depth, extra) {
      const t = Object.assign(
        { id: "t" + seq++, type, name: label, real: real || null, depth, children: [], _collapsed: false },
        extra || {}
      );
      byId[t.id] = t;
      return t;
    }

    root = tnode("root", name || "Code map", null, 0);

    // Infrastructure groups (properties.kind === "infrastructure": the named
    // homes TrailTracker gives scaffold/docs/generated/root files — Build &
    // Tooling, Documentation, Generated, Repo root, each with a `reason`)
    // render muted and stay collapsed when the level buttons expand the map,
    // so the colored circles remain the story of what the software DOES.
    // Click one and it opens like any other domain.
    const INFRA_COLOR = "#6b7793";

    const domTree = new Map(); // domain wire id -> tree node
    let hueIdx = 0;
    for (const d of nodes) {
      if (level(d) !== "domain") continue;
      const infra = prop(d, "kind") === "infrastructure";
      const t = tnode("domain", d.caption || d.id, d, 1, {
        color: infra ? INFRA_COLOR : DOMAIN_HUES[hueIdx++ % DOMAIN_HUES.length],
        infra,
      });
      domTree.set(d.id, t);
      root.children.push(t);
    }
    let ungrouped = null; // legacy graphs only: files with no domain parent

    const unitTree = new Map(); // domainTreeId + "\0" + unitName -> tree node
    for (const f of nodes) {
      if (level(f) !== "file") continue;
      const parents = (parentsOf[f.id] || []).map((p) => realById[p]);
      const domReal = parents.find((p) => p && level(p) === "domain");
      let domT = domReal ? domTree.get(domReal.id) : null;
      if (!domT) {
        if (!ungrouped) {
          ungrouped = tnode("domain", "(ungrouped)", null, 1, { color: "#6b7793" });
          root.children.push(ungrouped);
        }
        domT = ungrouped;
      }
      const unitReal =
        parents.find((p) => p && level(p) === "unit") || unitByName[prop(f, "unit")] || null;
      const unitName = (unitReal && unitReal.caption) || prop(f, "unit") || "(no unit)";
      const key = domT.id + "\u0000" + unitName;
      let unitT = unitTree.get(key);
      if (!unitT) {
        unitT = tnode("unit", unitName, unitReal, 2);
        unitTree.set(key, unitT);
        domT.children.push(unitT);
      }
      const fileT = tnode("file", f.caption || f.id, f, 3, { path: String(prop(f, "path") || "") });
      unitT.children.push(fileT);
      for (const sid of kidsOf[f.id] || []) {
        const s = realById[sid];
        if (!s || level(s) !== "symbol") continue;
        fileT.children.push(tnode("sym", s.caption || s.id, s, 4, { kind: symbolKind(s) }));
      }
      fileT.children.sort(
        (a, b) =>
          (Number(prop(a.real, "line")) || 0) - (Number(prop(b.real, "line")) || 0) ||
          a.name.localeCompare(b.name)
      );
    }

    for (const domT of root.children) {
      domT.children.sort((a, b) => a.name.localeCompare(b.name));
      for (const u of domT.children) u.children.sort((a, b) => a.name.localeCompare(b.name));
    }
    // Business domains keep wire order; infrastructure groups sink to the
    // bottom of the list (alphabetical among themselves).
    root.children.sort(
      (a, b) => (a.infra ? 1 : 0) - (b.infra ? 1 : 0) ||
        (a.infra && b.infra ? a.name.localeCompare(b.name) : 0)
    );
    rollup(root);
    return root;
  }

  // Bottom-up counts + symbol-kind mix, so every inspector metric is O(1).
  function rollup(n) {
    n.mix = { T: 0, F: 0, C: 0 };
    n.nunits = n.type === "unit" ? 1 : 0;
    n.nfiles = n.type === "file" ? 1 : 0;
    n.nsyms = 0;
    if (n.type === "sym") {
      n.nsyms = 1;
      n.mix[n.kind] = 1;
      return;
    }
    for (const c of n.children) {
      rollup(c);
      n.nunits += c.nunits;
      n.nfiles += c.nfiles;
      n.nsyms += c.nsyms;
      n.mix.T += c.mix.T;
      n.mix.F += c.mix.F;
      n.mix.C += c.mix.C;
    }
  }

  /* ====================================================================
   * Collapse state + layout (horizontal tidy tree over VISIBLE nodes only)
   * ================================================================== */
  function setDepth(d) {
    (function walk(n) {
      if (n.children.length) {
        // Infrastructure groups stay collapsed under bulk expansion — build
        // scripts and generated files are named, not noisy. A direct click
        // still opens them.
        n._collapsed = n.depth >= d || (n.type === "domain" && n.infra === true);
        n.children.forEach(walk);
      }
    })(root);
  }

  let yCursor = 0;
  function layout(n) {
    yCursor = 0;
    (function place(node) {
      node.x = COL[Math.min(node.depth, COL.length - 1)];
      const kids = node._collapsed || !node.children.length ? [] : node.children;
      if (!kids.length) {
        node.y = yCursor;
        yCursor += ROW;
      } else {
        kids.forEach(place);
        node.y = (kids[0].y + kids[kids.length - 1].y) / 2;
      }
    })(n);
  }

  /* ====================================================================
   * Web layout — a from-scratch force simulation over the VISIBLE nodes
   *
   * The tidy tree makes containment easy to read and relationships hard;
   * the web is the opposite trade. Forces:
   *   - repulsion between every visible pair (grid-bucketed with a cutoff
   *     radius, so it stays near-linear at the symbols LOD),
   *   - spring attraction along containment edges (short rest length —
   *     children hug their parent),
   *   - spring attraction along DEPENDS_ON edges (long rest length,
   *     strength scaled by ln(count) — heavy coupling pulls harder),
   *   - light gravity from every node toward its domain hub, so domains
   *     read as visual clusters, plus a whisper of centering on the hubs.
   *
   * Determinism: the start position of every node is seeded from a hash
   * of its identity (angle + radius, domains ring the pinned root), the
   * tick count is fixed, and there is no Math.random anywhere — the same
   * graph in the same expansion state always settles into the same
   * picture. Expanding a node is incremental: existing nodes keep their
   * settled positions, new children spawn beside their parent, and only
   * a short re-settle runs.
   * ================================================================== */
  const WEB = {
    cutoff: 240,        // repulsion radius (px) at normal LOD
    cutoffBig: 120,     // tighter radius once thousands of nodes are up
    repK: 28,           // repulsion gain: f = repK·qa·qb / d²
    q: { root: 30, domain: 46, unit: 14, file: 7, sym: 3 }, // charges
    rest: [0, 500, 100, 55, 26],      // containment rest length by child depth
    kc: [0, 0.03, 0.08, 0.1, 0.12],   // containment stiffness by child depth
    depRest: 340,       // DEPENDS_ON springs are long —
    depK: 0.004,        // — and weak per unit of ln(count)
    hubG: 0.05,         // per-tick pull toward the domain hub
    centerG: 0.008,     // per-tick pull of root/domains toward the origin
    fmax: 40,           // force clamp
    step: 30,           // displacement clamp per tick
    ticksFull: 300,     // fixed budget: fresh layout
    ticksBig: 120,      // fixed budget: fresh layout, thousands of nodes
    ticksIncr: 90,      // fixed budget: incremental expand
    bigN: 1200,
    animMaxN: 400,      // never animate the settle above this node count
    sepPad: 12,         // min-separation: label allowance beyond touching dots
    sepPasses: 24,      // constraint-relaxation passes after the sim settles
  };

  // One dot radius per node type — shared by both renderers and the
  // collision pass so "overlap" means the same thing everywhere.
  function nodeR(n) {
    return n.type === "root" ? 7 : n.type === "domain" ? 6 : n.type === "unit" ? 5 : n.type === "sym" ? 3 : 4;
  }

  // FNV-1a — the deterministic seed for every node's start position.
  function hash32(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  /* ---- Pin persistence: user-dragged positions, per graph ----
   * Tree ids are deterministic per graph build, so they are a stable key
   * for the same graph across sessions; a different graph hashes to a
   * different storage key and starts unpinned. */
  function pinsStorageKey(name, nodes, rels) {
    return (
      "ontoloom.cmPins." +
      hash32(String(name || "") + "|" + nodes.length + "|" + rels.length).toString(36)
    );
  }
  function loadPins() {
    webPins = new Map();
    if (!pinsKey) return;
    try {
      const raw = localStorage.getItem(pinsKey);
      if (!raw) return;
      const o = JSON.parse(raw);
      for (const k in o) {
        const x = Number(o[k][0]), y = Number(o[k][1]);
        if (Number.isFinite(x) && Number.isFinite(y)) webPins.set(k, { x, y });
      }
    } catch (_) { /* corrupt or unavailable storage — start unpinned */ }
  }
  function savePins() {
    if (!pinsKey) return;
    try {
      if (webPins.size) {
        const o = {};
        for (const [k, v] of webPins) o[k] = [r2(v.x), r2(v.y)];
        localStorage.setItem(pinsKey, JSON.stringify(o));
      } else if (typeof localStorage.removeItem === "function") {
        localStorage.removeItem(pinsKey);
      } else {
        localStorage.setItem(pinsKey, "{}");
      }
    } catch (_) { /* private mode — pins just don't persist */ }
  }

  // Visible slice + containment edges + each node's domain-hub index.
  function collectWeb() {
    const shown = [];
    const edges = [];
    const hubOf = [];
    (function walk(n, parent, hub) {
      const i = shown.length;
      shown.push(n);
      hubOf.push(n.depth === 1 ? i : hub);
      if (parent) edges.push([parent, n]);
      const kids = n._collapsed || !n.children.length ? [] : n.children;
      const myHub = n.depth === 1 ? i : hub;
      for (const k of kids) walk(k, n, myHub);
    })(root, null, -1);
    return { shown, edges, hubOf };
  }

  // Seed any node that has never been placed. Returns how many were new.
  function seedWeb(shown, edges) {
    const parentOf = new Map();
    for (const [p, c] of edges) parentOf.set(c.id, p);
    let fresh = 0;
    for (const n of shown) {
      if (webPos.has(n.id)) continue;
      fresh++;
      // A user pin trumps the hash seed — the node reappears exactly where
      // it was dropped, even on a fresh load of the same graph.
      const pin = webPins.get(n.id);
      if (pin) {
        webPos.set(n.id, { x: pin.x, y: pin.y });
        continue;
      }
      const h = hash32(n.name + "\u0000" + n.id);
      const ang = (h % 3600) * (Math.PI / 1800);
      if (n.depth === 0) {
        webPos.set(n.id, { x: 0, y: 0 }); // root is pinned at the origin
      } else if (n.depth === 1) {
        const rad = 320 + ((h >>> 12) % 120); // domains ring the root
        webPos.set(n.id, { x: Math.cos(ang) * rad, y: Math.sin(ang) * rad });
      } else {
        // Children spawn in a small deterministic scatter beside their
        // parent — an expand grows the web outward from where you clicked.
        const par = parentOf.get(n.id);
        const p = (par && webPos.get(par.id)) || { x: 0, y: 0 };
        const rad = 18 + ((h >>> 12) % 30);
        webPos.set(n.id, { x: p.x + Math.cos(ang) * rad, y: p.y + Math.sin(ang) * rad });
      }
    }
    return fresh;
  }

  function buildSprings(shown, edges) {
    const idx = new Map();
    shown.forEach((n, i) => idx.set(n.id, i));
    const springs = [];
    for (const [p, c] of edges) {
      const d = Math.min(c.depth, WEB.rest.length - 1);
      springs.push({ a: idx.get(p.id), b: idx.get(c.id), len: WEB.rest[d], k: WEB.kc[d] });
    }
    // DEPENDS_ON among visible wire-mapped nodes — same visibility rule as
    // the renderer, so what pulls is exactly what gets drawn.
    const wireToTree = {};
    for (const n of shown) {
      if (n.real && !(n.real.id in wireToTree)) wireToTree[n.real.id] = n;
    }
    for (const fromWire in deps) {
      const a = wireToTree[fromWire];
      if (!a) continue;
      for (const d of deps[fromWire]) {
        const b = wireToTree[d.id];
        if (!b || a === b) continue;
        const k = WEB.depK * (1 + Math.log(1 + (Number(d.count) || 1)));
        springs.push({ a: idx.get(a.id), b: idx.get(b.id), len: WEB.depRest, k });
      }
    }
    return springs;
  }

  // One force tick over parallel position arrays. Deterministic: fixed
  // iteration order, no randomness, pure function of the previous state.
  function webTick(px, py, qv, springs, hubOf, pinned, cutoff, alpha) {
    const n = px.length;
    const fx = new Float64Array(n);
    const fy = new Float64Array(n);
    const cut2 = cutoff * cutoff;

    // Repulsion, grid-bucketed: nodes only repel within the cutoff radius,
    // and only the 3×3 neighborhood of cells is scanned per node.
    const grid = new Map();
    const cx = new Int32Array(n);
    const cy = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      cx[i] = Math.floor(px[i] / cutoff);
      cy[i] = Math.floor(py[i] / cutoff);
      const key = cx[i] + ":" + cy[i];
      const cell = grid.get(key);
      if (cell) cell.push(i);
      else grid.set(key, [i]);
    }
    for (let i = 0; i < n; i++) {
      for (let gx = cx[i] - 1; gx <= cx[i] + 1; gx++) {
        for (let gy = cy[i] - 1; gy <= cy[i] + 1; gy++) {
          const cell = grid.get(gx + ":" + gy);
          if (!cell) continue;
          for (const j of cell) {
            if (j <= i) continue; // each pair once
            let dx = px[i] - px[j];
            let dy = py[i] - py[j];
            let d2 = dx * dx + dy * dy;
            if (d2 > cut2) continue;
            if (d2 < 1e-4) {
              // Coincident seeds: split them apart deterministically.
              dx = ((i * 31 + j * 7) % 13 - 6) * 0.17 || 0.61;
              dy = ((i * 17 + j * 11) % 13 - 6) * 0.17 || -0.43;
              d2 = dx * dx + dy * dy;
            }
            const inv = 1 / d2;
            let f = WEB.repK * qv[i] * qv[j] * inv;
            if (f > WEB.fmax) f = WEB.fmax;
            const d = Math.sqrt(d2);
            const ux = dx / d, uy = dy / d;
            fx[i] += ux * f; fy[i] += uy * f;
            fx[j] -= ux * f; fy[j] -= uy * f;
          }
        }
      }
    }

    // Springs: containment + DEPENDS_ON.
    for (const s of springs) {
      const dx = px[s.b] - px[s.a];
      const dy = py[s.b] - py[s.a];
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      let f = s.k * (d - s.len);
      if (f > WEB.fmax) f = WEB.fmax;
      else if (f < -WEB.fmax) f = -WEB.fmax;
      const ux = dx / d, uy = dy / d;
      fx[s.a] += ux * f; fy[s.a] += uy * f;
      fx[s.b] -= ux * f; fy[s.b] -= uy * f;
    }

    // Gravity: members toward their domain hub; hubs (and root) centered.
    for (let i = 0; i < n; i++) {
      const h = hubOf[i];
      if (h >= 0 && h !== i) {
        fx[i] += (px[h] - px[i]) * WEB.hubG;
        fy[i] += (py[h] - py[i]) * WEB.hubG;
      } else {
        fx[i] += -px[i] * WEB.centerG;
        fy[i] += -py[i] * WEB.centerG;
      }
    }

    // Integrate with a displacement clamp; the root never moves.
    for (let i = 0; i < n; i++) {
      if (pinned[i]) continue;
      let sx = fx[i] * alpha;
      let sy = fy[i] * alpha;
      if (sx > WEB.step) sx = WEB.step; else if (sx < -WEB.step) sx = -WEB.step;
      if (sy > WEB.step) sy = WEB.step; else if (sy < -WEB.step) sy = -WEB.step;
      px[i] += sx;
      py[i] += sy;
    }
  }

  // Min-separation constraint pass — the collision resolver. After the sim
  // settles, overlapping pairs are pushed apart until every pair keeps at
  // least (rA + rB + sepPad) between centers. Grid-bucketed like the
  // repulsion (cell size = the largest possible min-separation, so any
  // violating pair shares a 3×3 neighborhood) and fully deterministic:
  // fixed pass count, ascending index order, no randomness. Pinned nodes
  // (root + user pins) never move — their partner takes the full push.
  function resolveOverlaps(px, py, rv, pinned) {
    const n = px.length;
    let rMax = 0;
    for (let i = 0; i < n; i++) if (rv[i] > rMax) rMax = rv[i];
    const cell = rMax * 2 + WEB.sepPad;
    for (let pass = 0; pass < WEB.sepPasses; pass++) {
      const grid = new Map();
      const cx = new Int32Array(n);
      const cy = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        cx[i] = Math.floor(px[i] / cell);
        cy[i] = Math.floor(py[i] / cell);
        const key = cx[i] + ":" + cy[i];
        const b = grid.get(key);
        if (b) b.push(i);
        else grid.set(key, [i]);
      }
      let moved = false;
      for (let i = 0; i < n; i++) {
        for (let gx = cx[i] - 1; gx <= cx[i] + 1; gx++) {
          for (let gy = cy[i] - 1; gy <= cy[i] + 1; gy++) {
            const b = grid.get(gx + ":" + gy);
            if (!b) continue;
            for (const j of b) {
              if (j <= i) continue;
              if (pinned[i] && pinned[j]) continue;
              const minSep = rv[i] + rv[j] + WEB.sepPad;
              let dx = px[j] - px[i];
              let dy = py[j] - py[i];
              let d2 = dx * dx + dy * dy;
              if (d2 >= minSep * minSep) continue;
              if (d2 < 1e-4) {
                // Coincident pair: split deterministically, same recipe as
                // the repulsion tick.
                dx = ((i * 31 + j * 7) % 13 - 6) * 0.17 || 0.61;
                dy = ((i * 17 + j * 11) % 13 - 6) * 0.17 || -0.43;
                d2 = dx * dx + dy * dy;
              }
              const d = Math.sqrt(d2);
              const ux = dx / d, uy = dy / d;
              const push = minSep - d;
              if (pinned[i]) {
                px[j] += ux * push; py[j] += uy * push;
              } else if (pinned[j]) {
                px[i] -= ux * push; py[i] -= uy * push;
              } else {
                const h = push / 2;
                px[i] -= ux * h; py[i] -= uy * h;
                px[j] += ux * h; py[j] += uy * h;
              }
              moved = true;
            }
          }
        }
      }
      if (!moved) break; // converged early — deterministic either way
    }
  }

  // Geometric cooling: alpha at tick t of T total, from a0 down to aMin.
  function webAlpha(t, total) {
    const a0 = 0.6, aMin = 0.05;
    if (total <= 1) return aMin;
    return a0 * Math.pow(aMin / a0, t / (total - 1));
  }

  // Run (or animate) the sim for the current visible slice, then persist
  // the settled positions into webPos. Fixed tick budgets keep it
  // deterministic; the optional settle animation renders intermediate
  // frames but always lands on the same final state.
  function runWebSim(shown, edges, hubOf) {
    const n = shown.length;
    const fresh = seedWeb(shown, edges);
    const springs = buildSprings(shown, edges);
    const cutoff = n > WEB.bigN ? WEB.cutoffBig : WEB.cutoff;
    const ticks =
      fresh > n * 0.4
        ? (n > WEB.bigN ? WEB.ticksBig : WEB.ticksFull)
        : WEB.ticksIncr;

    const px = new Float64Array(n);
    const py = new Float64Array(n);
    const qv = new Float64Array(n);
    const rv = new Float64Array(n);
    const pinned = new Uint8Array(n);
    const QK = { root: WEB.q.root, domain: WEB.q.domain, unit: WEB.q.unit, file: WEB.q.file, sym: WEB.q.sym };
    for (let i = 0; i < n; i++) {
      const p = webPos.get(shown[i].id);
      px[i] = p.x;
      py[i] = p.y;
      qv[i] = QK[shown[i].type] || WEB.q.sym;
      rv[i] = nodeR(shown[i]);
      // Fixed nodes: the root (always at the origin) and user pins, held
      // exactly where they were dropped while springs pull their neighbors.
      const pin = webPins.get(shown[i].id);
      if (pin) { px[i] = pin.x; py[i] = pin.y; }
      pinned[i] = shown[i].depth === 0 || pin ? 1 : 0;
    }

    const commit = () => {
      for (let i = 0; i < n; i++) webPos.set(shown[i].id, { x: px[i], y: py[i] });
      for (let i = 0; i < n; i++) { shown[i].x = px[i]; shown[i].y = py[i]; }
    };
    // The last word after the sim: resolve residual overlaps, then commit.
    const finish = () => {
      resolveOverlaps(px, py, rv, pinned);
      commit();
    };

    const token = ++webAnim;
    const animate =
      n <= WEB.animMaxN &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: no-preference)").matches;

    if (!animate) {
      for (let t = 0; t < ticks; t++) webTick(px, py, qv, springs, hubOf, pinned, cutoff, webAlpha(t, ticks));
      finish();
      return;
    }

    // Animated settle: a synchronous head so the first frame is already
    // roughly shaped, then rAF chunks. Total tick count — and the final
    // overlap-resolution pass — is identical to the synchronous path, so
    // the final picture is the same.
    let t = 0;
    const head = Math.min(ticks, 60);
    for (; t < head; t++) webTick(px, py, qv, springs, hubOf, pinned, cutoff, webAlpha(t, ticks));
    if (t >= ticks) { finish(); return; } // caller paints the final frame
    commit();
    const chunk = () => {
      if (token !== webAnim || layoutMode !== "web") return; // superseded
      const end = Math.min(ticks, t + 20);
      for (; t < end; t++) webTick(px, py, qv, springs, hubOf, pinned, cutoff, webAlpha(t, ticks));
      if (t >= ticks) {
        finish();
        drawWeb(shown, edges);
        return;
      }
      commit();
      drawWeb(shown, edges);
      requestAnimationFrame(chunk);
    };
    requestAnimationFrame(chunk);
  }

  /* ====================================================================
   * Rendering — string-built SVG of only the expanded slice
   * ================================================================== */
  function applyT() {
    vp.setAttribute("transform", `translate(${T.x},${T.y}) scale(${T.k})`);
    // Label LOD for dense web views: zoomed far out, symbol/file (then
    // unit) labels fade away instead of piling into an unreadable smear;
    // zooming back in reveals them smoothly (CSS opacity transition).
    // Only web-drawn nodes carry the cm-w-* classes the CSS keys on, so
    // tree mode is untouched.
    if (svg.dataset) {
      svg.dataset.z = T.k < 0.28 ? "far" : T.k < 0.55 ? "mid" : "near";
    }
  }

  function nodeColor(n) {
    if (n.type === "root") return "var(--accent)";
    if (n.type === "domain") return n.color;
    if (n.type === "unit") return "var(--cm-unit)";
    if (n.type === "file") return "var(--cm-file)";
    return KIND_COLOR[n.kind] || "var(--text-dim)";
  }

  function truncate(s, n) {
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }
  function esc(s) {
    return String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  }

  // Round for the SVG string — keeps the markup compact and the
  // determinism assertions exact.
  function r2(v) {
    return Math.round(v * 100) / 100;
  }

  // Web-mode paint. Node markup carries the exact same classes, data-id,
  // and ARIA as tree mode, so click-to-expand, keyboard nav, search
  // dim/match, selection, and the inspector all work unchanged. Edges flip
  // roles versus the tree: DEPENDS_ON becomes solid, labeled, and loud
  // (the star of the show); containment fades to short faint links.
  function drawWeb(shown, edges) {
    webShown = shown; // cached so a node drag can repaint without re-collecting
    webEdges = edges;
    const KICK = { root: "repository", domain: "domain", unit: "unit", file: "file", sym: "symbol" };
    let s = "";
    for (const [p, c] of edges) {
      const fresh = prevShown.size && !prevShown.has(c.id) ? " fresh" : "";
      s += `<line class="cm-weblink${fresh}" x1="${r2(p.x)}" y1="${r2(p.y)}" x2="${r2(c.x)}" y2="${r2(c.y)}"/>`;
    }
    if (showDeps) {
      const wireToTree = {};
      for (const n of shown) {
        if (n.real && !(n.real.id in wireToTree)) wireToTree[n.real.id] = n;
      }
      for (const fromWire in deps) {
        const a = wireToTree[fromWire];
        if (!a) continue;
        for (const d of deps[fromWire]) {
          const b = wireToTree[d.id];
          if (!b || a === b) continue;
          const dx = b.x - a.x, dy = b.y - a.y;
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          const ux = dx / len, uy = dy / len;
          const w = Math.min(3, 1 + Math.log(1 + (Number(d.count) || 1)) * 0.35);
          // Count label sits at the midpoint, nudged off the line.
          const mx = (a.x + b.x) / 2 - uy * 8;
          const my = (a.y + b.y) / 2 + ux * 8;
          s +=
            `<line class="cm-depweb" x1="${r2(a.x)}" y1="${r2(a.y)}" x2="${r2(b.x)}" y2="${r2(b.y)}" stroke-width="${r2(w)}"/>` +
            `<circle class="cm-dep-tip" cx="${r2(b.x - ux * 12)}" cy="${r2(b.y - uy * 12)}" r="2"/>` +
            (d.count
              ? `<text class="cm-dep-count" x="${r2(mx)}" y="${r2(my + 3)}">${esc(String(d.count))}</text>`
              : "");
        }
      }
    }
    for (const n of shown) {
      const hasKids = n.children.length > 0;
      const collapsed = hasKids && n._collapsed;
      const r = nodeR(n);
      const col = nodeColor(n);
      const fill = collapsed ? col : hasKids ? "var(--bg)" : col;
      const pinnedHere = webPins.has(n.id);
      const cls = ["cm-node", "cm-w-" + n.type];
      if (selectedId === n.id) cls.push("selected");
      if (pinnedHere) cls.push("pinned");
      if (matchSet) cls.push(matchSet.has(n) ? "match" : "dim");
      if (prevShown.size && !prevShown.has(n.id)) cls.push("fresh");
      const count = collapsed && n.nsyms ? ` <tspan fill="var(--text-faint)">·${n.nsyms}</tspan>` : "";
      const lx = r + 7;
      // In a web there are no columns to guard — labels always sit to the
      // right of the dot, truncated so dense clusters stay legible.
      const shownName = truncate(n.name, 26);
      const estW = shownName.length * 7 + 30;
      const aria =
        ` role="button" tabindex="0" aria-label="${esc(n.name)}, ${KICK[n.type]}` +
        (pinnedHere ? ", pinned" : "") + `"` +
        (hasKids ? ` aria-expanded="${collapsed ? "false" : "true"}"` : "");
      s +=
        `<g class="${cls.join(" ")}" data-id="${n.id}"${aria} transform="translate(${r2(n.x)},${r2(n.y)})">` +
        (selectedId === n.id ? `<circle class="selring" r="${r + 4}"/>` : "") +
        `<circle class="dot" r="${r}" fill="${fill}" stroke="${col}" stroke-width="1.6"/>` +
        (collapsed
          ? `<circle r="${r + 3.5}" fill="none" stroke="${col}" stroke-width="1" opacity=".4"/>`
          : "") +
        // Pin indicator: a dashed ring plus a small dot at the ring's
        // upper-right — "this one is held where you put it". The ring's
        // stroke is non-scaling so it stays a hairline at any zoom instead
        // of vanishing zoomed out (k=0.1) or turning to rope zoomed in
        // (k=3); a presentation attribute (not CSS) because Firefox only
        // honors vector-effect as an attribute. Static string, so painted
        // markup stays byte-identical across runs.
        (pinnedHere
          ? `<circle class="pinring" vector-effect="non-scaling-stroke" r="${r + 4.5}"/>` +
            `<circle class="pindot" cx="${r2((r + 4.5) * 0.707)}" cy="${r2(-(r + 4.5) * 0.707)}" r="2"/>`
          : "") +
        `<text class="lbl" x="${lx}" y="3.5" font-size="${n.type === "sym" ? 10.5 : 11.5}">` +
        esc(shownName) + count + `</text>` +
        `<rect class="hit" x="-${r + 4}" y="-9" width="${lx + estW + r + 4}" height="18"/>` +
        `</g>`;
    }
    vp.innerHTML = s;
    prevShown = new Set(shown.map((n) => n.id));
    applyT();
    visibleEl.textContent = shown.length.toLocaleString() + " nodes shown";
  }

  // Web-mode render: re-simulate only when the visible set actually
  // changed (expand/collapse/level/search). Pure repaints — selection,
  // dep toggle, search dimming — reuse the settled positions untouched.
  function renderWeb() {
    const { shown, edges, hubOf } = collectWeb();
    const sig = shown.map((n) => n.id).join(",");
    if (sig !== webSig) {
      webSig = sig;
      runWebSim(shown, edges, hubOf);
    } else {
      for (const n of shown) {
        const p = webPos.get(n.id);
        if (p) { n.x = p.x; n.y = p.y; }
      }
    }
    drawWeb(shown, edges);
  }

  function render() {
    if (!root) return;
    if (layoutMode === "web") {
      renderWeb();
      return;
    }
    layout(root);
    const shown = [];
    const edges = [];
    // Parents are pushed BEFORE their children so deeper nodes paint later
    // (on top). A parent's wide hit-rect can reach into the next column;
    // painting children above it keeps their dots clickable.
    (function collect(n) {
      shown.push(n);
      const kids = n._collapsed || !n.children.length ? [] : n.children;
      for (const k of kids) {
        edges.push([n, k]);
        collect(k);
      }
    })(root);

    const KICK = { root: "repository", domain: "domain", unit: "unit", file: "file", sym: "symbol" };
    let s = "";
    for (const [p, c] of edges) {
      const mx = (p.x + c.x) / 2;
      const fresh = prevShown.size && !prevShown.has(c.id) ? " fresh" : "";
      s += `<path class="cm-edge${fresh}" d="M${p.x} ${p.y}C${mx} ${p.y} ${mx} ${c.y} ${c.x} ${c.y}"/>`;
    }

    // Cross-links: DEPENDS_ON between currently VISIBLE nodes (domain→domain,
    // unit→unit). The ontology is a graph, not a tree — these arcs are the
    // coupling the CONTAINS tree can't show (everything leaning on the event
    // bus, Ordering touching Basket, ...). Drawn as bowed dashed arcs with the
    // coupling count; nodes still paint on top.
    if (showDeps) {
      const wireToTree = {};
      for (const n of shown) {
        if (n.real && !(n.real.id in wireToTree)) wireToTree[n.real.id] = n;
      }
      for (const fromWire in deps) {
        const a = wireToTree[fromWire];
        if (!a) continue;
        for (const d of deps[fromWire]) {
          const b = wireToTree[d.id];
          if (!b || a === b) continue;
          const bow = 46 + Math.abs(a.y - b.y) * 0.12;
          const cx = Math.min(a.x, b.x) - bow;
          const midX = (a.x + b.x) / 2 - bow * 0.72;
          const midY = (a.y + b.y) / 2;
          s +=
            `<path class="cm-dep" d="M${a.x} ${a.y}C${cx} ${a.y} ${cx} ${b.y} ${b.x} ${b.y}"/>` +
            `<circle class="cm-dep-tip" cx="${b.x - 9}" cy="${b.y}" r="2"/>` +
            (d.count
              ? `<text class="cm-dep-count" x="${midX}" y="${midY + 3}">${esc(String(d.count))}</text>`
              : "");
        }
      }
    }
    for (const n of shown) {
      const hasKids = n.children.length > 0;
      const collapsed = hasKids && n._collapsed;
      const r = nodeR(n);
      const col = nodeColor(n);
      const fill = collapsed ? col : hasKids ? "var(--bg)" : col;
      const cls = ["cm-node"];
      if (selectedId === n.id) cls.push("selected");
      if (matchSet) cls.push(matchSet.has(n) ? "match" : "dim");
      if (prevShown.size && !prevShown.has(n.id)) cls.push("fresh");
      const count = collapsed && n.nsyms ? ` <tspan fill="var(--text-faint)">·${n.nsyms}</tspan>` : "";
      const lx = r + 7;
      // Expanded parents carry their label on the LEFT (tidy-tree style), so
      // the trace to their children — and the children themselves — never
      // run through the text. Leaves and collapsed nodes label right. Left
      // labels are truncated to the column gap so neither the text nor its
      // hit-rect can reach the previous column's nodes or steal their clicks.
      // Right labels get the mirror guard: a collapsed/leaf node that is not
      // in the LAST column is truncated to the gap toward the NEXT column,
      // so its text can't run under nodes drawn there. The root (no
      // siblings: nothing else is visible when it's collapsed) and the last
      // column (nothing to its right) keep the generous cap.
      const labelLeft = hasKids && !collapsed;
      const colIdx = Math.min(n.depth, COL.length - 1);
      let maxChars = 34;
      if (labelLeft) {
        const gapLeft = n.depth === 0 ? Infinity : COL[colIdx] - COL[colIdx - 1];
        maxChars = Math.max(8, Math.min(34, Math.floor((gapLeft - 45) / 7)));
      } else if (n.depth >= 1 && colIdx < COL.length - 1) {
        const gapRight = COL[colIdx + 1] - COL[colIdx];
        maxChars = Math.max(8, Math.min(34, Math.floor((gapRight - 45) / 7)));
      }
      const shownName = truncate(n.name, maxChars);
      const estW = shownName.length * 7 + 30; // rough mono width incl. count
      // Every node is keyboard-reachable: Tab walks the visible tree in
      // reading order, Enter/Space expands or collapses like a click.
      const aria =
        ` role="button" tabindex="0" aria-label="${esc(n.name)}, ${KICK[n.type]}"` +
        (hasKids ? ` aria-expanded="${collapsed ? "false" : "true"}"` : "");
      s +=
        `<g class="${cls.join(" ")}" data-id="${n.id}"${aria} transform="translate(${n.x},${n.y})">` +
        (selectedId === n.id ? `<circle class="selring" r="${r + 4}"/>` : "") +
        `<circle class="dot" r="${r}" fill="${fill}" stroke="${col}" stroke-width="1.6"/>` +
        (collapsed
          ? `<circle r="${r + 3.5}" fill="none" stroke="${col}" stroke-width="1" opacity=".4"/>`
          : "") +
        `<text class="lbl" x="${labelLeft ? -lx : lx}" y="3.5"` +
        (labelLeft ? ` text-anchor="end"` : "") +
        ` font-size="${n.type === "sym" ? 10.5 : 11.5}">` +
        esc(shownName) + count + `</text>` +
        (labelLeft
          ? `<rect class="hit" x="-${lx + estW}" y="-9" width="${lx + estW + r + 4}" height="18"/>`
          : `<rect class="hit" x="-${r + 4}" y="-9" width="${lx + estW + r + 4}" height="18"/>`) +
        `</g>`;
    }
    vp.innerHTML = s;
    prevShown = new Set(shown.map((n) => n.id));
    applyT();
    visibleEl.textContent = shown.length.toLocaleString() + " nodes shown";
  }

  /* ====================================================================
   * Inspector
   * ================================================================== */
  function metric(v, label) {
    return `<div class="metric"><b>${Number(v).toLocaleString()}</b><span>${label}</span></div>`;
  }

  function showDetail(n) {
    selectedId = n.id;
    detail.classList.remove("empty");
    const kick = {
      root: "repository",
      domain: "domain",
      unit: "unit",
      file: "source file",
      sym: KIND_LABEL[n.kind] || "symbol",
    }[n.type];
    const real = n.real;
    let html = `<div class="kicker">${esc(kick)}</div><h3>${esc(n.name)}</h3>`;

    let path = "";
    if (n.type === "file") path = n.path || "";
    else if (n.type === "sym") {
      const file = prop(real, "file");
      const line = prop(real, "line");
      path = (file || "") + (file && line != null ? ":" + line : "");
    }
    if (path) html += `<div class="path">${esc(path)}</div>`;

    if (n.type !== "sym") {
      html += `<div class="metric-row">`;
      if (n.type === "root" || n.type === "domain") html += metric(n.nunits, "units");
      if (n.type !== "file") html += metric(n.nfiles, "files");
      html += metric(n.nsyms, "symbols") + `</div>`;
      const tot = n.mix.T + n.mix.F + n.mix.C;
      if (tot) {
        html +=
          `<h4>symbol kinds</h4><div class="kindbar">` +
          `<i style="flex:${n.mix.T};background:var(--cm-type)"></i>` +
          `<i style="flex:${n.mix.F};background:var(--cm-func)"></i>` +
          `<i style="flex:${n.mix.C};background:var(--cm-const)"></i></div>` +
          `<div class="kindlegend">` +
          `<span><i class="sw" style="background:var(--cm-type)"></i>${n.mix.T} type</span>` +
          `<span><i class="sw" style="background:var(--cm-func)"></i>${n.mix.F} func</span>` +
          `<span><i class="sw" style="background:var(--cm-const)"></i>${n.mix.C} const</span></div>`;
      }
    }

    // Facts straight off the wire node: archetype / layer / domain / unit,
    // plus kind/reason (business domain vs named infrastructure group).
    const facts = [];
    if (real) {
      for (const key of ["archetype", "layer", "domain", "unit", "kind", "reason"]) {
        const v = prop(real, key);
        if (v != null && v !== "") facts.push([key, v]);
      }
    }
    if (facts.length) {
      html +=
        `<h4>facts</h4><div class="facts">` +
        facts
          .map(([k, v]) => `<div class="fact"><span>${esc(k)}</span><b>${esc(String(v))}</b></div>`)
          .join("") +
        `</div>`;
    }

    if (real && deps[real.id] && deps[real.id].length) {
      html +=
        `<h4>depends on</h4><div class="chips">` +
        deps[real.id]
          .map((d) => {
            const t = realById[d.id];
            const label = (t && t.caption) || d.id;
            const times = d.count != null ? ` <em>×${esc(String(d.count))}</em>` : "";
            return `<span class="chip dep">${esc(label)}${times}</span>`;
          })
          .join("") +
        `</div>`;
    }

    if (n.type === "domain" && n.children.length) {
      html +=
        `<h4>units</h4><div class="chips">` +
        n.children.map((u) => `<span class="chip">${esc(u.name)}</span>`).join("") +
        `</div>`;
    }
    detail.innerHTML = html;
  }

  /* ====================================================================
   * Interactions: click-to-expand, level filters, search, pan/zoom, fit
   * ================================================================== */
  let dragMoved = false;
  let downId = null; // node under the cursor at pointerdown (captured before any pan)

  // Collapse a node AND every descendant, so clicking an expanded node closes
  // all of its children (not just one level).
  function collapseSubtree(n) {
    n._collapsed = true;
    for (const c of n.children) collapseSubtree(c);
  }
  function toggleNode(n) {
    if (!n.children.length) return;
    if (n._collapsed) n._collapsed = false; // single click → reveal direct children
    else collapseSubtree(n); // click again → close all children
  }
  // Clicks are handled in pointerup (below) so pointer-capture can never steal
  // the target — clicking the dot OR the label anywhere on a node works.

  document.getElementById("cm-levels").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || !root) return;
    document
      .querySelectorAll("#cm-levels button")
      .forEach((x) => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
    setDepth(+b.dataset.d);
    render();
    fit();
  });

  let qt = null;
  searchInput.addEventListener("input", (e) => {
    clearTimeout(qt);
    qt = setTimeout(() => runSearch(e.target.value.trim().toLowerCase()), 160);
  });
  // Escape clears the search and hands the map back — one keystroke to undo.
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && searchInput.value) {
      e.stopPropagation();
      searchInput.value = "";
      runSearch("");
    }
  });

  // Search opens the path to every match (ancestors get expanded) and dims
  // everything else. The badge in the search box reports how many nodes
  // actually matched (ancestors opened along the way don't count).
  function runSearch(q) {
    if (!root) return;
    if (!q) {
      matchSet = null;
      matchCountEl.hidden = true;
      render();
      return;
    }
    matchSet = new Set();
    let hits = 0;
    (function walk(n, anc) {
      const hay = (n.name + " " + (n.path || "")).toLowerCase();
      if (hay.includes(q)) {
        hits++;
        matchSet.add(n);
        for (const a of anc) {
          matchSet.add(a);
          a._collapsed = false;
        }
      }
      const next = anc.concat(n);
      for (const c of n.children) walk(c, next);
    })(root, []);
    matchCountEl.hidden = false;
    matchCountEl.textContent = hits === 0 ? "no matches" : hits.toLocaleString() + (hits === 1 ? " match" : " matches");
    matchCountEl.classList.toggle("none", hits === 0);
    render();
    // Matches may have opened branches far outside the viewport — bring
    // every lit-up path on screen so "found" is something you can SEE.
    if (hits > 0) fit();
  }

  // Pin a node at its current position, persist, and re-settle the sim so
  // springs pull its neighbors into agreement (the pin itself never moves).
  function pinNode(n) {
    webPins.set(n.id, { x: n.x, y: n.y });
    webPos.set(n.id, { x: n.x, y: n.y });
    savePins();
  }
  function resettleWeb() {
    if (layoutMode !== "web" || !root) return;
    const { shown, edges, hubOf } = collectWeb();
    webSig = shown.map((n) => n.id).join(",");
    runWebSim(shown, edges, hubOf);
    drawWeb(shown, edges);
  }
  // During a node drag, repaint the whole slice while it's cheap; above the
  // threshold move just the dragged <g> (its edges catch up on drop).
  function repaintWebDrag(n) {
    if (webShown && webShown.length <= 1500) {
      drawWeb(webShown, webEdges);
      return;
    }
    const g = vp.querySelector(`[data-id="${n.id}"]`);
    if (g) g.setAttribute("transform", `translate(${r2(n.x)},${r2(n.y)})`);
  }

  let drag = null;
  wrap.addEventListener("pointerdown", (e) => {
    dragMoved = false;
    // Record the node NOW, before any pointer capture can redirect e.target.
    const g = e.target.closest(".cm-node");
    downId = g ? g.dataset.id : null;
    // In web mode a drag that STARTS on a node repositions that node; a
    // drag that starts on empty canvas still pans. The root stays pinned
    // at the origin, and tree mode never moves nodes. Which one this
    // gesture is stays undecided until the movement threshold — a plain
    // click must keep firing expand/collapse exactly as before.
    const n = downId ? byId[downId] : null;
    const nodeDrag = layoutMode === "web" && n && n.depth > 0 ? n : null;
    drag = {
      x: e.clientX, y: e.clientY, tx: T.x, ty: T.y,
      node: nodeDrag, nx: nodeDrag ? nodeDrag.x : 0, ny: nodeDrag ? nodeDrag.y : 0,
    };
  });
  wrap.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!dragMoved && Math.abs(dx) + Math.abs(dy) > 4) {
      dragMoved = true; // only now is it a drag, not a click
      wrap.classList.add(drag.node ? "dragging-node" : "grabbing");
      try { wrap.setPointerCapture(e.pointerId); } catch (_) {}
      if (drag.node) webAnim++; // a running settle animation must not fight the hand
    }
    if (dragMoved) {
      if (drag.node) {
        // Screen delta → graph coords through the current zoom.
        const n = drag.node;
        n.x = drag.nx + dx / T.k;
        n.y = drag.ny + dy / T.k;
        webPos.set(n.id, { x: n.x, y: n.y });
        repaintWebDrag(n);
      } else {
        T.x = drag.tx + dx;
        T.y = drag.ty + dy;
        applyT();
      }
    }
  });
  wrap.addEventListener("pointerup", (e) => {
    const wasClick = drag && !dragMoved && downId;
    const draggedNode = drag && dragMoved ? drag.node : null;
    drag = null;
    wrap.classList.remove("grabbing");
    wrap.classList.remove("dragging-node");
    try { wrap.releasePointerCapture(e.pointerId); } catch (_) {}
    if (wasClick) {
      const n = byId[downId];
      if (n) {
        toggleNode(n);
        showDetail(n);
        render();
      }
    } else if (draggedNode) {
      // Drop = pin. The sim re-settles around the held node.
      pinNode(draggedNode);
      resettleWeb();
    }
    downId = null;
  });

  // Double-click a pinned node to unpin it — the node returns to sim
  // control from wherever it sits (no jump; the springs take over).
  wrap.addEventListener("dblclick", (e) => {
    if (layoutMode !== "web") return;
    const g = e.target.closest(".cm-node");
    if (!g || !webPins.has(g.dataset.id)) return;
    webPins.delete(g.dataset.id);
    savePins();
    resettleWeb();
  });

  // Keyboard: Enter or Space on a focused node behaves exactly like a click.
  // render() rebuilds the SVG, so focus is put back on the same node after.
  // Web-mode parity for drag-to-reposition: arrow keys nudge the focused
  // node (12px, ×4 with Shift) and pin it where it lands; P toggles the pin
  // (unpin re-settles, like double-click).
  svg.addEventListener("keydown", (e) => {
    const g = e.target.closest ? e.target.closest(".cm-node") : null;
    if (!g) return;
    const n = byId[g.dataset.id];
    if (!n) return;
    const refocus = () => {
      const again = vp.querySelector(`[data-id="${n.id}"]`);
      if (again) again.focus();
    };
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleNode(n);
      showDetail(n);
      render();
      refocus();
      return;
    }
    if (layoutMode !== "web" || n.depth === 0) return;
    const ARROW = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    }[e.key];
    if (ARROW) {
      e.preventDefault();
      const step = e.shiftKey ? 48 : 12;
      n.x += ARROW[0] * step;
      n.y += ARROW[1] * step;
      pinNode(n); // a keyboard move is a deliberate placement, same as a drop
      if (webShown) drawWeb(webShown, webEdges);
      refocus();
      return;
    }
    if (e.key === "p" || e.key === "P") {
      e.preventDefault();
      if (webPins.has(n.id)) {
        webPins.delete(n.id);
        savePins();
        resettleWeb();
      } else {
        pinNode(n);
        if (webShown) drawWeb(webShown, webEdges);
      }
      refocus();
    }
  });

  wrap.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const f = Math.exp(-e.deltaY * 0.0014);
      const nk = Math.min(3, Math.max(0.1, T.k * f));
      T.x = mx - (mx - T.x) * (nk / T.k);
      T.y = my - (my - T.y) * (nk / T.k);
      T.k = nk;
      applyT();
    },
    { passive: false }
  );

  function fit() {
    if (!root) return;
    const shown = [];
    (function c(n) {
      shown.push(n);
      const kids = n._collapsed || !n.children.length ? [] : n.children;
      kids.forEach(c);
    })(root);
    if (!shown.length) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of shown) {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    }
    if (layoutMode === "web") {
      // No left-anchored labels in the web — pad for right labels only.
      minX -= 80; maxX += 220; minY -= 40; maxY += 40;
    } else {
      // Left padding covers the left-anchored labels of expanded parents.
      minX -= 250; maxX += 260; minY -= 30; maxY += 30;
    }
    const r = svg.getBoundingClientRect();
    if (!r.width || !r.height) return; // pane not visible yet
    const k = Math.min(2, Math.max(0.1, Math.min(r.width / (maxX - minX), r.height / (maxY - minY))));
    T.k = k;
    T.x = (r.width - (maxX + minX) * k) / 2;
    T.y = (r.height - (maxY + minY) * k) / 2;
    applyT();
  }
  document.getElementById("cm-fit").addEventListener("click", fit);

  const depsBtn = document.getElementById("cm-deps");
  if (depsBtn) {
    depsBtn.addEventListener("click", () => {
      showDeps = !showDeps;
      depsBtn.setAttribute("aria-pressed", showDeps ? "true" : "false");
      render();
    });
  }

  /* ---- Layout toggle: Tree (tidy drill-down) | Web (force-directed) ---- */
  function syncLayoutButtons() {
    document
      .querySelectorAll("#cm-layout button")
      .forEach((b) => b.setAttribute("aria-pressed", b.dataset.m === layoutMode ? "true" : "false"));
  }

  function setLayoutMode(m) {
    if (m !== "tree" && m !== "web") return;
    if (m === layoutMode) { syncLayoutButtons(); return; }
    layoutMode = m;
    webAnim++; // cancel any settle animation from the other mode
    try { localStorage.setItem(LAYOUT_KEY, m); } catch (_) { /* private mode — just not remembered */ }
    syncLayoutButtons();
    prevShown = new Set(); // a mode switch repaints everything; no fade cues
    render();
    fit();
  }

  const layoutCtl = document.getElementById("cm-layout");
  if (layoutCtl) {
    layoutCtl.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b || !root) return;
      setLayoutMode(b.dataset.m);
    });
  }

  /* ====================================================================
   * Stats strip (raw wire counts, independent of tree grouping)
   * ================================================================== */
  function renderStats(nodes) {
    const c = { domain: 0, unit: 0, file: 0, symbol: 0 };
    for (const n of nodes) {
      const l = level(n);
      if (c[l] !== undefined) c[l]++;
    }
    statsEl.innerHTML = [
      ["domains", c.domain],
      ["units", c.unit],
      ["files", c.file],
      ["symbols", c.symbol],
    ]
      .map(([l, v]) => `<div class="stat"><b>${v.toLocaleString()}</b><span>${l}</span></div>`)
      .join("");
  }

  /* ====================================================================
   * First-run walkthrough (gs-H3)
   *
   * A short dismissible tour that names every concept on screen — Domain,
   * Unit, File, Symbol, archetype/layer — and shows how to move around.
   * Written for someone with zero prior context. Dismissal (skip OR finish)
   * is remembered in localStorage; the "?" button in the bar replays it.
   * Vanilla JS/CSS only — no external libraries, airgap-safe.
   * ================================================================== */
  const TOUR_KEY = "ontoloom.cmTourDone";

  function sw(color) {
    return `<span class="tsw" style="background:${color}"></span>`;
  }

  const TOUR_STEPS = [
    {
      title: "This is a code map",
      body:
        `<p>Ontoloom recognized this graph as a <strong>codebase</strong>, so it opened ` +
        `the code map: a drill-down view of the repository's structure, from the big ` +
        `picture down to a single function.</p>` +
        `<p>Everything starts folded up so even a huge repo reads as a handful of ` +
        `circles. The next few steps name each thing you'll see.</p>`,
    },
    {
      title: "Domains — what the code is about",
      body:
        `<p>${sw("#5b8def")}${sw("#7cc4a4")}${sw("#b98bd9")} The colored circles you ` +
        `see first are <strong>domains</strong>. A domain is one area of what the software ` +
        `<em>does</em> — think “Billing”, “Catalog”, or “Identity” (in design jargon: a ` +
        `<em>bounded context</em>).</p>` +
        `<p>Domains group code by purpose, not by folder — each gets its own color so ` +
        `you can tell them apart anywhere in the map.</p>` +
        `<p>${sw("#6b7793")} The muted circles at the bottom are <strong>infrastructure ` +
        `groups</strong> — Build &amp; Tooling, Documentation, Generated, Repo root. ` +
        `Every file has a named home (nothing is “ungrouped”); these hold the scaffolding ` +
        `around the business code and stay folded until you click them.</p>`,
    },
    {
      title: "Units — the buildable pieces",
      body:
        `<p>${sw("var(--cm-unit)")} Open a domain and you'll find its <strong>units</strong>. ` +
        `A unit is one buildable project or package: a <code>.csproj</code> in C#, a Cargo ` +
        `crate in Rust, a <code>package.json</code> in JavaScript.</p>` +
        `<p>When people say “project” loosely, <em>this</em> is what the map means by it. ` +
        `One domain can span several units, and one unit can serve several domains.</p>`,
    },
    {
      title: "Files & symbols — down to the code",
      body:
        `<p>${sw("var(--cm-file)")} Inside a unit are its <strong>files</strong> — the actual ` +
        `source files, shown with their path.</p>` +
        `<p>Inside a file are its <strong>symbols</strong> — the things declared in the code, ` +
        `in line order: ${sw("var(--cm-func)")} functions, ${sw("var(--cm-type)")} types, ` +
        `and ${sw("var(--cm-const)")} constants.</p>`,
    },
    {
      title: "Archetype & layer — each node's role",
      body:
        `<p>Click any node and the panel on the right shows its <strong>facts</strong>. Two ` +
        `are worth knowing:</p>` +
        `<p><strong>Archetype</strong> — the role a symbol plays in the architecture, like ` +
        `Controller or Repository (<em>Unclassified</em> just means no known pattern ` +
        `matched).</p>` +
        `<p><strong>Layer</strong> — the architectural stratum its file sits in, like Domain, ` +
        `Application, Infrastructure, or Shared. The legend in the corner recaps the ` +
        `level colors.</p>`,
      target: ".cm-legend",
    },
    {
      title: "Getting around",
      body:
        `<p><strong>Click</strong> a node to expand its children; click it again to fold them ` +
        `all away. The <strong>Domains / Units / Files / Symbols</strong> buttons expand the ` +
        `whole map to that depth at once.</p>` +
        `<p><strong>Search</strong> lights up matching files and symbols and opens the path to ` +
        `them. <strong>Drag</strong> to pan, <strong>scroll</strong> to zoom, <strong>Fit</strong> to ` +
        `recenter. Replay this tour any time with the <strong>?</strong> button.</p>` +
        `<p>In the <strong>Web</strong> layout you can also <strong>drag a node</strong> to ` +
        `reposition it — it stays pinned where you drop it (dashed ring), and ` +
        `<strong>double-click</strong> unpins it.</p>`,
      target: "#cm-levels",
    },
  ];

  const tourEl = document.getElementById("cm-tour");
  const tourTitle = document.getElementById("cm-tour-title");
  const tourBody = document.getElementById("cm-tour-body");
  const tourDots = document.getElementById("cm-tour-dots");
  const tourBack = document.getElementById("cm-tour-back");
  const tourNext = document.getElementById("cm-tour-next");
  const tourSkip = document.getElementById("cm-tour-skip");
  let tourStep = 0;
  let tourTarget = null; // currently highlighted element
  let tourReturnFocus = null; // element to hand focus back to on close

  function tourSeen() {
    try {
      return localStorage.getItem(TOUR_KEY) === "1";
    } catch (_) {
      return false;
    }
  }

  function tourRemember() {
    try {
      localStorage.setItem(TOUR_KEY, "1");
    } catch (_) { /* private mode etc. — the tour just shows again next time */ }
  }

  function tourHighlight(selector) {
    if (tourTarget) tourTarget.classList.remove("cm-tour-hilite");
    tourTarget = selector ? document.querySelector(selector) : null;
    if (tourTarget) tourTarget.classList.add("cm-tour-hilite");
  }

  function tourShowStep(i) {
    tourStep = Math.max(0, Math.min(TOUR_STEPS.length - 1, i));
    const step = TOUR_STEPS[tourStep];
    const last = tourStep === TOUR_STEPS.length - 1;
    tourTitle.textContent = step.title;
    tourBody.innerHTML = step.body;
    tourBack.style.visibility = tourStep === 0 ? "hidden" : "visible";
    tourNext.textContent = last ? "Done ✓" : "Next ›";
    tourSkip.style.visibility = last ? "hidden" : "visible";
    tourDots.innerHTML = TOUR_STEPS.map(
      (_, d) => `<i class="${d === tourStep ? "on" : ""}"></i>`
    ).join("");
    tourHighlight(step.target);
  }

  function tourOpen(force) {
    if (!force && tourSeen()) return;
    if (!tourEl.classList.contains("hidden")) return; // already showing
    tourReturnFocus = document.activeElement;
    tourShowStep(0);
    tourEl.classList.remove("hidden");
    tourNext.focus();
  }

  // Skipping and finishing both count as "seen" — the tour never nags.
  function tourClose() {
    tourEl.classList.add("hidden");
    tourHighlight(null);
    tourRemember();
    // Keyboard users land back where they were (usually the "?" button).
    if (tourReturnFocus && typeof tourReturnFocus.focus === "function" &&
        document.contains(tourReturnFocus)) {
      tourReturnFocus.focus();
    }
    tourReturnFocus = null;
  }

  tourNext.addEventListener("click", () => {
    if (tourStep >= TOUR_STEPS.length - 1) tourClose();
    else tourShowStep(tourStep + 1);
  });
  tourBack.addEventListener("click", () => tourShowStep(tourStep - 1));
  tourSkip.addEventListener("click", tourClose);
  // Clicking the dimmed backdrop (not the card) also dismisses.
  tourEl.addEventListener("click", (e) => {
    if (e.target === tourEl) tourClose();
  });
  document.addEventListener("keydown", (e) => {
    if (tourEl.classList.contains("hidden")) return;
    if (e.key === "Escape") tourClose();
    else if (e.key === "ArrowRight") tourNext.click();
    else if (e.key === "ArrowLeft" && tourStep > 0) tourShowStep(tourStep - 1);
    else if (e.key === "Tab") {
      // Modal focus trap: Tab cycles the dialog's visible buttons only.
      const cycle = [tourSkip, tourBack, tourNext].filter(
        (b) => b.style.visibility !== "hidden"
      );
      const i = cycle.indexOf(document.activeElement);
      e.preventDefault();
      const j = e.shiftKey
        ? (i <= 0 ? cycle.length - 1 : i - 1)
        : (i === cycle.length - 1 ? 0 : i + 1);
      cycle[j].focus();
    }
  });
  document.getElementById("cm-help").addEventListener("click", () => tourOpen(true));

  // Expert shortcut: "/" jumps to the search box (like GitHub / Slack).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/") return;
    if (!document.body.classList.contains("codemap-mode")) return;
    if (!tourEl.classList.contains("hidden")) return;
    const t = document.activeElement && document.activeElement.tagName;
    if (t === "INPUT" || t === "TEXTAREA") return;
    e.preventDefault();
    searchInput.focus();
  });

  /* ====================================================================
   * Public API — app.js drives mode switching through this
   * ================================================================== */
  window.CodeMap = {
    detect,

    // (Re)build the tree from the current wire graph and show it collapsed
    // at the domain level.
    load(name, nodes, rels) {
      buildTree(name, nodes, rels);
      setDepth(1);
      selectedId = null;
      matchSet = null;
      prevShown = new Set(); // fresh graph: first paint arrives without fades
      webPos = new Map();    // fresh graph: web positions reseed from hashes
      webSig = "";
      webAnim++;
      webShown = null;
      webEdges = null;
      pinsKey = pinsStorageKey(name, nodes, rels);
      loadPins();            // user pins for THIS graph survive reloads
      syncLayoutButtons();   // reflect the persisted Tree|Web choice
      searchInput.value = "";
      matchCountEl.hidden = true;
      detail.classList.add("empty");
      detail.innerHTML = EMPTY_DETAIL;
      document
        .querySelectorAll("#cm-levels button")
        .forEach((x) => x.setAttribute("aria-pressed", x.dataset.d === "1" ? "true" : "false"));
      renderStats(nodes);
      render();
      // The pane may have just been unhidden; fit once it has a size.
      requestAnimationFrame(fit);
      // First time someone ever sees a code map, explain what they're
      // looking at. No-op once dismissed (localStorage).
      tourOpen(false);
    },

    clear() {
      root = null;
      byId = {};
      prevShown = new Set();
      webPos = new Map();
      webSig = "";
      webAnim++;
      webShown = null;
      webEdges = null;
      webPins = new Map();
      pinsKey = "";
      vp.innerHTML = "";
      statsEl.innerHTML = "";
      visibleEl.textContent = "";
      matchCountEl.hidden = true;
      detail.classList.add("empty");
      detail.innerHTML = EMPTY_DETAIL;
    },
  };
})();
