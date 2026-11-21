// Minimal JSON: a strict parser into a Value tree (hand-written, or serde_json behind the `serde_json` feature, to
// measure what the crate costs) and Go-compatible string quoting for status.json.

pub enum Value {
    Null,
    // The payload of Bool and Arr is the parsed value itself (kept so the tree is complete), but the supervisor
    // only reads their kind() to build Go-style type errors; only the tests read the payload.
    #[cfg_attr(not(test), allow(dead_code))]
    Bool(bool),
    /// The number as written.
    Num(String),
    Str(String),
    #[allow(dead_code)]
    Arr(Vec<Value>),
    Obj(Vec<(String, Value)>),
}

impl Value {
    /// The JSON kind as Go names it in "cannot unmarshal <kind> into ...".
    pub fn kind(&self) -> &'static str {
        match self {
            Value::Null => "null",
            Value::Bool(_) => "bool",
            Value::Num(_) => "number",
            Value::Str(_) => "string",
            Value::Arr(_) => "array",
            Value::Obj(_) => "object",
        }
    }
}

/// A string as Go's json.Marshal writes it: <, > and & as \u00XX, U+2028/2029 escaped, control characters escaped.
pub fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '<' | '>' | '&' | '\u{2028}' | '\u{2029}' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(feature = "serde_json")]
pub fn parse(input: &[u8]) -> Result<Value, String> {
    fn convert(v: serde_json::Value) -> Value {
        match v {
            serde_json::Value::Null => Value::Null,
            serde_json::Value::Bool(b) => Value::Bool(b),
            serde_json::Value::Number(n) => Value::Num(n.to_string()),
            serde_json::Value::String(s) => Value::Str(s),
            serde_json::Value::Array(a) => Value::Arr(a.into_iter().map(convert).collect()),
            serde_json::Value::Object(o) => Value::Obj(o.into_iter().map(|(k, v)| (k, convert(v))).collect()),
        }
    }
    serde_json::from_slice::<serde_json::Value>(input).map(convert).map_err(|e| e.to_string())
}

#[cfg(not(feature = "serde_json"))]
pub fn parse(input: &[u8]) -> Result<Value, String> {
    let mut p = Parser { b: input, i: 0 };
    p.ws();
    let v = p.value(0)?;
    p.ws();
    if p.i != p.b.len() {
        return Err(p.bad("after top-level value"));
    }
    Ok(v)
}

#[cfg(not(feature = "serde_json"))]
struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

#[cfg(not(feature = "serde_json"))]
impl Parser<'_> {
    fn err(&self, what: &str) -> String {
        what.to_string()
    }

    /// Go's "invalid character 'x' <context>", or its "unexpected end of JSON input" at the end.
    fn bad(&self, context: &str) -> String {
        match self.b.get(self.i) {
            None => "unexpected end of JSON input".to_string(),
            Some(&c) => {
                let shown = match c {
                    b'\'' => "'\\''".to_string(),
                    b'\n' => "'\\n'".to_string(),
                    b'\r' => "'\\r'".to_string(),
                    b'\t' => "'\\t'".to_string(),
                    c if !(0x20..0x7f).contains(&c) => format!("'\\x{c:02x}'"),
                    c => format!("'{}'", c as char),
                };
                format!("invalid character {shown} {context}")
            }
        }
    }

    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn eat(&mut self, lit: &str) -> Result<(), String> {
        if self.b[self.i..].starts_with(lit.as_bytes()) {
            self.i += lit.len();
            Ok(())
        } else {
            Err(self.bad("in literal"))
        }
    }

    fn value(&mut self, depth: usize) -> Result<Value, String> {
        if depth > 200 {
            return Err(self.err("exceeded max depth"));
        }
        match self.b.get(self.i) {
            None => Err(self.err("unexpected end of JSON input")),
            Some(b'n') => self.eat("null").map(|_| Value::Null),
            Some(b't') => self.eat("true").map(|_| Value::Bool(true)),
            Some(b'f') => self.eat("false").map(|_| Value::Bool(false)),
            Some(b'"') => self.string().map(Value::Str),
            Some(b'[') => {
                self.i += 1;
                let mut items = Vec::new();
                self.ws();
                if self.b.get(self.i) == Some(&b']') {
                    self.i += 1;
                    return Ok(Value::Arr(items));
                }
                loop {
                    self.ws();
                    items.push(self.value(depth + 1)?);
                    self.ws();
                    match self.b.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Ok(Value::Arr(items));
                        }
                        _ => return Err(self.bad("after array element")),
                    }
                }
            }
            Some(b'{') => {
                self.i += 1;
                let mut members = Vec::new();
                self.ws();
                if self.b.get(self.i) == Some(&b'}') {
                    self.i += 1;
                    return Ok(Value::Obj(members));
                }
                loop {
                    self.ws();
                    if self.b.get(self.i) != Some(&b'"') {
                        return Err(self.bad("looking for beginning of object key string"));
                    }
                    let key = self.string()?;
                    self.ws();
                    if self.b.get(self.i) != Some(&b':') {
                        return Err(self.bad("after object key"));
                    }
                    self.i += 1;
                    self.ws();
                    members.push((key, self.value(depth + 1)?));
                    self.ws();
                    match self.b.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(Value::Obj(members));
                        }
                        _ => return Err(self.bad("after object key:value pair")),
                    }
                }
            }
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(_) => Err(self.bad("looking for beginning of value")),
        }
    }

    fn number(&mut self) -> Result<Value, String> {
        let start = self.i;
        if self.b[self.i] == b'-' {
            self.i += 1;
        }
        match self.b.get(self.i) {
            Some(b'0') => self.i += 1,
            Some(b'1'..=b'9') => self.digits(),
            _ => return Err(self.bad("in numeric literal")),
        }
        if self.b.get(self.i) == Some(&b'.') {
            self.i += 1;
            if !matches!(self.b.get(self.i), Some(b'0'..=b'9')) {
                return Err(self.bad("in numeric literal"));
            }
            self.digits();
        }
        if matches!(self.b.get(self.i), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.b.get(self.i), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if !matches!(self.b.get(self.i), Some(b'0'..=b'9')) {
                return Err(self.bad("in numeric literal"));
            }
            self.digits();
        }
        Ok(Value::Num(String::from_utf8_lossy(&self.b[start..self.i]).into_owned()))
    }

    fn digits(&mut self) {
        while matches!(self.b.get(self.i), Some(b'0'..=b'9')) {
            self.i += 1;
        }
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let mut v = 0u32;
        for _ in 0..4 {
            let d = match self.b.get(self.i) {
                Some(c @ b'0'..=b'9') => c - b'0',
                Some(c @ b'a'..=b'f') => c - b'a' + 10,
                Some(c @ b'A'..=b'F') => c - b'A' + 10,
                _ => return Err(self.err("invalid \\u escape")),
            };
            v = v * 16 + d as u32;
            self.i += 1;
        }
        Ok(v)
    }

    fn string(&mut self) -> Result<String, String> {
        self.i += 1; // opening quote
        let mut out: Vec<u8> = Vec::new();
        loop {
            let c = *self.b.get(self.i).ok_or_else(|| self.err("unexpected end of JSON input"))?;
            self.i += 1;
            match c {
                b'"' => return Ok(String::from_utf8_lossy(&out).into_owned()),
                b'\\' => {
                    let e = *self.b.get(self.i).ok_or_else(|| self.err("unexpected end of JSON input"))?;
                    self.i += 1;
                    match e {
                        b'"' | b'\\' | b'/' => out.push(e),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'u' => {
                            let mut cp = self.hex4()?;
                            if (0xD800..0xDC00).contains(&cp) && self.b[self.i..].starts_with(b"\\u") {
                                let save = self.i;
                                self.i += 2;
                                let lo = self.hex4()?;
                                if (0xDC00..0xE000).contains(&lo) {
                                    cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                                } else {
                                    self.i = save;
                                }
                            }
                            let ch = char::from_u32(cp).unwrap_or('\u{FFFD}');
                            let mut buf = [0u8; 4];
                            out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                        }
                        _ => { self.i -= 1; return Err(self.bad("in string escape code")); }
                    }
                }
                c if c < 0x20 => { self.i -= 1; return Err(self.bad("in string literal")); }
                c => out.push(c),
            }
        }
    }
}

#[cfg(all(test, not(feature = "serde_json")))]
mod tests {
    use super::*;

    #[test]
    fn parses_and_quotes() {
        let v = parse(r#" {"a":[1,2.5e3,"xé😀"],"b":null,"c":{"d":true}} "#.as_bytes()).unwrap();
        assert_eq!(v.kind(), "object");
        assert!(parse(b"{").is_err());
        assert!(parse(b"[1] x").is_err());
        assert!(parse(b"01").is_err());
        assert_eq!(quote("a\"b\\c<>&\n\u{1}"), "\"a\\\"b\\\\c\\u003c\\u003e\\u0026\\n\\u0001\"");
    }
}
