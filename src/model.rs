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
//!   ],
//!   "schema": {
//!     "classes": [{"name":"Author","parent":"Person"}],
//!     "relationshipTypes": [{"name":"WROTE","from":["Author"],"to":["Book"]}]
//!   }
//! }
//! ```
//!
//! `schema` is **always optional**: a graph without one loads, edits, and
//! exports exactly as before. The schema itself is hard-validated (a broken
//! schema is a bug, not an opinion), while graph-against-schema checks are
//! soft — [`Graph::schema_warnings`] — because the domain expert is allowed
//! to be "wrong" while thinking.

use crate::json::Json;

/// A class (node type) in the optional schema. `parent` enables single
/// inheritance: `Author is-a Person` makes an `Author`-labelled node satisfy a
/// `Person` endpoint constraint.
#[derive(Debug, Clone)]
pub struct ClassDef {
    pub name: String,
    pub parent: Option<String>,
}

/// A relationship type in the optional schema. Empty `from`/`to` lists mean
/// "any class".
#[derive(Debug, Clone)]
pub struct RelTypeDef {
    pub name: String,
    pub from: Vec<String>,
    pub to: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Schema {
    pub classes: Vec<ClassDef>,
    pub relationship_types: Vec<RelTypeDef>,
}

impl Schema {
    fn from_wire(value: &Json) -> Schema {
        let mut classes = Vec::new();
        if let Some(arr) = value.get("classes").and_then(|v| v.as_array()) {
            for c in arr {
                let Some(name) = c.get_str("name").filter(|s| !s.is_empty()) else {
                    continue;
                };
                classes.push(ClassDef {
                    name: name.to_string(),
                    parent: c
                        .get_str("parent")
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string()),
                });
            }
        }
        let mut relationship_types = Vec::new();
        if let Some(arr) = value.get("relationshipTypes").and_then(|v| v.as_array()) {
            for r in arr {
                let Some(name) = r.get_str("name").filter(|s| !s.is_empty()) else {
                    continue;
                };
                relationship_types.push(RelTypeDef {
                    name: name.to_string(),
                    from: string_array(r.get("from")),
                    to: string_array(r.get("to")),
                });
            }
        }
        Schema {
            classes,
            relationship_types,
        }
    }

    fn class(&self, name: &str) -> Option<&ClassDef> {
        self.classes.iter().find(|c| c.name == name)
    }

    /// True when `child` is `ancestor` or inherits from it. Walks the parent
    /// chain with a step cap so a (rejected-at-validate, but belt-and-braces)
    /// cycle can never loop forever.
    pub fn is_subclass_of(&self, child: &str, ancestor: &str) -> bool {
        let mut current = Some(child);
        for _ in 0..=self.classes.len() {
            match current {
                Some(name) if name == ancestor => return true,
                Some(name) => current = self.class(name).and_then(|c| c.parent.as_deref()),
                None => return false,
            }
        }
        false
    }

    /// Hard validation of the schema itself: duplicate class names, a parent
    /// referencing an unknown class, inheritance cycles, duplicate
    /// relationship-type names. These reject the wire payload (like dangling
    /// relationships do) — everything else about a schema is soft.
    fn validate(&self) -> Result<(), String> {
        let mut seen = std::collections::HashSet::new();
        for c in &self.classes {
            if !seen.insert(c.name.as_str()) {
                return Err(format!("schema defines class '{}' more than once", c.name));
            }
        }
        for c in &self.classes {
            if let Some(p) = &c.parent {
                if self.class(p).is_none() {
                    return Err(format!(
                        "schema class '{}' has unknown parent '{}'",
                        c.name, p
                    ));
                }
            }
        }
        // Cycle check: walk each parent chain; more steps than classes = cycle.
        for c in &self.classes {
            let mut current = c.parent.as_deref();
            let mut steps = 0;
            while let Some(name) = current {
                steps += 1;
                if steps > self.classes.len() {
                    return Err(format!(
                        "schema inheritance cycle detected involving class '{}'",
                        c.name
                    ));
                }
                current = self.class(name).and_then(|c| c.parent.as_deref());
            }
        }
        let mut seen_rel = std::collections::HashSet::new();
        for r in &self.relationship_types {
            if !seen_rel.insert(r.name.as_str()) {
                return Err(format!(
                    "schema defines relationship type '{}' more than once",
                    r.name
                ));
            }
        }
        Ok(())
    }
}

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
    /// Optional human title for the whole graph; drives the export file name.
    pub name: String,
    pub nodes: Vec<Node>,
    pub relationships: Vec<Relationship>,
    /// Optional schema. `None` (or an empty schema) means every check in
    /// [`Graph::schema_warnings`] is silent and behavior matches pre-schema
    /// Ontoloom exactly.
    pub schema: Option<Schema>,
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

        let schema = value.get("schema").map(Schema::from_wire);

        let graph = Graph {
            name: value.get_str("name").unwrap_or("").to_string(),
            nodes,
            relationships,
            schema,
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
        if let Some(schema) = &self.schema {
            schema.validate()?;
        }
        Ok(())
    }

    /// Soft schema checks: human-readable warnings, never errors. Empty when
    /// there is no schema. Sections are independently quiet while their side
    /// of the schema is empty (an expert sketching classes first shouldn't be
    /// scolded about every relationship, and vice versa).
    pub fn schema_warnings(&self) -> Vec<String> {
        let Some(schema) = &self.schema else {
            return Vec::new();
        };
        let mut warnings = Vec::new();

        // Endpoint lists referencing classes the schema doesn't define are an
        // inconsistency worth pointing at, but soft: deleting a class is allowed.
        for rt in &schema.relationship_types {
            for class in rt.from.iter().chain(rt.to.iter()) {
                if schema.class(class).is_none() {
                    warnings.push(format!(
                        "relationship type '{}' references undefined class '{}'",
                        rt.name, class
                    ));
                }
            }
        }

        if !schema.classes.is_empty() {
            for n in &self.nodes {
                for label in &n.labels {
                    if schema.class(label).is_none() {
                        warnings.push(format!(
                            "node '{}' has label '{}' which is not a schema class",
                            display_name(n),
                            label
                        ));
                    }
                }
            }
        }

        if !schema.relationship_types.is_empty() {
            for r in &self.relationships {
                let Some(rt) = schema
                    .relationship_types
                    .iter()
                    .find(|rt| rt.name == r.rel_type)
                else {
                    warnings.push(format!(
                        "relationship '{}' has type '{}' which is not in the schema",
                        r.id, r.rel_type
                    ));
                    continue;
                };
                self.check_endpoint(schema, rt, &r.from, &rt.from, "source", &mut warnings, r);
                self.check_endpoint(schema, rt, &r.to, &rt.to, "target", &mut warnings, r);
            }
        }

        warnings
    }

    /// One endpoint against its allowed class list, inheritance-aware: the
    /// node satisfies the constraint if any of its labels is (a subclass of)
    /// any allowed class. Unlabelled nodes warn too — honestly unknowable.
    #[allow(clippy::too_many_arguments)]
    fn check_endpoint(
        &self,
        schema: &Schema,
        rt: &RelTypeDef,
        node_id: &str,
        allowed: &[String],
        side: &str,
        warnings: &mut Vec<String>,
        r: &Relationship,
    ) {
        if allowed.is_empty() {
            return; // "any class"
        }
        let Some(node) = self.nodes.iter().find(|n| n.id == node_id) else {
            return; // dangling endpoints are a hard validate() error already
        };
        let ok = node.labels.iter().any(|label| {
            allowed
                .iter()
                .any(|allowed_class| schema.is_subclass_of(label, allowed_class))
        });
        if !ok {
            warnings.push(format!(
                "relationship '{}' ({}): {} node '{}' [{}] is not allowed — expected {}",
                r.id,
                rt.name,
                side,
                display_name(node),
                node.labels.join(", "),
                allowed.join(" | ")
            ));
        }
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

/// Caption when present, id otherwise — for human-readable warnings.
fn display_name(n: &Node) -> &str {
    if n.caption.is_empty() {
        &n.id
    } else {
        &n.caption
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

    // --- schema (M1) --------------------------------------------------------

    const LIBRARY: &str = r#"{
        "nodes":[
            {"id":"n1","labels":["Author"],"caption":"Jane Austen"},
            {"id":"n2","labels":["Book"],"caption":"Emma"},
            {"id":"n3","labels":["Publisher"],"caption":"John Murray"}
        ],
        "relationships":[
            {"id":"r1","type":"WROTE","from":"n1","to":"n2"},
            {"id":"r2","type":"WROTE","from":"n3","to":"n2"},
            {"id":"r3","type":"MET","from":"n1","to":"n3"}
        ],
        "schema":{
            "classes":[
                {"name":"Person"},
                {"name":"Author","parent":"Person"},
                {"name":"Book"}
            ],
            "relationshipTypes":[
                {"name":"WROTE","from":["Person"],"to":["Book"]}
            ]
        }
    }"#;

    #[test]
    fn graph_without_schema_is_untouched() {
        let wire =
            parse(r#"{"nodes":[{"id":"n1","labels":["Anything"]}],"relationships":[]}"#).unwrap();
        let g = Graph::from_wire(&wire).unwrap();
        assert!(g.schema.is_none());
        assert!(g.schema_warnings().is_empty());
    }

    #[test]
    fn schema_round_trips_through_the_codec() {
        let g = Graph::from_wire(&parse(LIBRARY).unwrap()).unwrap();
        let s = g.schema.as_ref().expect("schema parsed");
        assert_eq!(s.classes.len(), 3);
        assert_eq!(s.classes[1].parent.as_deref(), Some("Person"));
        assert_eq!(s.relationship_types.len(), 1);
        assert_eq!(s.relationship_types[0].from, vec!["Person"]);
    }

    #[test]
    fn inheritance_aware_endpoint_check() {
        let g = Graph::from_wire(&parse(LIBRARY).unwrap()).unwrap();
        let warnings = g.schema_warnings();
        // Author is-a Person, so r1 satisfies WROTE(Person → Book): no warning.
        assert!(!warnings.iter().any(|w| w.contains("'r1'")), "{warnings:?}");
        // Publisher is not a schema class → label warning, and r2's source
        // violates WROTE's from-constraint.
        assert!(warnings.iter().any(|w| w.contains("'Publisher'")));
        assert!(warnings.iter().any(|w| w.contains("'r2'")));
        // MET is not a schema relationship type.
        assert!(warnings.iter().any(|w| w.contains("'MET'")));
    }

    #[test]
    fn schema_rejects_duplicate_class() {
        let wire = parse(
            r#"{"nodes":[],"relationships":[],
                "schema":{"classes":[{"name":"A"},{"name":"A"}]}}"#,
        )
        .unwrap();
        let err = Graph::from_wire(&wire).unwrap_err();
        assert!(err.contains("more than once"), "{err}");
    }

    #[test]
    fn schema_rejects_unknown_parent() {
        let wire = parse(
            r#"{"nodes":[],"relationships":[],
                "schema":{"classes":[{"name":"A","parent":"Ghost"}]}}"#,
        )
        .unwrap();
        let err = Graph::from_wire(&wire).unwrap_err();
        assert!(err.contains("unknown parent"), "{err}");
    }

    #[test]
    fn schema_rejects_inheritance_cycle() {
        let wire = parse(
            r#"{"nodes":[],"relationships":[],
                "schema":{"classes":[
                    {"name":"A","parent":"B"},
                    {"name":"B","parent":"A"}]}}"#,
        )
        .unwrap();
        let err = Graph::from_wire(&wire).unwrap_err();
        assert!(err.contains("cycle"), "{err}");
    }

    #[test]
    fn undefined_endpoint_class_is_soft() {
        let wire = parse(
            r#"{"nodes":[],"relationships":[],
                "schema":{"classes":[{"name":"A"}],
                          "relationshipTypes":[{"name":"R","from":["Ghost"],"to":["A"]}]}}"#,
        )
        .unwrap();
        let g = Graph::from_wire(&wire).expect("soft, not a rejection");
        assert!(g
            .schema_warnings()
            .iter()
            .any(|w| w.contains("undefined class 'Ghost'")));
    }

    #[test]
    fn empty_from_list_means_any_class() {
        let wire = parse(
            r#"{"nodes":[{"id":"n1","labels":["X"]},{"id":"n2","labels":["A"]}],
                "relationships":[{"id":"r1","type":"R","from":"n1","to":"n2"}],
                "schema":{"classes":[{"name":"A"},{"name":"X"}],
                          "relationshipTypes":[{"name":"R","from":[],"to":["A"]}]}}"#,
        )
        .unwrap();
        let g = Graph::from_wire(&wire).unwrap();
        assert!(g.schema_warnings().is_empty(), "{:?}", g.schema_warnings());
    }
}
