# Headless UI harnesses (preserved from the build session per the bead-compliance audit)

Node + DOM-stub harnesses that drove the code map against the real eShop
hierarchy graph (3,262 nodes). They reference session-era worktree paths —
point them at ../../web/codemap.js and this directory's fixture when running:

- codemap-harness.js — H5/H2 drill-down (20 assertions)
- webmap-harness.js  — H7 web/force layout (26 assertions)
- webmap-h9-harness.js — H9 collision + pin/drag (35 assertions)
- eshop-hierarchy.ontoloom.json — the real-data fixture all three use
