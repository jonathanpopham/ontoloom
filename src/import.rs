//! Importers — the mirror image of [`crate::export`]. Anything Ontoloom can
//! export, it can read back in: Ontoloom JSON, Neo4j JSONL, Cypher, and
//! GraphML. The format is auto-detected from the file name and contents, so the
//! user just picks a file.
//!
//! Each importer produces the Ontoloom wire format (see [`crate::model`]) as a
//! JSON string, which the browser loads directly.
//!
//! The Cypher reader targets the `CREATE` shape Ontoloom emits (and common
//! simple variants); it is not a general Cypher parser.

use crate::json::{obj, parse, s, Json};

pub fn import_auto(text: &str, filename_hint: &str) -> Result<String, String> {
    let format = detect(text, filename_hint);
    import_as(text, &format)
}

pub fn import_as(text: &str, format: &str) -> Result<String, String> {
    match format {
        "json" => import_json(text),
        "jsonl" => import_jsonl(text),
        "cypher" => import_cypher(text),
        "graphml" => import_graphml(text),
        other => Err(format!("don't know how to import '{}'", other)),
    }
}

/// Guess the format from the file name first, then fall back to sniffing the
/// content.
pub fn detect(text: &str, hint: &str) -> String {
    let h = hint.to_ascii_lowercase();
    if h.ends_with(".graphml") {
        return "graphml".into();
    }
    if h.ends_with(".cypher") || h.ends_with(".cql") {
        return "cypher".into();
    }
    if h.ends_with(".jsonl") || h.ends_with(".ndjson") {
        return "jsonl".into();
    }
    if h.ends_with(".json") {
        return "json".into();
    }

    let t = text.trim_start();
    if t.starts_with("<?xml") || t.contains("<graphml") {
        return "graphml".into();
    }
    if looks_like_jsonl(text) {
        return "jsonl".into();
    }
    if t.starts_with('{') || t.starts_with('[') {
        return "json".into();
    }
    if text.to_ascii_uppercase().contains("CREATE (") {
        return "cypher".into();
    }
    "json".into()
}

fn looks_like_jsonl(text: &str) -> bool {
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    match lines.next() {
        Some(first) => {
            let first = first.trim();
            // A single JSON document spanning lines won't have a closing brace
            // on line one; a JSONL record will.
            first.starts_with('{')
                && first.ends_with('}')
                && parse(first)
                    .ok()
                    .and_then(|v| v.get_str("type").map(|t| t == "node" || t == "relationship"))
                    .unwrap_or(false)
        }
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Ontoloom JSON / generic node-link
// ---------------------------------------------------------------------------

fn import_json(text: &str) -> Result<String, String> {
    let value = parse(text).map_err(|e| format!("invalid JSON: {}", e))?;
    let name = value.get_str("name").unwrap_or("").to_string();
    let nodes_json = value
        .get("nodes")
        .and_then(|v| v.as_array())
        .ok_or("this JSON has no 'nodes' array — is it an Ontoloom graph?")?;

    let mut nodes = Vec::new();
    for (i, n) in nodes_json.iter().enumerate() {
        let id = n
            .get_str("id")
            .ok_or_else(|| format!("node #{} has no id", i))?;
        let labels = string_array(n.get("labels"));
        let caption = n.get_str("caption").unwrap_or("").to_string();
        let props = object_pairs(n.get("properties"));
        let pos = match (n.get("x").and_then(num), n.get("y").and_then(num)) {
            (Some(x), Some(y)) => Some((x, y)),
            _ => None,
        };
        nodes.push(node_json(id, labels, caption, props, pos));
    }

    let rels_json = value
        .get("relationships")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut rels = Vec::new();
    for (i, r) in rels_json.iter().enumerate() {
        let id = r
            .get_str("id")
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("r{}", i + 1));
        let rtype = r.get_str("type").unwrap_or("RELATED_TO");
        let from = r
            .get_str("from")
            .ok_or_else(|| format!("relationship #{} has no 'from'", i))?;
        let to = r
            .get_str("to")
            .ok_or_else(|| format!("relationship #{} has no 'to'", i))?;
        let props = object_pairs(r.get("properties"));
        rels.push(rel_json(&id, rtype, from, to, props));
    }
    Ok(obj(vec![
        ("name", s(&name)),
        ("nodes", Json::Arr(nodes)),
        ("relationships", Json::Arr(rels)),
    ])
    .to_compact())
}

// ---------------------------------------------------------------------------
// Neo4j / APOC JSONL
// ---------------------------------------------------------------------------

fn import_jsonl(text: &str) -> Result<String, String> {
    let mut nodes = Vec::new();
    let mut rels = Vec::new();
    let mut auto_rel = 0;

    for (i, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v = parse(line).map_err(|e| format!("line {}: {}", i + 1, e))?;
        match v.get_str("type") {
            Some("node") => {
                let id = v
                    .get_str("id")
                    .ok_or_else(|| format!("line {}: node has no id", i + 1))?;
                let labels = string_array(v.get("labels"));
                let mut props = object_pairs(v.get("properties"));
                let caption = take_name(&mut props);
                nodes.push(node_json(id, labels, caption, props, None));
            }
            Some("relationship") => {
                let id = v.get_str("id").map(|s| s.to_string()).unwrap_or_else(|| {
                    auto_rel += 1;
                    format!("r{}", auto_rel)
                });
                let rtype = v.get_str("label").or_else(|| v.get_str("type")).unwrap_or("RELATED_TO");
                let from = endpoint_id(&v, "start")
                    .ok_or_else(|| format!("line {}: relationship has no start", i + 1))?;
                let to = endpoint_id(&v, "end")
                    .ok_or_else(|| format!("line {}: relationship has no end", i + 1))?;
                let props = object_pairs(v.get("properties"));
                rels.push(rel_json(&id, rtype, &from, &to, props));
            }
            _ => { /* ignore unknown record types */ }
        }
    }
    Ok(wire(nodes, rels))
}

/// `start`/`end` may be an object `{"id": ...}` or a bare id value.
fn endpoint_id(rel: &Json, key: &str) -> Option<String> {
    match rel.get(key) {
        Some(Json::Obj(_)) => rel.get(key).and_then(|o| o.get_str("id")).map(|s| s.to_string()),
        Some(Json::Str(s)) => Some(s.clone()),
        Some(Json::Num(n)) => Some(format_num(*n)),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Cypher
// ---------------------------------------------------------------------------

fn import_cypher(text: &str) -> Result<String, String> {
    let mut nodes = Vec::new();
    let mut rels = Vec::new();
    let mut auto_rel = 0;

    for raw in text.lines() {
        let line = raw.trim().trim_end_matches(';').trim();
        if line.is_empty() || line.starts_with("//") {
            continue;
        }
        let upper = line.to_ascii_uppercase();
        if !upper.starts_with("CREATE") {
            continue;
        }
        let body = line[6..].trim_start(); // strip "CREATE"
        if body.contains("]->(") || body.contains("]-(") {
            auto_rel += 1;
            let rel = parse_cypher_rel(body, auto_rel)?;
            rels.push(rel);
        } else if body.starts_with('(') {
            nodes.push(parse_cypher_node(body)?);
        }
    }
    Ok(wire(nodes, rels))
}

fn parse_cypher_node(body: &str) -> Result<Json, String> {
    let mut c = Cur::new(body);
    c.expect('(')?;
    let id = c.name()?;
    let mut labels = Vec::new();
    while c.eat(':') {
        labels.push(c.name()?);
    }
    // A lone ":Node" label is what Ontoloom emits for an unlabeled node; drop it
    // so a round-trip doesn't invent a label.
    if labels.len() == 1 && labels[0] == "Node" {
        labels.clear();
    }
    c.ws();
    let mut props = if c.peek() == Some('{') {
        c.parse_map()?
    } else {
        Vec::new()
    };
    let caption = take_name(&mut props);
    Ok(node_json(&id, labels, caption, props, None))
}

fn parse_cypher_rel(body: &str, auto_rel: usize) -> Result<Json, String> {
    let mut c = Cur::new(body);
    c.expect('(')?;
    let from = c.name()?;
    c.expect(')')?;
    c.expect('-')?;
    c.expect('[')?;
    c.expect(':')?;
    let rtype = c.name()?;
    c.ws();
    let props = if c.peek() == Some('{') {
        c.parse_map()?
    } else {
        Vec::new()
    };
    c.expect(']')?;
    c.expect('-')?;
    c.expect('>')?;
    c.expect('(')?;
    let to = c.name()?;
    Ok(rel_json(&format!("r{}", auto_rel), &rtype, &from, &to, props))
}

/// A small cursor over a Cypher fragment.
struct Cur {
    chars: Vec<char>,
    i: usize,
}

impl Cur {
    fn new(s: &str) -> Cur {
        Cur {
            chars: s.chars().collect(),
            i: 0,
        }
    }
    fn peek(&self) -> Option<char> {
        self.chars.get(self.i).copied()
    }
    fn ws(&mut self) {
        while matches!(self.peek(), Some(c) if c.is_whitespace()) {
            self.i += 1;
        }
    }
    fn eat(&mut self, ch: char) -> bool {
        self.ws();
        if self.peek() == Some(ch) {
            self.i += 1;
            true
        } else {
            false
        }
    }
    fn expect(&mut self, ch: char) -> Result<(), String> {
        if self.eat(ch) {
            Ok(())
        } else {
            Err(format!("Cypher: expected '{}' near position {}", ch, self.i))
        }
    }
    /// A backticked `` `name` `` or a bare identifier.
    fn name(&mut self) -> Result<String, String> {
        self.ws();
        if self.peek() == Some('`') {
            self.i += 1;
            let mut out = String::new();
            while let Some(ch) = self.peek() {
                self.i += 1;
                if ch == '`' {
                    // `` is an escaped backtick.
                    if self.peek() == Some('`') {
                        out.push('`');
                        self.i += 1;
                    } else {
                        return Ok(out);
                    }
                } else {
                    out.push(ch);
                }
            }
            Err("Cypher: unterminated backtick".into())
        } else {
            let mut out = String::new();
            while let Some(ch) = self.peek() {
                if ch.is_alphanumeric() || ch == '_' {
                    out.push(ch);
                    self.i += 1;
                } else {
                    break;
                }
            }
            if out.is_empty() {
                Err(format!("Cypher: expected a name near position {}", self.i))
            } else {
                Ok(out)
            }
        }
    }
    fn parse_map(&mut self) -> Result<Vec<(String, Json)>, String> {
        self.expect('{')?;
        let mut pairs = Vec::new();
        self.ws();
        if self.eat('}') {
            return Ok(pairs);
        }
        loop {
            let key = self.name()?;
            self.expect(':')?;
            let value = self.parse_value()?;
            pairs.push((key, value));
            self.ws();
            if self.eat(',') {
                continue;
            }
            self.expect('}')?;
            break;
        }
        Ok(pairs)
    }
    fn parse_value(&mut self) -> Result<Json, String> {
        self.ws();
        match self.peek() {
            Some('"') | Some('\'') => self.parse_string(),
            Some('[') => self.parse_array(),
            Some('{') => Ok(Json::Str(
                // Nested maps were stringified on export; keep them as a string.
                {
                    let map = self.parse_map()?;
                    Json::Obj(map).to_compact()
                },
            )),
            Some(c) if c == '-' || c.is_ascii_digit() => self.parse_number(),
            Some('t') | Some('f') => self.parse_keyword(),
            Some('n') => self.parse_keyword(),
            _ => Err(format!("Cypher: unexpected value near position {}", self.i)),
        }
    }
    fn parse_string(&mut self) -> Result<Json, String> {
        let quote = self.peek().unwrap();
        self.i += 1;
        let mut out = String::new();
        while let Some(ch) = self.peek() {
            self.i += 1;
            if ch == '\\' {
                if let Some(esc) = self.peek() {
                    self.i += 1;
                    out.push(match esc {
                        'n' => '\n',
                        't' => '\t',
                        'r' => '\r',
                        other => other,
                    });
                }
            } else if ch == quote {
                return Ok(Json::Str(out));
            } else {
                out.push(ch);
            }
        }
        Err("Cypher: unterminated string".into())
    }
    fn parse_array(&mut self) -> Result<Json, String> {
        self.expect('[')?;
        let mut items = Vec::new();
        self.ws();
        if self.eat(']') {
            return Ok(Json::Arr(items));
        }
        loop {
            items.push(self.parse_value()?);
            self.ws();
            if self.eat(',') {
                continue;
            }
            self.expect(']')?;
            break;
        }
        Ok(Json::Arr(items))
    }
    fn parse_number(&mut self) -> Result<Json, String> {
        let start = self.i;
        if self.peek() == Some('-') {
            self.i += 1;
        }
        while matches!(self.peek(), Some(c) if c.is_ascii_digit() || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-')
        {
            self.i += 1;
        }
        let slice: String = self.chars[start..self.i].iter().collect();
        slice
            .parse::<f64>()
            .map(Json::Num)
            .map_err(|_| format!("Cypher: bad number '{}'", slice))
    }
    fn parse_keyword(&mut self) -> Result<Json, String> {
        let start = self.i;
        while matches!(self.peek(), Some(c) if c.is_ascii_alphabetic()) {
            self.i += 1;
        }
        let word: String = self.chars[start..self.i].iter().collect();
        match word.as_str() {
            "true" => Ok(Json::Bool(true)),
            "false" => Ok(Json::Bool(false)),
            "null" => Ok(Json::Null),
            other => Err(format!("Cypher: unexpected keyword '{}'", other)),
        }
    }
}

// ---------------------------------------------------------------------------
// GraphML
// ---------------------------------------------------------------------------

enum Tok {
    Start {
        name: String,
        attrs: Vec<(String, String)>,
        self_close: bool,
    },
    End(String),
    Text(String),
}

fn import_graphml(text: &str) -> Result<String, String> {
    let tokens = tokenize_xml(text);

    // Resolve <key id="..." attr.name="..."> so external GraphML attribute
    // names are honored.
    let mut keymap: Vec<(String, String)> = Vec::new();
    for tok in &tokens {
        if let Tok::Start { name, attrs, .. } = tok {
            if name == "key" {
                let id = attr(attrs, "id");
                let an = attr(attrs, "attr.name");
                if let (Some(id), Some(an)) = (id, an) {
                    keymap.push((id, an));
                }
            }
        }
    }
    let resolve = |k: &str| keymap.iter().find(|(id, _)| id == k).map(|(_, n)| n.clone()).unwrap_or_else(|| k.to_string());

    let mut nodes = Vec::new();
    let mut rels = Vec::new();
    let mut auto_rel = 0;

    // Context for the element we're currently inside.
    let mut elem: Option<(&'static str, Vec<(String, String)>)> = None;
    let mut data: Vec<(String, String)> = Vec::new(); // (resolved key, value)
    let mut cur_key: Option<String> = None;
    let mut text_buf = String::new();

    for tok in tokens {
        match tok {
            Tok::Start { name, attrs, self_close } => match name.as_str() {
                "node" | "edge" => {
                    let kind = if name == "node" { "node" } else { "edge" };
                    elem = Some((kind, attrs.clone()));
                    data.clear();
                    if self_close {
                        finalize(kind, &attrs, &data, &mut nodes, &mut rels, &mut auto_rel);
                        elem = None;
                    }
                }
                "data" => {
                    cur_key = attr(&attrs, "key").map(|k| resolve(&k));
                    text_buf.clear();
                    if self_close {
                        if let Some(k) = cur_key.take() {
                            data.push((k, String::new()));
                        }
                    }
                }
                _ => {}
            },
            Tok::Text(t) => {
                if cur_key.is_some() {
                    text_buf.push_str(&t);
                }
            }
            Tok::End(name) => match name.as_str() {
                "data" => {
                    if let Some(k) = cur_key.take() {
                        data.push((k, text_buf.clone()));
                    }
                    text_buf.clear();
                }
                "node" | "edge" => {
                    if let Some((kind, attrs)) = elem.take() {
                        finalize(kind, &attrs, &data, &mut nodes, &mut rels, &mut auto_rel);
                    }
                    data.clear();
                }
                _ => {}
            },
        }
    }

    if nodes.is_empty() && rels.is_empty() {
        return Err("no <node> or <edge> elements found — is this GraphML?".into());
    }
    Ok(wire(nodes, rels))
}

#[allow(clippy::too_many_arguments)]
fn finalize(
    kind: &str,
    attrs: &[(String, String)],
    data: &[(String, String)],
    nodes: &mut Vec<Json>,
    rels: &mut Vec<Json>,
    auto_rel: &mut usize,
) {
    if kind == "node" {
        let id = attr(attrs, "id").unwrap_or_default();
        let mut labels = Vec::new();
        let mut caption = String::new();
        let mut props: Vec<(String, Json)> = Vec::new();
        for (k, v) in data {
            match k.as_str() {
                "labels" => labels = v.split(':').map(|s| s.to_string()).filter(|s| !s.is_empty()).collect(),
                "name" => caption = v.clone(),
                "properties" | "props" => {
                    if let Ok(Json::Obj(pairs)) = parse(v) {
                        props.extend(pairs);
                    }
                }
                other => props.push((other.to_string(), coerce(v))),
            }
        }
        if caption.is_empty() {
            caption = take_name(&mut props);
        }
        nodes.push(node_json(&id, labels, caption, props, None));
    } else {
        let from = attr(attrs, "source").unwrap_or_default();
        let to = attr(attrs, "target").unwrap_or_default();
        *auto_rel += 1;
        let id = attr(attrs, "id").unwrap_or_else(|| format!("r{}", auto_rel));
        let mut rtype = String::from("RELATED_TO");
        let mut props: Vec<(String, Json)> = Vec::new();
        for (k, v) in data {
            match k.as_str() {
                "type" | "label" => rtype = v.clone(),
                "properties" | "eprops" | "props" => {
                    if let Ok(Json::Obj(pairs)) = parse(v) {
                        props.extend(pairs);
                    }
                }
                other => props.push((other.to_string(), coerce(v))),
            }
        }
        rels.push(rel_json(&id, &rtype, &from, &to, props));
    }
}

fn tokenize_xml(text: &str) -> Vec<Tok> {
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    let n = chars.len();
    let mut tokens = Vec::new();
    while i < n {
        if chars[i] == '<' {
            // Skip declarations, comments, and processing instructions.
            if i + 1 < n && (chars[i + 1] == '?' || chars[i + 1] == '!') {
                if chars[i..].starts_with(&['<', '!', '-', '-']) {
                    // comment
                    let mut j = i + 4;
                    while j + 2 < n && !(chars[j] == '-' && chars[j + 1] == '-' && chars[j + 2] == '>') {
                        j += 1;
                    }
                    i = (j + 3).min(n);
                } else {
                    while i < n && chars[i] != '>' {
                        i += 1;
                    }
                    i += 1;
                }
                continue;
            }
            // Read the tag up to '>'.
            let mut j = i + 1;
            while j < n && chars[j] != '>' {
                j += 1;
            }
            let inner: String = chars[i + 1..j].iter().collect();
            i = j + 1;
            let inner = inner.trim();
            if let Some(rest) = inner.strip_prefix('/') {
                tokens.push(Tok::End(rest.trim().to_string()));
            } else {
                let self_close = inner.ends_with('/');
                let inner = inner.trim_end_matches('/').trim();
                let (name, attrs) = parse_tag(inner);
                tokens.push(Tok::Start {
                    name,
                    attrs,
                    self_close,
                });
            }
        } else {
            let mut j = i;
            while j < n && chars[j] != '<' {
                j += 1;
            }
            let raw: String = chars[i..j].iter().collect();
            i = j;
            let txt = xml_unescape(raw.trim());
            if !txt.is_empty() {
                tokens.push(Tok::Text(txt));
            }
        }
    }
    tokens
}

fn parse_tag(inner: &str) -> (String, Vec<(String, String)>) {
    let mut parts = inner.splitn(2, char::is_whitespace);
    let name = parts.next().unwrap_or("").to_string();
    let mut attrs = Vec::new();
    if let Some(rest) = parts.next() {
        let chars: Vec<char> = rest.chars().collect();
        let mut i = 0;
        let n = chars.len();
        while i < n {
            while i < n && (chars[i].is_whitespace()) {
                i += 1;
            }
            let start = i;
            while i < n && chars[i] != '=' && !chars[i].is_whitespace() {
                i += 1;
            }
            if start == i {
                break;
            }
            let key: String = chars[start..i].iter().collect();
            while i < n && chars[i] != '=' {
                i += 1;
            }
            i += 1; // skip '='
            while i < n && chars[i].is_whitespace() {
                i += 1;
            }
            if i < n && (chars[i] == '"' || chars[i] == '\'') {
                let quote = chars[i];
                i += 1;
                let vstart = i;
                while i < n && chars[i] != quote {
                    i += 1;
                }
                let value: String = chars[vstart..i].iter().collect();
                i += 1;
                attrs.push((key, xml_unescape(&value)));
            }
        }
    }
    (name, attrs)
}

fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn wire(nodes: Vec<Json>, rels: Vec<Json>) -> String {
    obj(vec![
        ("nodes", Json::Arr(nodes)),
        ("relationships", Json::Arr(rels)),
    ])
    .to_compact()
}

fn node_json(
    id: &str,
    labels: Vec<String>,
    caption: String,
    props: Vec<(String, Json)>,
    pos: Option<(f64, f64)>,
) -> Json {
    let mut pairs = vec![
        ("id", s(id)),
        ("labels", Json::Arr(labels.iter().map(|l| s(l)).collect())),
        ("caption", s(&caption)),
        ("properties", Json::Obj(props)),
    ];
    if let Some((x, y)) = pos {
        pairs.push(("x", Json::Num(x)));
        pairs.push(("y", Json::Num(y)));
    }
    obj(pairs)
}

fn rel_json(id: &str, rtype: &str, from: &str, to: &str, props: Vec<(String, Json)>) -> Json {
    obj(vec![
        ("id", s(id)),
        ("type", s(rtype)),
        ("from", s(from)),
        ("to", s(to)),
        ("properties", Json::Obj(props)),
    ])
}

/// Pull a `name` property out of a property list and return it as the caption.
fn take_name(props: &mut Vec<(String, Json)>) -> String {
    if let Some(pos) = props.iter().position(|(k, _)| k == "name") {
        let (_, v) = props.remove(pos);
        if let Json::Str(name) = v {
            return name;
        }
    }
    String::new()
}

fn coerce(value: &str) -> Json {
    let t = value.trim();
    if t == "true" {
        return Json::Bool(true);
    }
    if t == "false" {
        return Json::Bool(false);
    }
    if let Ok(n) = t.parse::<f64>() {
        if t.chars().all(|c| c.is_ascii_digit() || c == '-' || c == '.' || c == 'e' || c == 'E' || c == '+') {
            return Json::Num(n);
        }
    }
    Json::Str(value.to_string())
}

fn num(v: &Json) -> Option<f64> {
    match v {
        Json::Num(n) => Some(*n),
        _ => None,
    }
}

fn format_num(n: f64) -> String {
    if n.fract() == 0.0 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
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

fn attr(attrs: &[(String, String)], key: &str) -> Option<String> {
    attrs.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export;
    use crate::model::Graph;

    fn sample_graph() -> Graph {
        let wire = parse(
            r#"{
              "nodes":[
                {"id":"n1","labels":["Person"],"caption":"Alice","properties":{"age":30}},
                {"id":"n2","labels":["Person","Author"],"caption":"Bob","properties":{}},
                {"id":"n3","labels":[],"caption":"Untyped","properties":{"note":"hi"}}
              ],
              "relationships":[
                {"id":"r1","type":"KNOWS","from":"n1","to":"n2","properties":{"since":2020}},
                {"id":"r2","type":"WROTE","from":"n2","to":"n3","properties":{}}
              ]
            }"#,
        )
        .unwrap();
        Graph::from_wire(&wire).unwrap()
    }

    /// The core promise: every export format can be imported back into an
    /// equivalent graph.
    fn round_trip(format: &str, ext: &str) {
        let graph = sample_graph();
        let exported = export::export(&graph, format).unwrap();
        let imported_wire = import_auto(&exported, &format!("ontology.{}", ext))
            .unwrap_or_else(|e| panic!("{} import failed: {}", format, e));
        let reparsed = Graph::from_wire(&parse(&imported_wire).unwrap())
            .unwrap_or_else(|e| panic!("{} re-validate failed: {}", format, e));

        assert_eq!(reparsed.nodes.len(), 3, "{}: node count", format);
        assert_eq!(reparsed.relationships.len(), 2, "{}: rel count", format);

        // Captions survive.
        let alice = reparsed.nodes.iter().find(|n| n.id == "n1").expect("n1");
        assert_eq!(alice.caption, "Alice", "{}: caption", format);
        // A scalar property survives with its type.
        let age = alice.properties.iter().find(|(k, _)| k == "age");
        assert!(matches!(age, Some((_, Json::Num(_)))), "{}: age property", format);
        // Relationship type survives.
        assert!(
            reparsed.relationships.iter().any(|r| r.rel_type == "KNOWS"),
            "{}: KNOWS type",
            format
        );
    }

    #[test]
    fn round_trips_json() {
        round_trip("json", "json");
    }

    #[test]
    fn round_trips_jsonl() {
        round_trip("jsonl", "jsonl");
    }

    #[test]
    fn round_trips_cypher() {
        round_trip("cypher", "cypher");
    }

    #[test]
    fn round_trips_graphml() {
        round_trip("graphml", "graphml");
    }

    #[test]
    fn json_round_trips_the_graph_name() {
        let wire = parse(
            r#"{"name":"Patient Intake","nodes":[{"id":"n1","caption":"A"}],"relationships":[]}"#,
        )
        .unwrap();
        let graph = Graph::from_wire(&wire).unwrap();
        assert_eq!(graph.name, "Patient Intake");
        let exported = export::export(&graph, "json").unwrap();
        let imported = import_auto(&exported, "x.json").unwrap();
        let back = Graph::from_wire(&parse(&imported).unwrap()).unwrap();
        assert_eq!(back.name, "Patient Intake");
    }

    #[test]
    fn detects_by_content_without_extension() {
        let graph = sample_graph();
        assert_eq!(detect(&export::export(&graph, "graphml").unwrap(), "x"), "graphml");
        assert_eq!(detect(&export::export(&graph, "jsonl").unwrap(), "x"), "jsonl");
        assert_eq!(detect(&export::export(&graph, "cypher").unwrap(), "x"), "cypher");
        assert_eq!(detect(&export::export(&graph, "json").unwrap(), "x"), "json");
    }
}
