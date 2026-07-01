# Ecosystem role: AUTHORS / RENDERS

Ontoloom is the Geist Stack's visual surface: where humans author ontologies
and review the graphs the other tools produce.

Edges:
- Renders and edits graph JSONL emitted by [[trailtracker]] (code graphs,
  metadata graphs, the stack's own meta-view).
- The v0.2 markdown-vault importer reads `[[wikilink]]` note collections —
  including [[ghostie]]'s memory vault — as graphs.
- Client-facing: the ontology-review canvas for consulting engagements.
- Governed by [[bauplan]]; goal prompts in `prompts/`, ledger in
  `docs/backlog.md`.
