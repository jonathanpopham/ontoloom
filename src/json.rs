//! A tiny, dependency-free JSON value type with a recursive-descent parser
//! and a serializer. Object keys preserve insertion order so that exports are
//! stable and diff-friendly.
//!
//! This is intentionally small — it supports exactly the subset of JSON that
//! Ontoloom needs to round-trip a graph model. It is not a general-purpose
//! library, but it is correct for well-formed input and rejects malformed input
//! with a position-tagged error.

use std::fmt::Write as _;

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    /// Order-preserving object. We use a Vec of pairs rather than a HashMap so
    /// that serialized output is deterministic.
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&Vec<Json>> {
        match self {
            Json::Arr(a) => Some(a),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&Vec<(String, Json)>> {
        match self {
            Json::Obj(o) => Some(o),
            _ => None,
        }
    }

    /// Look up a key in an object, returning the first match.
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(pairs) => pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn get_str<'a>(&'a self, key: &str) -> Option<&'a str> {
        self.get(key).and_then(|v| v.as_str())
    }

    /// Serialize compactly (no whitespace).
    pub fn to_compact(&self) -> String {
        let mut out = String::new();
        self.write(&mut out, None, 0);
        out
    }

    /// Serialize with 2-space indentation for human readability.
    pub fn to_pretty(&self) -> String {
        let mut out = String::new();
        self.write(&mut out, Some(2), 0);
        out
    }

    fn write(&self, out: &mut String, indent: Option<usize>, depth: usize) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Json::Num(n) => write_number(out, *n),
            Json::Str(s) => write_json_string(out, s),
            Json::Arr(items) => {
                if items.is_empty() {
                    out.push_str("[]");
                    return;
                }
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    newline_indent(out, indent, depth + 1);
                    item.write(out, indent, depth + 1);
                }
                newline_indent(out, indent, depth);
                out.push(']');
            }
            Json::Obj(pairs) => {
                if pairs.is_empty() {
                    out.push_str("{}");
                    return;
                }
                out.push('{');
                for (i, (k, v)) in pairs.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    newline_indent(out, indent, depth + 1);
                    write_json_string(out, k);
                    out.push(':');
                    if indent.is_some() {
                        out.push(' ');
                    }
                    v.write(out, indent, depth + 1);
                }
                newline_indent(out, indent, depth);
                out.push('}');
            }
        }
    }
}

fn newline_indent(out: &mut String, indent: Option<usize>, depth: usize) {
    if let Some(width) = indent {
        out.push('\n');
        for _ in 0..(width * depth) {
            out.push(' ');
        }
    }
}

/// Print a number without a trailing `.0` when it is integral, so that a
/// property value like `2020` round-trips as `2020` rather than `2020.0`.
fn write_number(out: &mut String, n: f64) {
    if !n.is_finite() {
        out.push_str("null");
        return;
    }
    if n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 {
        let _ = write!(out, "{}", n as i64);
    } else {
        let _ = write!(out, "{}", n);
    }
}

fn write_json_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

pub fn parse(input: &str) -> Result<Json, String> {
    let mut p = Parser {
        bytes: input.as_bytes(),
        chars: input.char_indices().collect(),
        pos: 0,
    };
    p.skip_ws();
    let value = p.parse_value()?;
    p.skip_ws();
    if p.pos < p.chars.len() {
        return Err(format!("trailing characters at byte {}", p.byte_at(p.pos)));
    }
    Ok(value)
}

struct Parser<'a> {
    bytes: &'a [u8],
    chars: Vec<(usize, char)>,
    pos: usize,
}

impl<'a> Parser<'a> {
    fn byte_at(&self, idx: usize) -> usize {
        self.chars.get(idx).map(|(b, _)| *b).unwrap_or(self.bytes.len())
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).map(|(_, c)| *c)
    }

    fn next(&mut self) -> Option<char> {
        let c = self.chars.get(self.pos).map(|(_, c)| *c);
        if c.is_some() {
            self.pos += 1;
        }
        c
    }

    fn skip_ws(&mut self) {
        while let Some(c) = self.peek() {
            if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn parse_value(&mut self) -> Result<Json, String> {
        self.skip_ws();
        match self.peek() {
            Some('{') => self.parse_object(),
            Some('[') => self.parse_array(),
            Some('"') => Ok(Json::Str(self.parse_string()?)),
            Some('t') | Some('f') => self.parse_bool(),
            Some('n') => self.parse_null(),
            Some(c) if c == '-' || c.is_ascii_digit() => self.parse_number(),
            Some(c) => Err(format!("unexpected character '{}' at byte {}", c, self.byte_at(self.pos))),
            None => Err("unexpected end of input".to_string()),
        }
    }

    fn parse_object(&mut self) -> Result<Json, String> {
        self.next(); // consume '{'
        let mut pairs = Vec::new();
        self.skip_ws();
        if self.peek() == Some('}') {
            self.next();
            return Ok(Json::Obj(pairs));
        }
        loop {
            self.skip_ws();
            if self.peek() != Some('"') {
                return Err(format!("expected string key at byte {}", self.byte_at(self.pos)));
            }
            let key = self.parse_string()?;
            self.skip_ws();
            if self.next() != Some(':') {
                return Err(format!("expected ':' after key at byte {}", self.byte_at(self.pos)));
            }
            let value = self.parse_value()?;
            pairs.push((key, value));
            self.skip_ws();
            match self.next() {
                Some(',') => continue,
                Some('}') => break,
                _ => return Err(format!("expected ',' or '}}' at byte {}", self.byte_at(self.pos))),
            }
        }
        Ok(Json::Obj(pairs))
    }

    fn parse_array(&mut self) -> Result<Json, String> {
        self.next(); // consume '['
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(']') {
            self.next();
            return Ok(Json::Arr(items));
        }
        loop {
            let value = self.parse_value()?;
            items.push(value);
            self.skip_ws();
            match self.next() {
                Some(',') => continue,
                Some(']') => break,
                _ => return Err(format!("expected ',' or ']' at byte {}", self.byte_at(self.pos))),
            }
        }
        Ok(Json::Arr(items))
    }

    fn parse_string(&mut self) -> Result<String, String> {
        self.next(); // consume opening quote
        let mut s = String::new();
        loop {
            match self.next() {
                None => return Err("unterminated string".to_string()),
                Some('"') => break,
                Some('\\') => match self.next() {
                    Some('"') => s.push('"'),
                    Some('\\') => s.push('\\'),
                    Some('/') => s.push('/'),
                    Some('n') => s.push('\n'),
                    Some('t') => s.push('\t'),
                    Some('r') => s.push('\r'),
                    Some('b') => s.push('\u{08}'),
                    Some('f') => s.push('\u{0C}'),
                    Some('u') => {
                        let cp = self.parse_hex4()?;
                        // Handle UTF-16 surrogate pairs.
                        if (0xD800..=0xDBFF).contains(&cp) {
                            if self.next() != Some('\\') || self.next() != Some('u') {
                                return Err("invalid surrogate pair".to_string());
                            }
                            let lo = self.parse_hex4()?;
                            if !(0xDC00..=0xDFFF).contains(&lo) {
                                return Err("invalid low surrogate".to_string());
                            }
                            let c = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                            s.push(char::from_u32(c).ok_or("invalid code point")?);
                        } else {
                            s.push(char::from_u32(cp).ok_or("invalid code point")?);
                        }
                    }
                    other => return Err(format!("invalid escape '\\{:?}'", other)),
                },
                Some(c) => s.push(c),
            }
        }
        Ok(s)
    }

    fn parse_hex4(&mut self) -> Result<u32, String> {
        let mut value = 0u32;
        for _ in 0..4 {
            let c = self.next().ok_or("unexpected end in \\u escape")?;
            let digit = c.to_digit(16).ok_or("invalid hex digit in \\u escape")?;
            value = value * 16 + digit;
        }
        Ok(value)
    }

    fn parse_bool(&mut self) -> Result<Json, String> {
        if self.consume_literal("true") {
            Ok(Json::Bool(true))
        } else if self.consume_literal("false") {
            Ok(Json::Bool(false))
        } else {
            Err(format!("invalid literal at byte {}", self.byte_at(self.pos)))
        }
    }

    fn parse_null(&mut self) -> Result<Json, String> {
        if self.consume_literal("null") {
            Ok(Json::Null)
        } else {
            Err(format!("invalid literal at byte {}", self.byte_at(self.pos)))
        }
    }

    fn consume_literal(&mut self, lit: &str) -> bool {
        let chars: Vec<char> = lit.chars().collect();
        if self.pos + chars.len() > self.chars.len() {
            return false;
        }
        for (i, expected) in chars.iter().enumerate() {
            if self.chars[self.pos + i].1 != *expected {
                return false;
            }
        }
        self.pos += chars.len();
        true
    }

    fn parse_number(&mut self) -> Result<Json, String> {
        let start = self.pos;
        if self.peek() == Some('-') {
            self.next();
        }
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-' {
                self.next();
            } else {
                break;
            }
        }
        let slice: String = self.chars[start..self.pos].iter().map(|(_, c)| *c).collect();
        slice
            .parse::<f64>()
            .map(Json::Num)
            .map_err(|_| format!("invalid number '{}'", slice))
    }
}

// ---------------------------------------------------------------------------
// Convenience builders used by the exporters.
// ---------------------------------------------------------------------------

/// Build an object from an ordered list of pairs.
pub fn obj(pairs: Vec<(&str, Json)>) -> Json {
    Json::Obj(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

pub fn s(value: &str) -> Json {
    Json::Str(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_objects() {
        let input = r#"{"a":1,"b":[true,null,"x"],"c":{"d":2020}}"#;
        let parsed = parse(input).unwrap();
        assert_eq!(parsed.to_compact(), input);
    }

    #[test]
    fn integers_have_no_trailing_decimal() {
        let parsed = parse("2020").unwrap();
        assert_eq!(parsed.to_compact(), "2020");
    }

    #[test]
    fn handles_escapes_and_unicode() {
        let parsed = parse(r#""line1\nline2 é""#).unwrap();
        assert_eq!(parsed.as_str().unwrap(), "line1\nline2 \u{e9}");
    }

    #[test]
    fn rejects_trailing_garbage() {
        assert!(parse("{} junk").is_err());
    }
}
