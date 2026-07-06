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

  /* ---- State ---- */
  let root = null;      // synthesized tree (root → domains → units → files → symbols)
  let byId = {};        // tree id -> tree node
  let realById = {};    // wire node id -> wire node
  let deps = {};        // wire node id -> [{id, count}] from DEPENDS_ON
  let matchSet = null;  // search results (tree nodes), null = no active search
  let selectedId = null;
  let T = { x: 60, y: 40, k: 1 }; // pan/zoom transform

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
    (function collect(n) {
      const kids = n._collapsed || !n.children.length ? [] : n.children;
      for (const k of kids) {
        edges.push([n, k]);
        collect(k);
      }
      shown.push(n);
    })(root);

    let s = "";
    for (const [p, c] of edges) {
      const mx = (p.x + c.x) / 2;
      s += `<path class="cm-edge" d="M${p.x} ${p.y}C${mx} ${p.y} ${mx} ${c.y} ${c.x} ${c.y}"/>`;
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
      const count = collapsed && n.nsyms ? ` <tspan fill="var(--text-faint)">·${n.nsyms}</tspan>` : "";
      const lx = r + 7;
      s +=
        `<g class="${cls.join(" ")}" data-id="${n.id}" transform="translate(${n.x},${n.y})">` +
        `<circle r="${r}" fill="${fill}" stroke="${col}" stroke-width="1.6"/>` +
        (collapsed
          ? `<circle r="${r + 3.5}" fill="none" stroke="${col}" stroke-width="1" opacity=".4"/>`
          : "") +
        `<text class="lbl" x="${lx}" y="3.5" font-size="${n.type === "sym" ? 10.5 : 11.5}">` +
        esc(truncate(n.name, 34)) + count + `</text>` +
        `<rect class="hit" x="-${r + 4}" y="-9" width="${lx + Math.min(n.name.length, 34) * 7 + 30}" height="18"/>` +
        `</g>`;
    }
    vp.innerHTML = s;
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

  // Search opens the path to every match (ancestors get expanded) and dims
  // everything else.
  function runSearch(q) {
    if (!root) return;
    if (!q) {
      matchSet = null;
      render();
      return;
    }
    matchSet = new Set();
    (function walk(n, anc) {
      const hay = (n.name + " " + (n.path || "")).toLowerCase();
      if (hay.includes(q)) {
        matchSet.add(n);
        for (const a of anc) {
          matchSet.add(a);
          a._collapsed = false;
        }
      }
      const next = anc.concat(n);
      for (const c of n.children) walk(c, next);
    })(root, []);
    render();
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
    minX -= 40; maxX += 260; minY -= 30; maxY += 30;
    const r = svg.getBoundingClientRect();
    if (!r.width || !r.height) return; // pane not visible yet
    const k = Math.min(2, Math.max(0.1, Math.min(r.width / (maxX - minX), r.height / (maxY - minY))));
    T.k = k;
    T.x = (r.width - (maxX + minX) * k) / 2;
    T.y = (r.height - (maxY + minY) * k) / 2;
    applyT();
  }
  document.getElementById("cm-fit").addEventListener("click", fit);

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
      searchInput.value = "";
      detail.classList.add("empty");
      detail.textContent = "select a node to inspect";
      document
        .querySelectorAll("#cm-levels button")
        .forEach((x) => x.setAttribute("aria-pressed", x.dataset.d === "1" ? "true" : "false"));
      renderStats(nodes);
      render();
      // The pane may have just been unhidden; fit once it has a size.
      requestAnimationFrame(fit);
    },

    clear() {
      root = null;
      byId = {};
      vp.innerHTML = "";
      statsEl.innerHTML = "";
      visibleEl.textContent = "";
    },
  };
})();
