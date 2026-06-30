# Ontoloom

**A lightweight, airgapped ontology & knowledge-graph builder — for people who think in ideas, not Cypher.**

Ontoloom is a single Rust binary with **zero external dependencies**. Run it and a visual graph editor opens in your browser. Draw out your ideas as nodes and links, then export them as Neo4j-ready **JSONL**, a runnable **Cypher** script, plain **JSON**, or **GraphML** — ready to load into Neo4j, Gephi, yEd, or back into Ontoloom.

It runs **entirely on your machine, on `127.0.0.1`, with no network access whatsoever.** No accounts, no cloud, no telemetry, nothing to fetch. Drop the binary on an airgapped box and it just works.

```
┌─────────────────────────────────────────────┐
│  ontoloom — airgapped ontology builder        │
└─────────────────────────────────────────────┘

  Editor:    http://127.0.0.1:7878/
  Data file: ./ontoloom-graph.json
```

---

## Why

Knowledge graphs are a great way to organize ideas, but the tooling assumes you already speak a query language. Ontoloom is for the **domain expert, the researcher, the analyst** who has the ideas and the relationships in their head and just wants to lay them out visually and hand a clean file to an engineer (or to Neo4j directly).

Design constraints, on purpose:

- **No external dependencies.** The Rust side is `std` only — its own JSON codec, its own tiny HTTP server. Auditable in an afternoon.
- **Airgapped.** Binds to loopback, embeds its entire UI in the binary, never opens an outbound connection.
- **One file.** A ~450 KB binary. Copy it, run it, done.
- **Boring formats.** It exports the formats other tools already read, instead of inventing a new one.

## Install

You need a [Rust toolchain](https://rustup.rs/) to build (nothing else):

```bash
git clone https://github.com/jonathanpopham/ontoloom
cd ontoloom
cargo build --release
./target/release/ontoloom
```

Your browser opens to the editor automatically. That's it.

## Usage

```
ontoloom [OPTIONS]

OPTIONS:
    -p, --port <PORT>    Port to serve on (default: 7878)
    -d, --data <FILE>    Graph autosave file (default: ./ontoloom-graph.json)
        --no-open        Do not open a browser automatically
    -h, --help           Print help
    -V, --version        Print version
```

### Building a graph

| Action            | How                                                        |
|-------------------|-----------------------------------------------------------|
| **Add an idea**   | Double-click empty canvas (or the **＋ Add idea** button)  |
| **Name / type it**| Click it, edit in the panel. "Types" become Neo4j labels. |
| **Add properties**| Click it, **+ Add property** — key/value pairs            |
| **Move**          | Drag it                                                    |
| **Connect**       | Click **⤳ Connect**, then click a source idea and a target |
| **Edit a link**   | Click the link's label, set its relationship type         |
| **Delete**        | Select, then press <kbd>Delete</kbd>                       |
| **Pan / zoom**    | Drag the background / scroll wheel                         |

Your work **autosaves** to disk and to the browser's local storage as you go, so a refresh — or a crash — never loses it.

## Export formats

Hit **⬇ Export** and pick one. Every format is generated in Rust, server-side.

### 1. Neo4j JSONL (`.jsonl`)
One JSON object per line, matching the shape Neo4j's APOC library reads. Import with:

```cypher
CALL apoc.import.json("file:///ontology.jsonl");
```

```json
{"type":"node","id":"n1","labels":["Person"],"properties":{"name":"Alice","age":30}}
{"type":"relationship","id":"r1","label":"KNOWS","start":{"id":"n1","labels":["Person"]},"end":{"id":"n2","labels":["Person"]},"properties":{"since":2020}}
```

### 2. Cypher script (`.cypher`)
A ready-to-run `CREATE` script. Paste it into the Neo4j Browser or pipe it to `cypher-shell`:

```cypher
CREATE (`n1`:Person {name: "Alice", age: 30})
CREATE (`n2`:Person {name: "Bob"})
CREATE (`n1`)-[:KNOWS {since: 2020}]->(`n2`)
;
```

```bash
cat ontology.cypher | cypher-shell -u neo4j -p password
```

### 3. Ontoloom JSON (`.json`)
A node-link document that round-trips back into Ontoloom via **📂 Import** (it also keeps your layout positions). Easy to consume from any language.

### 4. GraphML (`.graphml`)
Standard graph XML for **Gephi**, **yEd**, and `apoc.import.graphml`.

## How it stays dependency-free

```
src/
  main.rs      CLI args, loopback bind, browser launch
  server.rs    a small HTTP/1.1 server on std::net (loopback only)
  json.rs      a hand-written JSON parser + serializer
  model.rs     the graph model + wire-format validation
  export.rs    the four exporters
  assets.rs    include_str! of the embedded web UI
web/
  index.html   the single-page editor shell
  app.js       vanilla-JS SVG graph editor (no frameworks)
  style.css
```

The frontend is embedded into the binary at compile time with `include_str!`, so the shipped executable has nothing to download. The backend speaks just enough HTTP/1.1 to serve those assets and a handful of JSON endpoints. `Cargo.toml` has an empty `[dependencies]` section, and that is the whole point.

## Testing

```bash
cargo test
```

Covers the JSON round-trip, graph validation (including rejecting links to non-existent nodes), and each exporter.

## License

MIT © Jonathan Popham. See [LICENSE](LICENSE).
