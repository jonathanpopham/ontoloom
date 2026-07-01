# SOUL

Ontoloom lets a domain expert draw what they know — classes, relationships,
instances — and export it as a real ontology, without a server, a framework,
or an internet connection.

**Origin**: built 2026-06-30 in one push as the visual counterpart to
TrailTracker: graphs need eyes and hands, not just emitters.

**Non-negotiables** (these ARE the product):
- `Cargo.toml` `[dependencies]` stays empty; frontend is vanilla JS, no build
  step, embedded via `include_str!`.
- Airgapped: loopback only, zero outbound connections.
- Backward compatible: old graph files load forever; schema is always optional.
- Soft validation only: the expert is allowed to be "wrong" — warnings, never
  blocks.
- Exports are honest: emit only what the target format actually supports.
- Small, readable, hand-written: `Result<_, String>`, tests per file.
