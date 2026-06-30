//! The Ontoloom graph model and the bridge between the browser's wire format
//! and the exporters.
//!
//! Wire format (what the GUI sends / persists):
//! ```json
//! {
//!   "nodes": [
//!     {"id":"n1","labels":["Person"],"caption":"Alice",
//!      "properties":{"age":30}, "x":120, "y":80}
//!   ],
//!   "relationships": [
//!     {"id":"r1","type":"KNOWS","from":"n1","to":"n2",
//!      "properties":{"since":2020}}
//!   ]
//! }
//! ```

use crate::json::Json;

#[derive(Debug, Clone)]
pub struct Node {
    pub id: String,
    pub labels: Vec<String>,
    /// A human-friendly display name. Exported as a `name` property when set.
    pub caption: String,
    pub properties: Vec<(String, Json)>,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone)]
pub struct Relationship {
    pub id: String,
    pub rel_type: String,
    pub from: String,
    pub to: String,
    pub properties: Vec<(String, Json)>,
}

#[derive(Debug, Clone, Default)]
pub struct Graph {
    pub nodes: Vec<Node>,
    pub relationships: Vec<Relationship>,
}

impl Graph {
    /// Parse the wire format into a validated graph. Returns a human-readable
    /// error if the structure is wrong or if a relationship references a node
    /// that does not exist.
    pub fn from_wire(value: &Json) -> Result<Graph, String> {
        let nodes_json = value
            .get("nodes")
            .and_then(|v| v.as_array())
            .ok_or("missing 'nodes' array")?;

        let mut nodes = Vec::with_capacity(nodes_json.len());
        for (i, n) in nodes_json.iter().enumerate() {
            let id = n
                .get_str("id")
                .ok_or_else(|| format!("node #{} is missing an 'id'", i))?
                .to_string();
            let labels = string_array(n.get("labels"));
            let caption = n.get_str("caption").unwrap_or("").to_string();
            let properties = object_pairs(n.get("properties"));
            let x = n.get("x").and_then(num).unwrap_or(0.0);
            let y = n.get("y").and_then(num).unwrap_or(0.0);
            nodes.push(Node {
                id,
                labels,
                caption,
                properties,
                x,
                y,
            });
        }

        let rels_json = value
            .get("relationships")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let mut relationships = Vec::with_capacity(rels_json.len());
        for (i, r) in rels_json.iter().enumerate() {
            let id = r
                .get_str("id")
                .ok_or_else(|| format!("relationship #{} is missing an 'id'", i))?
                .to_string();
            let rel_type = r
                .get_str("type")
                .filter(|t| !t.is_empty())
                .unwrap_or("RELATED_TO")
                .to_string();
            let from = r
                .get_str("from")
                .ok_or_else(|| format!("relationship #{} is missing 'from'", i))?
                .to_string();
            let to = r
                .get_str("to")
                .ok_or_else(|| format!("relationship #{} is missing 'to'", i))?
                .to_string();
            let properties = object_pairs(r.get("properties"));
            relationships.push(Relationship {
                id,
                rel_type,
                from,
                to,
                properties,
            });
        }

        let graph = Graph {
            nodes,
            relationships,
        };
        graph.validate()?;
        Ok(graph)
    }

    fn validate(&self) -> Result<(), String> {
        let ids: std::collections::HashSet<&str> =
            self.nodes.iter().map(|n| n.id.as_str()).collect();
        if ids.len() != self.nodes.len() {
            return Err("duplicate node ids detected".to_string());
        }
        for r in &self.relationships {
            if !ids.contains(r.from.as_str()) {
                return Err(format!(
                    "relationship '{}' references unknown source node '{}'",
                    r.id, r.from
                ));
            }
            if !ids.contains(r.to.as_str()) {
                return Err(format!(
                    "relationship '{}' references unknown target node '{}'",
                    r.id, r.to
                ));
            }
        }
        Ok(())
    }

    /// The full set of properties a node should export with — its explicit
    /// properties plus a synthesized `name` from the caption when present and
    /// not already overridden.
    pub fn node_export_properties(&self, node: &Node) -> Vec<(String, Json)> {
        let mut props = node.properties.clone();
        let has_name = props.iter().any(|(k, _)| k == "name");
        if !node.caption.is_empty() && !has_name {
            props.insert(0, ("name".to_string(), Json::Str(node.caption.clone())));
        }
        props
    }
}

fn num(v: &Json) -> Option<f64> {
    match v {
        Json::Num(n) => Some(*n),
        _ => None,
    }
}

fn string_array(value: Option<&Json>) -> Vec<String> {
    match value.and_then(|v| v.as_array()) {
        Some(arr) => arr
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .filter(|s| !s.is_empty())
            .collect(),
        None => Vec::new(),
    }
}

fn object_pairs(value: Option<&Json>) -> Vec<(String, Json)> {
    match value.and_then(|v| v.as_object()) {
        Some(pairs) => pairs.clone(),
        None => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse;

    #[test]
    fn parses_a_minimal_graph() {
        let wire = parse(
            r#"{"nodes":[{"id":"n1","labels":["Person"],"caption":"Alice"}],
                "relationships":[]}"#,
        )
        .unwrap();
        let g = Graph::from_wire(&wire).unwrap();
        assert_eq!(g.nodes.len(), 1);
        assert_eq!(g.nodes[0].caption, "Alice");
    }

    #[test]
    fn rejects_dangling_relationship() {
        let wire = parse(
            r#"{"nodes":[{"id":"n1"}],
                "relationships":[{"id":"r1","type":"KNOWS","from":"n1","to":"ghost"}]}"#,
        )
        .unwrap();
        let err = Graph::from_wire(&wire).unwrap_err();
        assert!(err.contains("unknown target"));
    }

    #[test]
    fn synthesizes_name_from_caption() {
        let wire = parse(r#"{"nodes":[{"id":"n1","caption":"Bob"}],"relationships":[]}"#).unwrap();
        let g = Graph::from_wire(&wire).unwrap();
        let props = g.node_export_properties(&g.nodes[0]);
        assert_eq!(props[0].0, "name");
    }
}
