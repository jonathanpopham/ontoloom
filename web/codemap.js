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
 * Everything starts collapsed at the domain level, and DRILL-DOWN IS THE
 * ONLY NAVIGATION: clicking a node expands its direct children, clicking it
 * again folds them away, and search auto-opens the path to its matches.
 * There is no bulk expand-to-level — a whole repo unfolded to files or
 * symbols is unreadable, so the map never offers it.
 *
 * Three faces (H11): the force-directed WEB, the tidy TREE, and the
 * MATRIX — an N×N dependency grid that cannot overlap by construction.
 * Dense graphs (a dozen-plus coupled domains) open in the matrix; smaller
 * ones open in the web. An explicit toggle persists per browser
 * (localStorage) and always wins. An ontology LENS picks the relationship
 * family that drives every face — containment only, DEPENDS_ON coupling,
 * or layer flow (outward-pointing dependencies flag red) — and a spread
 * slider scales the web sim's physics deterministically.
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
  /* Tidy-tree metrics. Rows sit 24px apart so 18px-tall label boxes keep
   * clear air between lines (19px used to leave 1px — labels read as
   * touching). Column x positions are DYNAMIC: recomputed by layout() from
   * the widest visible label per depth, so long file names get the room
   * they need instead of colliding or being truncated to stumps. */
  const ROW = 24;             // vertical rhythm of the tidy tree
  const TREE_CHARW = 7;       // estimated glyph width the renderer budgets per char
  const TREE_GAP_PAD = 45;    // dot + label offset + breathing room inside a gap
  const TREE_GAP_MIN = 130;   // a depth gap never shrinks below this
  const TREE_MAX_CHARS = 34;  // truncation cap for tree labels
  let colX = [0, 130, 350, 590, 810]; // x column per depth root..symbol (recomputed per layout)

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
  /* Ontology lens — which relationship family drives the view (H11):
   *   containment — structure only; DEPENDS_ON arcs are hidden
   *   coupling    — DEPENDS_ON arcs drawn/tabulated (the old default)
   *   layers      — DEPENDS_ON colored by architectural layer; an edge
   *                 whose source layer is DEEPER than its target's
   *                 (Domain → Application, Application → Presentation …)
   *                 points OUTWARD and is flagged red as a violation.
   * Live view state, deliberately not persisted. */
  let lens = "coupling";
  let T = { x: 60, y: 40, k: 1 }; // pan/zoom transform
  let prevShown = new Set(); // tree ids drawn in the previous frame → "fresh" fade-in

  /* ---- Web (force-directed) layout state ---- */
  const LAYOUT_KEY = "ontoloom.cmLayout";
  // Three faces of the map (H11): WEB (force-directed), TREE (tidy
  // drill-down), MATRIX (N×N dependency grid — zero overlap by
  // construction). An explicit toggle persists per browser and wins on
  // every later load; with no stored choice, load() picks MATRIX for
  // dense graphs (many coupled domains render as a hairball in any
  // force layout) and WEB otherwise.
  let layoutMode = "web"; // "tree" | "web" | "matrix"
  let layoutChosen = false; // a persisted/explicit choice beats the density default
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    if (v === "tree" || v === "web" || v === "matrix") {
      layoutMode = v;
      layoutChosen = true;
    }
  } catch (_) {}
  /* Physics/spread control (H11, web mode): one deterministic knob the
   * user can turn to loosen a dense cluster. It scales the repulsion
   * gain quadratically and every rest length linearly, then RESEEDS the
   * layout — so the picture is a pure function of (visible slice, spread,
   * pins): the default of 1 always reproduces the seeded H9/H10 layout,
   * and any setting is exactly repeatable. Live state, not persisted. */
  let physScale = 1;
  let webPos = new Map(); // tree id -> {x, y} settled force-sim position
  let webSig = "";        // signature of the visible set the sim last ran for
  let webAnim = 0;        // settle-animation token; bump to cancel a running one
  let webPins = new Map(); // tree id -> {x, y} user-pinned positions (drag-to-move)
  let dragNodeId = null; // node currently in hand mid-drag (paint feedback only)
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
    // render muted and sink below the business domains, so the colored
    // circles remain the story of what the software DOES. Click one and it
    // drills open like any other domain.
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
  // The starting posture of every freshly loaded map: root open, everything
  // else folded. From here the ONLY way deeper is drilling node by node
  // (or a search opening the path to its matches).
  function collapseToDomains() {
    (function walk(n) {
      if (n.children.length) {
        n._collapsed = n.depth >= 1;
        n.children.forEach(walk);
      }
    })(root);
  }

  // How many characters this node's tree label paints (count badge included).
  function treeLabelChars(n) {
    const hasKids = n.children.length > 0;
    const collapsed = hasKids && n._collapsed;
    let c = Math.min(TREE_MAX_CHARS, n.name.length);
    if (collapsed && n.nsyms) c += String(n.nsyms).length + 2; // " ·N"
    return c;
  }

  let yCursor = 0;
  function layout(n) {
    // Dynamic columns: each depth gap is sized to the widest visible label
    // that must live inside it — the right-anchored labels of the
    // collapsed/leaf nodes on its left edge, and the left-anchored labels
    // of the expanded parents on its right edge. Deep drills with long
    // file names get wide columns; a domains-only view stays compact.
    // Deterministic: a pure function of the visible slice.
    const need = [0, 0, 0, 0]; // required label chars per gap (gap g = colX[g]→colX[g+1])
    (function scan(node) {
      const kids = node._collapsed || !node.children.length ? [] : node.children;
      const colIdx = Math.min(node.depth, colX.length - 1);
      const chars = treeLabelChars(node);
      if (kids.length) {
        // expanded parent: labels LEFT into the gap behind it
        if (node.depth >= 1) need[colIdx - 1] = Math.max(need[colIdx - 1], chars);
      } else if (colIdx < colX.length - 1) {
        // collapsed/leaf: labels RIGHT into the gap ahead of it
        need[colIdx] = Math.max(need[colIdx], chars);
      }
      kids.forEach(scan);
    })(n);
    colX = [0];
    for (let g = 0; g < 4; g++) {
      colX[g + 1] = colX[g] + Math.max(TREE_GAP_MIN, need[g] * TREE_CHARW + TREE_GAP_PAD);
    }

    yCursor = 0;
    (function place(node) {
      node.x = colX[Math.min(node.depth, colX.length - 1)];
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
    // Constraint-relaxation passes after the sim settles. Sized on the
    // 3355-node eShop graph: 24 passes left 223 pairs of dots actually
    // intersecting (stacked nodes you can't see or click under); 96 gets
    // that to 10 for ~7% more layout time (3.33s → 3.56s). Smaller slices
    // converge and early-exit long before the budget (units LOD: pass 1),
    // so they pay nothing. sepPad itself never binds below the symbols
    // LOD — measured nearest-neighbor gap at units LOD is 28.5px minimum,
    // repulsion alone clears the 12px floor with headroom.
    sepPasses: 96,
    /* Label-aware separation (H10). The dot pass above keeps CIRCLES apart;
     * labels are wide rectangles hanging off each dot's right side and they
     * still collided (63 overlapping label pairs on the drilled eShop
     * domains). A second constraint pass treats every node as its label BOX
     * (dot ∪ text estimate) and pushes intersecting boxes apart along the
     * axis of least penetration — labels are short and wide, so in practice
     * nodes shuffle vertically into clean rows. Only run up to lblRectMaxN
     * visible nodes: past that, hard box separation would smear the
     * clusters, and the priority label-fade in drawWeb() takes over as the
     * guarantee instead. */
    lblPad: 3,          // clear air demanded between label boxes (px)
    lblRectPasses: 128, // fixed budget; early-exits on convergence
    lblRectMaxN: 600,   // above this, fade — don't separate — the labels
    // Over-relaxation: each resolution pushes 1.9× the penetration. Plain
    // resolution (1.0×) crept at ~0.99/pass on the drilled eShop slice —
    // 45 label pairs still interlocked after 64 passes, 27 after 256. At
    // 1.9× the same slice converges to ZERO overlapping pairs inside 64
    // passes with no bbox blow-up (measured: 1014×1079 vs 994×1125).
    lblSor: 1.9,
  };

  const LBL_CHARW = 7;      // same per-char width estimate the renderer uses
  const LBL_HALF_H = 9;     // label box half-height (18px line, 11.5px text)
  const WEB_LBL_TRUNC = 26; // web labels truncate at 26 chars (drawWeb)
  // Sub-pixel overlaps are treated as separated, and every resolution pushes
  // this much PAST touching. Without the slack, resolved pairs land exactly
  // on the boundary: float residue (±1e-13) kept re-flagging them, cascade
  // nudges of <1px never damped, and the pass oscillated at ~55 "overlaps"
  // forever (measured on the drilled eShop slice) — all of them invisible.
  const LBL_EPS = 0.5;

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
  //
  // Deep nodes (units/files/symbols) seed as a RADIAL ORBIT per parent
  // (H11): a drilled node's fresh children ring it at even angles on a
  // circle sized to hold them all, instead of scattering into the global
  // force soup. The local cluster is clean before the sim even runs, and
  // the incremental re-settle only relaxes it — drill never knots.
  function seedWeb(shown, edges) {
    const parentOf = new Map();
    for (const [p, c] of edges) parentOf.set(c.id, p);
    const batches = new Map(); // parent tree id -> [fresh child nodes], shown order
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
        const rad = (320 + ((h >>> 12) % 120)) * physScale; // domains ring the root
        webPos.set(n.id, { x: Math.cos(ang) * rad, y: Math.sin(ang) * rad });
      } else {
        // Deep node: defer to its parent's batch so siblings can share
        // one evenly spaced ring around the parent.
        const par = parentOf.get(n.id);
        const key = par ? par.id : "";
        const b = batches.get(key);
        if (b) b.push(n);
        else batches.set(key, [n]);
      }
    }
    // Place each batch. Map iteration is insertion order and parents
    // appear in `shown` before their children, so a parent that is itself
    // fresh already has its position by the time its batch is placed.
    for (const [pid, kids] of batches) {
      const p = webPos.get(pid) || { x: 0, y: 0 };
      const d = Math.min(kids[0].depth, WEB.rest.length - 1);
      const base = (hash32(pid) % 3600) * (Math.PI / 1800); // deterministic ring phase
      // Ring radius: the containment rest length, grown until every child
      // gets ~26px of arc — big families get a wider, still-clean orbit.
      const rad = Math.max(WEB.rest[d] * physScale, (kids.length * 26) / (2 * Math.PI));
      for (let i = 0; i < kids.length; i++) {
        const a = base + (i * 2 * Math.PI) / kids.length;
        webPos.set(kids[i].id, { x: p.x + Math.cos(a) * rad, y: p.y + Math.sin(a) * rad });
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
      springs.push({ a: idx.get(p.id), b: idx.get(c.id), len: WEB.rest[d] * physScale, k: WEB.kc[d] });
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
        springs.push({ a: idx.get(a.id), b: idx.get(b.id), len: WEB.depRest * physScale, k });
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
            // physScale² so the spring/repulsion equilibrium distance
            // scales ~linearly with the spread knob.
            let f = WEB.repK * physScale * physScale * qv[i] * qv[j] * inv;
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
              // Push a quarter-pixel PAST touching: pairs resolved exactly
              // onto the boundary kept getting re-flagged by float residue
              // and neighbor cascades never damped — at 670 nodes the
              // 96-pass budget ran out with 29 sub-0.01px "violations"
              // still oscillating. The slack makes cascades converge
              // (measured: 0 residuals at every drill depth).
              const push = minSep - d + 0.25;
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

  /* ---- Label geometry (web mode) ----
   * One estimate shared by the rect separation pass, the priority fade,
   * and the harness assertions, so "label overlap" means the same thing
   * everywhere. The box is the dot plus the text hanging off its right:
   *   x: -(r+4)  →  (r+7) + chars·7
   *   y: ±max(9, r+4)
   * (r+4 covers the selection/collapse rings; 9 is half the 18px line.) */
  function webLabelChars(n) {
    const hasKids = n.children.length > 0;
    const collapsed = hasKids && n._collapsed;
    let c = Math.min(WEB_LBL_TRUNC, n.name.length);
    if (collapsed && n.nsyms) c += String(n.nsyms).length + 2; // " ·N"
    return c;
  }
  function webLabelExtents(n) {
    const r = nodeR(n);
    const pad = WEB.lblPad;
    return {
      x0: -(r + 4 + pad),
      x1: r + 7 + webLabelChars(n) * LBL_CHARW + pad,
      y: Math.max(LBL_HALF_H, r + 4) + pad,
    };
  }

  // Label-aware separation — the H10 collision resolver. Runs AFTER the
  // dot pass: every visible node becomes its label box, and intersecting
  // boxes are pushed apart along the axis of least penetration (labels are
  // wide and short, so the push is almost always a small vertical shuffle
  // that reads as labels stacking into rows). Grid-bucketed by box center
  // (cell = the widest box, so any intersecting pair shares a 3×3
  // neighborhood) and fully deterministic: fixed pass budget, ascending
  // index order, ties broken by index, no randomness. Pinned nodes (root +
  // user pins) never move — their partner takes the full push; a
  // pinned-pinned collision is left for the fade pass to hide.
  function resolveLabelRects(px, py, shown, pinned) {
    const n = px.length;
    if (n > WEB.lblRectMaxN) return;
    const ex0 = new Float64Array(n);
    const ex1 = new Float64Array(n);
    const ey = new Float64Array(n);
    let cell = 1;
    for (let i = 0; i < n; i++) {
      const e = webLabelExtents(shown[i]);
      ex0[i] = e.x0; ex1[i] = e.x1; ey[i] = e.y;
      if (e.x1 - e.x0 > cell) cell = e.x1 - e.x0;
    }
    for (let pass = 0; pass < WEB.lblRectPasses; pass++) {
      const grid = new Map();
      const cx = new Int32Array(n);
      const cy = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        cx[i] = Math.floor((px[i] + (ex0[i] + ex1[i]) / 2) / cell);
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
              const ox = Math.min(px[i] + ex1[i], px[j] + ex1[j]) - Math.max(px[i] + ex0[i], px[j] + ex0[j]);
              if (ox <= LBL_EPS) continue;
              const oy = Math.min(py[i] + ey[i], py[j] + ey[j]) - Math.max(py[i] - ey[i], py[j] - ey[j]);
              if (oy <= LBL_EPS) continue;
              // Minimal translation, over-relaxed: separate along the
              // shallower axis, pushing lblSor× the penetration plus
              // LBL_EPS past touching so cascades damp instead of cycling.
              let axV, dir;
              if (oy <= ox) {
                axV = oy * WEB.lblSor + LBL_EPS;
                dir = py[j] >= py[i] ? 1 : -1; // j >= i on ties: deterministic
              } else {
                axV = ox * WEB.lblSor + LBL_EPS;
                const ci = px[i] + (ex0[i] + ex1[i]) / 2;
                const cj = px[j] + (ex0[j] + ex1[j]) / 2;
                dir = cj >= ci ? 1 : -1;
              }
              if (pinned[i]) {
                if (oy <= ox) py[j] += dir * axV; else px[j] += dir * axV;
              } else if (pinned[j]) {
                if (oy <= ox) py[i] -= dir * axV; else px[i] -= dir * axV;
              } else {
                const h = axV / 2;
                if (oy <= ox) { py[i] -= dir * h; py[j] += dir * h; }
                else { px[i] -= dir * h; px[j] += dir * h; }
              }
              moved = true;
            }
          }
        }
      }
      if (!moved) break; // converged early — deterministic either way
    }
  }

  // Priority label fade — the fallback guarantee. Where label boxes STILL
  // intersect after (or instead of, above lblRectMaxN) the separation
  // pass, the higher-value node keeps its label and the other fades until
  // hover/selection/search brings it back (CSS class "lblfade"; the dot
  // always stays). Priority: root > domain > unit > file > symbol, bigger
  // subtree first inside a rank, tree id as the deterministic tie-break.
  const LBL_RANK = { root: 0, domain: 1, unit: 2, file: 3, sym: 4 };
  function computeLabelFades(shown) {
    const faded = new Set();
    const order = shown
      .map((_, i) => i)
      .sort((a, b) => {
        const A = shown[a], B = shown[b];
        const r = LBL_RANK[A.type] - LBL_RANK[B.type];
        if (r) return r;
        if (A.nsyms !== B.nsyms) return B.nsyms - A.nsyms;
        return A.id < B.id ? -1 : 1;
      });
    const cell = 260; // ≥ the widest possible label box
    const grid = new Map();
    for (const i of order) {
      const nd = shown[i];
      const e = webLabelExtents(nd);
      const x0 = nd.x + e.x0, x1 = nd.x + e.x1;
      const y0 = nd.y - e.y, y1 = nd.y + e.y;
      const gx0 = Math.floor(x0 / cell), gx1 = Math.floor(x1 / cell);
      const gy0 = Math.floor(y0 / cell), gy1 = Math.floor(y1 / cell);
      let hit = false;
      for (let gx = gx0; gx <= gx1 && !hit; gx++) {
        for (let gy = gy0; gy <= gy1 && !hit; gy++) {
          const b = grid.get(gx + ":" + gy);
          if (!b) continue;
          for (const q of b) {
            // Same epsilon as the separation pass: a sub-pixel graze on the
            // padded boxes is not a collision worth hiding a label over.
            if (x0 + LBL_EPS < q[2] && q[0] + LBL_EPS < x1 &&
                y0 + LBL_EPS < q[3] && q[1] + LBL_EPS < y1) { hit = true; break; }
          }
        }
      }
      if (hit) {
        faded.add(nd.id);
        continue;
      }
      const box = [x0, y0, x1, y1];
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          const key = gx + ":" + gy;
          const b = grid.get(key);
          if (b) b.push(box);
          else grid.set(key, [box]);
        }
      }
    }
    return faded;
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
    // The repulsion radius grows with the spread knob so a loosened
    // layout keeps pushing until the new equilibrium, never past 1× tight.
    const cutoff = (n > WEB.bigN ? WEB.cutoffBig : WEB.cutoff) * Math.max(1, physScale);
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
    // The last word after the sim: resolve residual dot overlaps, then
    // label-box overlaps, then commit. (drawWeb's priority fade covers
    // whatever the budgets or pinned-pinned pairs leave behind.)
    const finish = () => {
      resolveOverlaps(px, py, rv, pinned);
      resolveLabelRects(px, py, shown, pinned);
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
    // the final picture is the same. Head and chunk scale with the budget
    // (300-tick fresh layout keeps its 60/20 split; the 90-tick drop or
    // expand re-settle gets 18/6) — with a fixed 60-tick head, a pin-drop
    // swallowed ~94% of the neighbor motion into one snapped frame
    // (~100px jump, then two ~6px frames); proportional pacing spreads the
    // same ticks over ~12 frames so neighbors visibly glide into place.
    let t = 0;
    const head = Math.min(ticks, Math.ceil(ticks / 5));
    for (; t < head; t++) webTick(px, py, qv, springs, hubOf, pinned, cutoff, webAlpha(t, ticks));
    if (t >= ticks) { finish(); return; } // caller paints the final frame
    commit();
    const chunkTicks = Math.max(6, Math.ceil(ticks / 15));
    const chunk = () => {
      if (token !== webAnim || layoutMode !== "web") return; // superseded
      const end = Math.min(ticks, t + chunkTicks);
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
    // Label LOD for dense web views: each label tier fades out (CSS
    // opacity) below the zoom where its text can actually resolve, instead
    // of piling into an unreadable smear. Breakpoints are pure functions of
    // k, calibrated on the eShop graph (3355 nodes @ 1200×800): mean
    // nearest-neighbor spacing at fit is ~52 graph px for units, ~24 for
    // files, ~12 for symbols — so units read from ~0.45 (5px text, clear of
    // neighbors), files from ~0.7 (8px text, spacing ≈ 17px), and symbols
    // only from ~1.1 (11px text, spacing ≈ 13px). Below each point the tier
    // was sub-legible smear, not information. Only web-drawn nodes carry
    // the cm-w-* classes the CSS keys on, so tree mode is untouched.
    if (svg.dataset) {
      svg.dataset.z =
        T.k < 0.45 ? "far" : T.k < 0.7 ? "mid" : T.k < 1.1 ? "near" : "close";
    }
  }

  /* ---- Ontology lens helpers (H11) ----
   * Layer flow: dependencies should point INWARD, toward the Domain core
   * (Presentation → Infrastructure → Application → Domain). An edge whose
   * source layer is deeper than its target's points OUTWARD — the
   * architecture smell the layers lens exists to expose. Layers live on
   * the wire nodes' `layer` property (TrailTracker stamps units/files);
   * unranked or missing layers never flag. */
  const LAYER_RANK = { Domain: 0, Application: 1, Infrastructure: 2, Presentation: 3 };
  function depViolates(aReal, bReal) {
    const la = LAYER_RANK[prop(aReal, "layer")];
    const lb = LAYER_RANK[prop(bReal, "layer")];
    return la !== undefined && lb !== undefined && la < lb;
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
    if (lens !== "containment") {
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
          // Layers lens: an outward-pointing dependency paints red.
          const viol = lens === "layers" && depViolates(a.real, b.real) ? " viol" : "";
          // Count label sits at the midpoint, nudged off the line.
          const mx = (a.x + b.x) / 2 - uy * 8;
          const my = (a.y + b.y) / 2 + ux * 8;
          s +=
            `<line class="cm-depweb${viol}" x1="${r2(a.x)}" y1="${r2(a.y)}" x2="${r2(b.x)}" y2="${r2(b.y)}" stroke-width="${r2(w)}"/>` +
            `<circle class="cm-dep-tip${viol}" cx="${r2(b.x - ux * 12)}" cy="${r2(b.y - uy * 12)}" r="2"/>` +
            (d.count
              ? `<text class="cm-dep-count${viol}" x="${r2(mx)}" y="${r2(my + 3)}">${esc(String(d.count))}</text>`
              : "");
        }
      }
    }
    // Priority fade: labels whose boxes still intersect a higher-value
    // node's label give way (dot stays; hover/selection/search restores).
    const lblFades = computeLabelFades(shown);
    for (const n of shown) {
      const hasKids = n.children.length > 0;
      const collapsed = hasKids && n._collapsed;
      const r = nodeR(n);
      const col = nodeColor(n);
      const fill = collapsed ? col : hasKids ? "var(--bg)" : col;
      const pinnedHere = webPins.has(n.id);
      const cls = ["cm-node", "cm-w-" + n.type];
      if (lblFades.has(n.id)) cls.push("lblfade");
      if (selectedId === n.id) cls.push("selected");
      if (pinnedHere) cls.push("pinned");
      // Mid-drag only (null outside a drag, so settled paints are
      // byte-identical): the node in hand keeps hover-grade emphasis and
      // an always-on label while the pointer is captured.
      if (dragNodeId === n.id) cls.push("dragging");
      if (matchSet) cls.push(matchSet.has(n) ? "match" : "dim");
      if (prevShown.size && !prevShown.has(n.id)) cls.push("fresh");
      const count = collapsed && n.nsyms ? ` <tspan fill="var(--text-faint)">·${n.nsyms}</tspan>` : "";
      const lx = r + 7;
      // In a web there are no columns to guard — labels always sit to the
      // right of the dot, truncated so dense clusters stay legible.
      const shownName = truncate(n.name, WEB_LBL_TRUNC);
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

  /* ====================================================================
   * Matrix layout (H11) — the readable answer to the hairball.
   *
   * An N×N grid: rows depend on columns, cells colored by coupling count.
   * Nothing is force-placed, so nothing can ever stack or overlap — the
   * matrix is overlap-free BY CONSTRUCTION, which is why load() picks it
   * as the default face of dense graphs. Rendered as an HTML table
   * overlay (#cm-matrix) so column headers can be sticky and vertical;
   * the SVG stage underneath is simply not painted in this mode.
   *
   * The ontology lens picks the cross-tabulation:
   *   coupling    — domain × domain, DEPENDS_ON counts (heat = count)
   *   containment — same grid, presence-only (the SHAPE of coupling)
   *   layers      — layer × layer, aggregated from every DEPENDS_ON whose
   *                 endpoints carry a `layer`; outward cells paint red
   * ================================================================== */
  const matrixEl = document.getElementById("cm-matrix");

  function domainMatrixModel() {
    // Entities: the tree's domain row (business first, infra sunk), only
    // those with a real wire node (synthetic "(ungrouped)" has no deps).
    const ents = root.children.filter((d) => d.real);
    const idx = new Map();
    ents.forEach((d, i) => idx.set(d.real.id, i));
    const m = ents.map(() => new Array(ents.length).fill(0));
    let max = 0, edges = 0;
    for (const fromWire in deps) {
      const i = idx.get(fromWire);
      if (i === undefined) continue;
      for (const d of deps[fromWire]) {
        const j = idx.get(d.id);
        if (j === undefined || j === i) continue;
        m[i][j] += Number(d.count) || 1;
        edges++;
        if (m[i][j] > max) max = m[i][j];
      }
    }
    return {
      kind: "domain",
      labels: ents.map((d) => d.name),
      treeIds: ents.map((d) => d.id),
      colors: ents.map((d) => d.color),
      m, max, edges,
      what: "domains",
    };
  }

  function layerMatrixModel() {
    // Entities: every layer seen on a wire node, canonical ranks first
    // (Domain, Application, Infrastructure, Presentation), the rest
    // alphabetical after them. Counts aggregate every DEPENDS_ON whose
    // both endpoints carry a layer (units, in TrailTracker graphs).
    const seen = new Set();
    for (const id in realById) {
      const l = prop(realById[id], "layer");
      if (l != null && l !== "") seen.add(String(l));
    }
    const labels = [...seen].sort((a, b) => {
      const ra = LAYER_RANK[a] !== undefined ? LAYER_RANK[a] : 99;
      const rb = LAYER_RANK[b] !== undefined ? LAYER_RANK[b] : 99;
      return ra - rb || a.localeCompare(b);
    });
    const idx = new Map();
    labels.forEach((l, i) => idx.set(l, i));
    const m = labels.map(() => new Array(labels.length).fill(0));
    let max = 0, edges = 0;
    for (const fromWire in deps) {
      const la = prop(realById[fromWire], "layer");
      const i = idx.get(la != null ? String(la) : "");
      if (i === undefined) continue;
      for (const d of deps[fromWire]) {
        const lb = prop(realById[d.id], "layer");
        const j = idx.get(lb != null ? String(lb) : "");
        if (j === undefined || j === i) continue;
        m[i][j] += Number(d.count) || 1;
        edges++;
        if (m[i][j] > max) max = m[i][j];
      }
    }
    return { kind: "layer", labels, treeIds: null, colors: null, m, max, edges, what: "layers" };
  }

  // Heat ramps, matched to the app tokens (teal accent, red danger).
  function matrixHeat(v, max) {
    if (!v) return "";
    const t = Math.pow(v / Math.max(1, max), 0.45);
    return `background:rgba(62,201,183,${(0.12 + 0.68 * t).toFixed(3)})`;
  }
  function matrixHeatViol(v, max) {
    const t = Math.min(1, v / Math.max(1, max));
    return `background:rgba(224,104,95,${(0.25 + 0.55 * t).toFixed(3)})`;
  }

  function renderMatrix() {
    if (!matrixEl) return;
    const model = lens === "layers" ? layerMatrixModel() : domainMatrixModel();
    const { labels, treeIds, colors, m, max } = model;
    const n = labels.length;
    const density = lens === "containment";
    const layered = lens === "layers";
    if (!n) {
      matrixEl.innerHTML = `<div class="cm-matrix-empty">nothing to cross-tabulate${
        layered ? " — no node carries a layer" : ""}</div>`;
      visibleEl.textContent = "";
      return;
    }
    let viol = 0;
    let html = `<div class="cm-matrix-scroll"><table role="grid" aria-label="Dependency matrix"><thead><tr><th class="corner">${
      layered ? "from ＼ to" : "depends on ▸"}</th>`;
    for (let j = 0; j < n; j++) {
      html += `<th scope="col"><span>${esc(truncate(labels[j], 22))}</span></th>`;
    }
    html += `</tr></thead><tbody>`;
    for (let i = 0; i < n; i++) {
      const swatch = colors ? `<i class="msw" style="background:${colors[i]}"></i>` : "";
      const rowTid = treeIds ? ` data-t="${treeIds[i]}"` : "";
      html += `<tr><th scope="row"${rowTid}>${swatch}${esc(truncate(labels[i], 22))}</th>`;
      for (let j = 0; j < n; j++) {
        const v = m[i][j];
        if (i === j) {
          html += `<td class="cell diag"></td>`;
          continue;
        }
        const isViol = layered && v > 0 &&
          LAYER_RANK[labels[i]] !== undefined && LAYER_RANK[labels[j]] !== undefined &&
          LAYER_RANK[labels[i]] < LAYER_RANK[labels[j]];
        if (isViol) viol++;
        const style = v ? (isViol ? matrixHeatViol(v, max) : matrixHeat(v, max)) : "";
        const txt = !v ? "" : density ? "●" : String(v);
        const title = `${labels[i]} ${layered ? "depends outward on" : "depends on"} ${labels[j]} — ${v} reference${v === 1 ? "" : "s"}${isViol ? " (LAYER VIOLATION: points outward)" : ""}`;
        html += `<td class="cell${isViol ? " viol" : ""}${density && v ? " dens" : ""}"` +
          (style ? ` style="${style}"` : "") +
          (v ? ` title="${esc(title)}"` : "") +
          (treeIds ? ` data-t="${treeIds[i]}"` : "") +
          `>${txt}</td>`;
      }
      html += `</tr>`;
    }
    html += `</tbody></table></div>`;
    html += `<div class="cm-matrix-cap">${
      layered
        ? (viol
            ? `row → column flow between layers. <b>${viol} cell${viol === 1 ? "" : "s"} point outward (red) — dependencies should flow toward Domain.</b>`
            : "row → column flow between layers. no outward (red) dependencies — flow points inward.")
        : density
          ? "presence only — the shape of the coupling, no magnitudes. dense columns are shared sinks."
          : "row depends on column, cells count references. a bright COLUMN is a dependency sink; a bright ROW leans on everything."
    }</div>`;
    matrixEl.innerHTML = html;
    visibleEl.textContent = `${n}×${n} ${model.what}`;
  }

  function render() {
    if (!root) return;
    if (layoutMode === "matrix") {
      renderMatrix();
      return;
    }
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
    if (lens !== "containment") {
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
          const viol = lens === "layers" && depViolates(a.real, b.real) ? " viol" : "";
          const bow = 46 + Math.abs(a.y - b.y) * 0.12;
          const cx = Math.min(a.x, b.x) - bow;
          const midX = (a.x + b.x) / 2 - bow * 0.72;
          const midY = (a.y + b.y) / 2;
          s +=
            `<path class="cm-dep${viol}" d="M${a.x} ${a.y}C${cx} ${a.y} ${cx} ${b.y} ${b.x} ${b.y}"/>` +
            `<circle class="cm-dep-tip${viol}" cx="${b.x - 9}" cy="${b.y}" r="2"/>` +
            (d.count
              ? `<text class="cm-dep-count${viol}" x="${midX}" y="${midY + 3}">${esc(String(d.count))}</text>`
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
      const colIdx = Math.min(n.depth, colX.length - 1);
      let maxChars = TREE_MAX_CHARS;
      if (labelLeft) {
        const gapLeft = n.depth === 0 ? Infinity : colX[colIdx] - colX[colIdx - 1];
        maxChars = Math.max(8, Math.min(TREE_MAX_CHARS, Math.floor((gapLeft - TREE_GAP_PAD) / TREE_CHARW)));
      } else if (n.depth >= 1 && colIdx < colX.length - 1) {
        const gapRight = colX[colIdx + 1] - colX[colIdx];
        maxChars = Math.max(8, Math.min(TREE_MAX_CHARS, Math.floor((gapRight - TREE_GAP_PAD) / TREE_CHARW)));
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
  //
  // (H10: the Domains/Units/Files/Symbols bulk-expand buttons are gone.
  // Drill-down is the only navigation — a whole repo unfolded to files or
  // symbols was an unreadable smear, so the map no longer offers it.)

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
    if (g) {
      g.setAttribute("transform", `translate(${r2(n.x)},${r2(n.y)})`);
      // No full repaint on this path, so the mid-drag class is applied
      // straight to the live element (idempotent; the post-drop redraw
      // rebuilds the markup without it).
      if (g.classList) g.classList.add("dragging");
    }
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
      if (drag.node) {
        webAnim++; // a running settle animation must not fight the hand
        dragNodeId = drag.node.id; // paint feedback on the node in hand
      }
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
    dragNodeId = null; // the re-settle repaint below drops the mid-drag class
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
    if (layoutMode === "matrix") return; // a table has no camera to fit
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
      // Left padding covers the left-anchored labels of expanded parents;
      // right covers a full 34-char label in the last column.
      minX -= 270; maxX += 290; minY -= 30; maxY += 30;
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

  /* ---- Ontology lens: containment | coupling | layers (H11) ---- */
  function syncLensButtons() {
    document
      .querySelectorAll("#cm-lens button")
      .forEach((b) => b.setAttribute("aria-pressed", b.dataset.l === lens ? "true" : "false"));
  }
  function setLens(l) {
    if (l !== "containment" && l !== "coupling" && l !== "layers") return;
    if (l === lens) { syncLensButtons(); return; }
    lens = l;
    syncLensButtons();
    // A lens never moves a node — it re-dresses the same layout (or
    // re-tabulates the matrix), so no re-sim and no fit.
    render();
  }
  const lensCtl = document.getElementById("cm-lens");
  if (lensCtl) {
    lensCtl.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b || !root) return;
      setLens(b.dataset.l);
    });
  }

  /* ---- Physics / spread control (web mode, H11) ---- */
  const physCtl = document.getElementById("cm-phys");
  let physT = null;
  if (physCtl) {
    physCtl.addEventListener("input", (e) => {
      const v = Math.max(0.4, Math.min(2.6, parseFloat(e.target.value) || 1));
      if (v === physScale) return;
      physScale = v;
      clearTimeout(physT);
      // Debounced full reseed: the layout is a pure function of
      // (visible slice, spread, pins) — sliding back to 1 restores the
      // seeded deterministic picture exactly.
      physT = setTimeout(() => {
        if (layoutMode !== "web" || !root) return;
        webPos = new Map();
        webSig = "";
        prevShown = new Set(); // a re-spread repaints everything; no fade cues
        render();
        fit();
      }, 120);
    });
  }

  /* ---- Matrix interactions: click a row/cell to inspect that domain ---- */
  if (matrixEl) {
    matrixEl.addEventListener("click", (e) => {
      const t = e.target.closest ? e.target.closest("[data-t]") : null;
      if (!t || !t.dataset) return;
      const n = byId[t.dataset.t];
      if (n) showDetail(n);
    });
  }

  /* ---- Layout toggle: Matrix (grid) | Web (force) | Tree (tidy) ---- */
  function syncLayoutButtons() {
    document
      .querySelectorAll("#cm-layout button")
      .forEach((b) => b.setAttribute("aria-pressed", b.dataset.m === layoutMode ? "true" : "false"));
  }

  // Swap the visible stage for the mode: the matrix overlay replaces the
  // SVG canvas; the spread slider only makes sense over the force sim.
  function applyModeChrome() {
    if (matrixEl && matrixEl.classList) matrixEl.classList.toggle("hidden", layoutMode !== "matrix");
    if (wrap.classList) wrap.classList.toggle("matrix-mode", layoutMode === "matrix");
    const pw = document.getElementById("cm-phys-wrap");
    if (pw && pw.classList) pw.classList.toggle("hidden", layoutMode !== "web");
  }

  function setLayoutMode(m) {
    if (m !== "tree" && m !== "web" && m !== "matrix") return;
    if (m === layoutMode) { syncLayoutButtons(); return; }
    layoutMode = m;
    layoutChosen = true;
    webAnim++; // cancel any settle animation from the other mode
    try { localStorage.setItem(LAYOUT_KEY, m); } catch (_) { /* private mode — just not remembered */ }
    syncLayoutButtons();
    applyModeChrome();
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
        `<p><strong>Click</strong> a node to open its children; click it again to fold them ` +
        `all away. Drilling in like this — one node at a time — is how you navigate: the map ` +
        `only ever shows what you have opened, so it stays readable at any size.</p>` +
        `<p><strong>Search</strong> lights up matching files and symbols and opens the path to ` +
        `them. <strong>Drag</strong> to pan, <strong>scroll</strong> to zoom, <strong>Fit</strong> to ` +
        `recenter. Replay this tour any time with the <strong>?</strong> button.</p>` +
        `<p>The map has three faces. Dense repos open as a <strong>Matrix</strong> — an ` +
        `N×N grid where a row depends on a column and bright cells are heavy coupling; ` +
        `nothing can ever overlap there. The <strong>Web</strong> is the force-directed view ` +
        `where domains cluster and dependencies read as lines — <strong>drag a node</strong> to ` +
        `pin it (dashed ring), <strong>double-click</strong> to unpin, <strong>arrow keys</strong> ` +
        `nudge and <strong>P</strong> toggles a pin, and the <strong>spread</strong> slider ` +
        `loosens a dense cluster. The <strong>Tree</strong> is a tidy indented layout for when ` +
        `containment matters most.</p>` +
        `<p>The <strong>lens</strong> picks which relationships drive the view: containment ` +
        `only, dependency coupling, or <strong>layer flow</strong> — where a dependency that ` +
        `points outward (Domain code leaning on Application or Presentation) paints ` +
        `<strong>red</strong>.</p>`,
      target: "#cm-layout",
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
  // Dense graphs open as the MATRIX: past a dozen coupled domains, any
  // force layout reads as a hairball no matter how well it separates —
  // the grid is the view that stays legible (zero overlap by
  // construction). A persisted/explicit layout choice always wins.
  function denseByDefault() {
    const doms = root.children.filter((d) => d.real);
    if (doms.length < 12) return false;
    const domIds = new Set(doms.map((d) => d.real.id));
    let dd = 0;
    for (const fromWire in deps) {
      if (!domIds.has(fromWire)) continue;
      for (const d of deps[fromWire]) if (domIds.has(d.id)) dd++;
    }
    return dd >= 12;
  }

  window.CodeMap = {
    detect,

    // (Re)build the tree from the current wire graph and show it collapsed
    // at the domain level.
    load(name, nodes, rels) {
      buildTree(name, nodes, rels);
      collapseToDomains();
      if (!layoutChosen) layoutMode = denseByDefault() ? "matrix" : "web";
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
      syncLayoutButtons();   // reflect the chosen Matrix|Web|Tree face
      syncLensButtons();     // …and the active ontology lens
      applyModeChrome();     // matrix overlay vs SVG stage, spread slider
      searchInput.value = "";
      matchCountEl.hidden = true;
      detail.classList.add("empty");
      detail.innerHTML = EMPTY_DETAIL;
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
      if (matrixEl) matrixEl.innerHTML = "";
      vp.innerHTML = "";
      statsEl.innerHTML = "";
      visibleEl.textContent = "";
      matchCountEl.hidden = true;
      detail.classList.add("empty");
      detail.innerHTML = EMPTY_DETAIL;
    },
  };
})();
