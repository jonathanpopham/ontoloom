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

    const domTree = new Map(); // domain wire id -> tree node
    let hueIdx = 0;
    for (const d of nodes) {
      if (level(d) !== "domain") continue;
      const t = tnode("domain", d.caption || d.id, d, 1, {
        color: DOMAIN_HUES[hueIdx++ % DOMAIN_HUES.length],
      });
      domTree.set(d.id, t);
      root.children.push(t);
    }
    let ungrouped = null; // files whose CONTAINS carry no domain parent

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
        n._collapsed = n.depth >= d;
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
   * Rendering — string-built SVG of only the expanded slice
   * ================================================================== */
  function applyT() {
    vp.setAttribute("transform", `translate(${T.x},${T.y}) scale(${T.k})`);
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

  function render() {
    if (!root) return;
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
      const r = n.type === "root" ? 7 : n.type === "domain" ? 6 : n.type === "unit" ? 5 : n.type === "sym" ? 3 : 4;
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
      const labelLeft = hasKids && !collapsed;
      const gapLeft = n.depth === 0 ? Infinity : COL[Math.min(n.depth, COL.length - 1)] - COL[Math.min(n.depth, COL.length - 1) - 1];
      const maxChars = labelLeft ? Math.max(8, Math.min(34, Math.floor((gapLeft - 45) / 7))) : 34;
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

    // Facts straight off the wire node: archetype / layer / domain / unit.
    const facts = [];
    if (real) {
      for (const key of ["archetype", "layer", "domain", "unit"]) {
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

  let drag = null;
  wrap.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, tx: T.x, ty: T.y };
    dragMoved = false;
    // Record the node NOW, before any pointer capture can redirect e.target.
    const g = e.target.closest(".cm-node");
    downId = g ? g.dataset.id : null;
  });
  wrap.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!dragMoved && Math.abs(dx) + Math.abs(dy) > 4) {
      dragMoved = true; // only now is it a pan, not a click
      wrap.classList.add("grabbing");
      try { wrap.setPointerCapture(e.pointerId); } catch (_) {}
    }
    if (dragMoved) {
      T.x = drag.tx + dx;
      T.y = drag.ty + dy;
      applyT();
    }
  });
  wrap.addEventListener("pointerup", (e) => {
    const wasClick = drag && !dragMoved && downId;
    drag = null;
    wrap.classList.remove("grabbing");
    try { wrap.releasePointerCapture(e.pointerId); } catch (_) {}
    if (wasClick) {
      const n = byId[downId];
      if (n) {
        toggleNode(n);
        showDetail(n);
        render();
      }
    }
    downId = null;
  });

  // Keyboard: Enter or Space on a focused node behaves exactly like a click.
  // render() rebuilds the SVG, so focus is put back on the same node after.
  svg.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const g = e.target.closest ? e.target.closest(".cm-node") : null;
    if (!g) return;
    e.preventDefault();
    const n = byId[g.dataset.id];
    if (!n) return;
    toggleNode(n);
    showDetail(n);
    render();
    const again = vp.querySelector(`[data-id="${n.id}"]`);
    if (again) again.focus();
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
    // Left padding covers the left-anchored labels of expanded parents.
    minX -= 250; maxX += 260; minY -= 30; maxY += 30;
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
        `you can tell them apart anywhere in the map.</p>`,
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
        `recenter. Replay this tour any time with the <strong>?</strong> button.</p>`,
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
      vp.innerHTML = "";
      statsEl.innerHTML = "";
      visibleEl.textContent = "";
      matchCountEl.hidden = true;
      detail.classList.add("empty");
      detail.innerHTML = EMPTY_DETAIL;
    },
  };
})();
