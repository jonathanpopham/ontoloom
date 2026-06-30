//! Exporters that turn an Ontoloom [`Graph`] into the formats people actually
//! load into other tools.
//!
//! - `jsonl` — one JSON object per line, matching the shape Neo4j's APOC
//!   `apoc.import.json` reads (`apoc.export.json.all` output).
//! - `cypher` — a runnable `CREATE` script for the Neo4j Browser / cypher-shell.
//! - `json` — a pretty node-link document, re-importable into Ontoloom.
//! - `graphml` — GraphML XML for Gephi, yEd, and APOC's `apoc.import.graphml`.

use crate::json::{obj, s, Json};
use crate::model::Graph;

pub struct ExportFormat {
    pub key: &'static str,
    pub filename: &'static str,
    pub content_type: &'static str,
}

pub const FORMATS: &[ExportFormat] = &[
    ExportFormat {
        key: "jsonl",
        filename: "ontology.jsonl",
        content_type: "application/x-ndjson",
    },
    ExportFormat {
        key: "cypher",
        filename: "ontology.cypher",
        content_type: "text/plain; charset=utf-8",
    },
    ExportFormat {
        key: "json",
        filename: "ontology.json",
        content_type: "application/json",
    },
    ExportFormat {
        key: "graphml",
        filename: "ontology.graphml",
        content_type: "application/xml",
    },
];

pub fn format_for(key: &str) -> Option<&'static ExportFormat> {
    FORMATS.iter().find(|f| f.key == key)
}

pub fn export(graph: &Graph, key: &str) -> Result<String, String> {
    match key {
        "jsonl" => Ok(to_jsonl(graph)),
        "cypher" => Ok(to_cypher(graph)),
        "json" => Ok(to_node_link_json(graph)),
        "graphml" => Ok(to_graphml(graph)),
        other => Err(format!("unknown export format '{}'", other)),
    }
}

// ---------------------------------------------------------------------------
// JSONL (Neo4j / APOC compatible)
// ---------------------------------------------------------------------------

fn to_jsonl(graph: &Graph) -> String {
    let mut out = String::new();
    for node in &graph.nodes {
        let line = obj(vec![
            ("type", s("node")),
            ("id", s(&node.id)),
            (
                "labels",
                Json::Arr(node.labels.iter().map(|l| s(l)).collect()),
            ),
            ("properties", Json::Obj(graph.node_export_properties(node))),
        ]);
        out.push_str(&line.to_compact());
        out.push('\n');
    }
    for rel in &graph.relationships {
        let start_labels = node_labels(graph, &rel.from);
        let end_labels = node_labels(graph, &rel.to);
        let line = obj(vec![
            ("type", s("relationship")),
            ("id", s(&rel.id)),
            ("label", s(&rel.rel_type)),
            (
                "start",
                obj(vec![
                    ("id", s(&rel.from)),
                    ("labels", Json::Arr(start_labels)),
                ]),
            ),
            (
                "end",
                obj(vec![("id", s(&rel.to)), ("labels", Json::Arr(end_labels))]),
            ),
            ("properties", Json::Obj(rel.properties.clone())),
        ]);
        out.push_str(&line.to_compact());
        out.push('\n');
    }
    out
}

fn node_labels(graph: &Graph, id: &str) -> Vec<Json> {
    graph
        .nodes
        .iter()
        .find(|n| n.id == id)
        .map(|n| n.labels.iter().map(|l| s(l)).collect())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Cypher script
// ---------------------------------------------------------------------------

fn to_cypher(graph: &Graph) -> String {
    let mut out = String::new();
    out.push_str("// Ontoloom export — load in Neo4j Browser or cypher-shell.\n");
    out.push_str("// Each node becomes a backticked variable so relationships can reference it.\n\n");

    for node in &graph.nodes {
        let var = cypher_var(&node.id);
        let labels: String = node
            .labels
            .iter()
            .map(|l| format!(":{}", cypher_label(l)))
            .collect();
        let labels = if labels.is_empty() {
            ":Node".to_string()
        } else {
            labels
        };
        let props = cypher_props(&graph.node_export_properties(node));
        out.push_str(&format!("CREATE ({}{} {})\n", var, labels, props));
    }

    if !graph.relationships.is_empty() {
        out.push('\n');
    }
    for rel in &graph.relationships {
        let from = cypher_var(&rel.from);
        let to = cypher_var(&rel.to);
        let rtype = cypher_label(&rel.rel_type);
        let props = cypher_props(&rel.properties);
        let rel_clause = if props == "{}" {
            format!("[:{}]", rtype)
        } else {
            format!("[:{} {}]", rtype, props)
        };
        out.push_str(&format!("CREATE ({})-{}->({})\n", from, rel_clause, to));
    }
    out.push_str(";\n");
    out
}

/// A Cypher variable derived from a node id. Always backticked so arbitrary
/// ids are safe.
fn cypher_var(id: &str) -> String {
    format!("`{}`", id.replace('`', "``"))
}

/// A label or relationship type. Backticked only when it is not a plain
/// identifier, to keep common cases readable.
fn cypher_label(name: &str) -> String {
    let plain = !name.is_empty()
        && name.chars().next().map(|c| c.is_ascii_alphabetic() || c == '_').unwrap_or(false)
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if plain {
        name.to_string()
    } else {
        format!("`{}`", name.replace('`', "``"))
    }
}

fn cypher_props(props: &[(String, Json)]) -> String {
    if props.is_empty() {
        return "{}".to_string();
    }
    let parts: Vec<String> = props
        .iter()
        .map(|(k, v)| format!("{}: {}", cypher_key(k), cypher_value(v)))
        .collect();
    format!("{{{}}}", parts.join(", "))
}

fn cypher_key(key: &str) -> String {
    let plain = !key.is_empty()
        && key.chars().next().map(|c| c.is_ascii_alphabetic() || c == '_').unwrap_or(false)
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if plain {
        key.to_string()
    } else {
        format!("`{}`", key.replace('`', "``"))
    }
}

fn cypher_value(value: &Json) -> String {
    match value {
        Json::Null => "null".to_string(),
        Json::Bool(b) => b.to_string(),
        Json::Num(_) => value.to_compact(),
        Json::Str(text) => cypher_string(text),
        Json::Arr(items) => {
            let parts: Vec<String> = items.iter().map(cypher_value).collect();
            format!("[{}]", parts.join(", "))
        }
        // Nested objects aren't valid Neo4j property values; serialize as a
        // string so no data is silently lost.
        Json::Obj(_) => cypher_string(&value.to_compact()),
    }
}

fn cypher_string(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

// ---------------------------------------------------------------------------
// Node-link JSON (re-importable into Ontoloom)
// ---------------------------------------------------------------------------

fn to_node_link_json(graph: &Graph) -> String {
    let nodes: Vec<Json> = graph
        .nodes
        .iter()
        .map(|n| {
            obj(vec![
                ("id", s(&n.id)),
                ("labels", Json::Arr(n.labels.iter().map(|l| s(l)).collect())),
                ("caption", s(&n.caption)),
                ("properties", Json::Obj(n.properties.clone())),
                ("x", Json::Num(n.x)),
                ("y", Json::Num(n.y)),
            ])
        })
        .collect();
    let rels: Vec<Json> = graph
        .relationships
        .iter()
        .map(|r| {
            obj(vec![
                ("id", s(&r.id)),
                ("type", s(&r.rel_type)),
                ("from", s(&r.from)),
                ("to", s(&r.to)),
                ("properties", Json::Obj(r.properties.clone())),
            ])
        })
        .collect();
    let doc = obj(vec![
        ("format", s("ontoloom/graph")),
        ("version", Json::Num(1.0)),
        ("nodes", Json::Arr(nodes)),
        ("relationships", Json::Arr(rels)),
    ]);
    doc.to_pretty()
}

// ---------------------------------------------------------------------------
// GraphML
// ---------------------------------------------------------------------------

fn to_graphml(graph: &Graph) -> String {
    let mut out = String::new();
    out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    out.push_str("<graphml xmlns=\"http://graphml.graphdrawing.org/xmlns\">\n");
    out.push_str("  <key id=\"labels\" for=\"node\" attr.name=\"labels\" attr.type=\"string\"/>\n");
    out.push_str("  <key id=\"name\" for=\"node\" attr.name=\"name\" attr.type=\"string\"/>\n");
    out.push_str("  <key id=\"props\" for=\"node\" attr.name=\"properties\" attr.type=\"string\"/>\n");
    out.push_str("  <key id=\"type\" for=\"edge\" attr.name=\"type\" attr.type=\"string\"/>\n");
    out.push_str("  <key id=\"eprops\" for=\"edge\" attr.name=\"properties\" attr.type=\"string\"/>\n");
    out.push_str("  <graph id=\"G\" edgedefault=\"directed\">\n");

    for node in &graph.nodes {
        out.push_str(&format!("    <node id=\"{}\">\n", xml_escape(&node.id)));
        let labels = node.labels.join(":");
        if !labels.is_empty() {
            out.push_str(&format!(
                "      <data key=\"labels\">{}</data>\n",
                xml_escape(&labels)
            ));
        }
        if !node.caption.is_empty() {
            out.push_str(&format!(
                "      <data key=\"name\">{}</data>\n",
                xml_escape(&node.caption)
            ));
        }
        if !node.properties.is_empty() {
            let props = Json::Obj(node.properties.clone()).to_compact();
            out.push_str(&format!(
                "      <data key=\"props\">{}</data>\n",
                xml_escape(&props)
            ));
        }
        out.push_str("    </node>\n");
    }

    for rel in &graph.relationships {
        out.push_str(&format!(
            "    <edge id=\"{}\" source=\"{}\" target=\"{}\">\n",
            xml_escape(&rel.id),
            xml_escape(&rel.from),
            xml_escape(&rel.to)
        ));
        out.push_str(&format!(
            "      <data key=\"type\">{}</data>\n",
            xml_escape(&rel.rel_type)
        ));
        if !rel.properties.is_empty() {
            let props = Json::Obj(rel.properties.clone()).to_compact();
            out.push_str(&format!(
                "      <data key=\"eprops\">{}</data>\n",
                xml_escape(&props)
            ));
        }
        out.push_str("    </edge>\n");
    }

    out.push_str("  </graph>\n");
    out.push_str("</graphml>\n");
    out
}

fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse;

    fn sample() -> Graph {
        let wire = parse(
            r#"{
              "nodes":[
                {"id":"n1","labels":["Person"],"caption":"Alice","properties":{"age":30}},
                {"id":"n2","labels":["Person"],"caption":"Bob","properties":{}}
              ],
              "relationships":[
                {"id":"r1","type":"KNOWS","from":"n1","to":"n2","properties":{"since":2020}}
              ]
            }"#,
        )
        .unwrap();
        Graph::from_wire(&wire).unwrap()
    }

    #[test]
    fn jsonl_has_one_object_per_line() {
        let out = to_jsonl(&sample());
        let lines: Vec<&str> = out.trim().lines().collect();
        assert_eq!(lines.len(), 3); // 2 nodes + 1 relationship
        assert!(lines[0].contains("\"type\":\"node\""));
        assert!(lines[0].contains("\"name\":\"Alice\""));
        assert!(lines[2].contains("\"type\":\"relationship\""));
        assert!(lines[2].contains("\"since\":2020"));
        // Every line must be valid JSON on its own.
        for line in lines {
            assert!(parse(line).is_ok(), "invalid JSONL line: {}", line);
        }
    }

    #[test]
    fn cypher_creates_nodes_and_edges() {
        let out = to_cypher(&sample());
        assert!(out.contains("CREATE (`n1`:Person {name: \"Alice\", age: 30})"));
        assert!(out.contains("CREATE (`n1`)-[:KNOWS {since: 2020}]->(`n2`)"));
    }

    #[test]
    fn json_round_trips_back_into_a_graph() {
        let out = to_node_link_json(&sample());
        let reparsed = Graph::from_wire(&parse(&out).unwrap()).unwrap();
        assert_eq!(reparsed.nodes.len(), 2);
        assert_eq!(reparsed.relationships.len(), 1);
    }

    #[test]
    fn graphml_is_well_formed_enough() {
        let out = to_graphml(&sample());
        assert!(out.contains("<graphml"));
        assert!(out.contains("<node id=\"n1\">"));
        assert!(out.contains("<edge id=\"r1\" source=\"n1\" target=\"n2\">"));
    }
}
