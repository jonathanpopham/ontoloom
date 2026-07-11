# Headless UI harnesses (the code map's regression gate)

Node + DOM-stub harnesses that drive web/codemap.js against the real eShop
hierarchy graph (3,262 nodes). Run each with `node <file>` from this
directory; every one must end `ALL ASSERTIONS PASSED`.

- codemap-harness.js — drill-down data handling (detect / lazy expand /
  search / detail) + the H10 drill-only contract: no bulk expand-to-level
  buttons exist anywhere
- webmap-harness.js  — web/force layout: stored-preference honor,
  determinism, toggle round-trip, search-driven deep states, and the
  full-scale visible-label no-overlap guarantee (priority fade)
- webmap-h9-harness.js — collision (dots AND label boxes) + pin/drag: zero
  label-box overlaps at the domains view and with every domain drilled
  (was 63 pairs pre-H10), tree-mode no-touch spacing at the files depth
- webmap-h11-harness.js — the H11 surface: MATRIX is the default face of
  dense graphs (real aggregated counts, overlap-free by construction),
  the ontology lens (containment / coupling / layer flow with red outward
  violations) drives matrix AND web, the physics/spread slider is live +
  deterministic + reversible, and drilling rings children around their
  parent with zero stacking at every depth (was 29 residual overlaps at
  the files depth pre-H11)
- eshop-hierarchy.ontoloom.json — the real-data fixture all four use

Navigation contract (H10, Jonathan's directive): drill-down is the ONLY
navigation — click a node to open its children, click again to fold, search
auto-opens paths to matches. The Domains/Units/Files/Symbols bulk-expand
buttons are gone and must not come back; deep states in these harnesses are
reached the way a user reaches them (clicks and searches).
