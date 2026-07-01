# Ontoloom Backlog / Thread Ledger

Started 2026-07-01. Idea ledger for Ontoloom; follows the same convention as
TrailTracker's `docs/backlog.md` (numbered items, statuses `TODO` · `WIP` ·
`DONE` · `BLOCKED` · `BRAINSTORM`).

- **OL-1** `WIP` — **M1 DONE** (commit d0d5b33, 2026-07-01): schema model layer,
  hard schema self-validation, inheritance-aware soft warnings, save response
  carries warnings. M2 (schema editor UI) next; M2–M5 still need the
  truncation reconstructions reviewed. **v0.2 goal prompt — RECEIVED 2026-07-01**, filed at
  [`prompts/2026-07-01-goal-v0.2.md`](../prompts/2026-07-01-goal-v0.2.md):
  schema layer (M1) → schema editor UI (M2) → schema through exports (M3) →
  OWL/Turtle export (M4) → Obsidian vault importer (M5) → ship 0.2.0 without
  pushing (M6). ⚠ The filed copy has paste-truncated lines (marked
  `[…truncated]`); Jonathan to re-paste/patch before executing M2–M5.
  Note the convergence: M5's vault importer means a markdown-vault ghostie
  memory store becomes directly renderable in Ontoloom (see ghostie
  TODO.txt Priority 6 / the ecosystem thread).
- **OL-2** `TODO` **Ecosystem membership.** Adopt the federation contract
  (SOUL.md, ECOSYSTEM.md, prompts/) when the standard lands. Ontoloom's role:
  the AUTHORS/RENDERS node — visual ontology authoring + graph review for
  TrailTracker output (code graphs, Salesforce org graphs), ghostie memory
  graphs, and the Perfecting Peds ontology-review sessions with the client.
- **OL-3** `TODO` **Ecosystem-graph import path.** Load the `/ecosystem` skill's
  robot-mode JSONL (and TrailTracker graph JSONL) for the meta-view of the
  stack itself. First concrete consumer: Perfecting Peds Phase 0 demo
  (TrailTracker over synthetic Salesforce metadata → Ontoloom).
