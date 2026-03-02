use crate::bridge::tags::{
    BIGINT_KEY, BUFFER_KEY, DATE_KEY, MAP_KEY, NUMBER_KEY, NUMBER_NEG_ZERO_KEY, REGEXP_KEY,
    SET_KEY, TYPE_ERROR, TYPE_FUNCTION, TYPE_KEY, UNDEFINED_KEY, URL_KEY, URL_SEARCH_PARAMS_KEY,
    V8_KEY,
};
use crate::bridge::types::JsValueBridge;

/// Canonical "wire" JSON format used between Rust and the Deno runtime bootstrap hydration layer.
/// This must stay stable, because bootstrap.js depends on these tags.
pub fn to_wire_json(v: &JsValueBridge) -> serde_json::Value {
    match v {
        JsValueBridge::Undefined => serde_json::json!({ UNDEFINED_KEY: true }),
        JsValueBridge::Null => serde_json::Value::Null,
        JsValueBridge::Bool(b) => serde_json::json!(b),

        JsValueBridge::Number(n) => {
            if n.is_nan() {
                serde_json::json!({ NUMBER_KEY: "NaN" })
            } else if *n == f64::INFINITY {
                serde_json::json!({ NUMBER_KEY: "Infinity" })
            } else if *n == f64::NEG_INFINITY {
                serde_json::json!({ NUMBER_KEY: "-Infinity" })
            } else if *n == 0.0 && n.is_sign_negative() {
                serde_json::json!({ NUMBER_NEG_ZERO_KEY: "-0" })
            } else if n.is_finite() {
                serde_json::json!(n)
            } else {
                // Fallback: should not happen, but never emit invalid JSON numbers.
                serde_json::json!({ UNDEFINED_KEY: true })
            }
        }

        JsValueBridge::String(s) => serde_json::json!(s),

        JsValueBridge::BigInt(s) => serde_json::json!({ BIGINT_KEY: s }),
        JsValueBridge::DateMs(ms) => serde_json::json!({ DATE_KEY: ms }),

        JsValueBridge::RegExp { source, flags } => serde_json::json!({
            REGEXP_KEY: { "source": source, "flags": flags }
        }),

        JsValueBridge::BufferView {
            kind,
            bytes,
            byte_offset,
            length,
        } => serde_json::json!({
            BUFFER_KEY: {
                "kind": kind,
                "bytes": bytes,
                "byteOffset": byte_offset,
                "length": length,
            }
        }),

        JsValueBridge::Map(entries) => serde_json::json!({
            MAP_KEY: entries
                .iter()
                .map(|(k, vv)| [to_wire_json(k), to_wire_json(vv)])
                .collect::<Vec<_>>()
        }),

        JsValueBridge::Set(items) => serde_json::json!({
            SET_KEY: items.iter().map(to_wire_json).collect::<Vec<_>>()
        }),

        JsValueBridge::Url { href } => serde_json::json!({ URL_KEY: href }),
        JsValueBridge::UrlSearchParams { query } => {
            serde_json::json!({ URL_SEARCH_PARAMS_KEY: query })
        }

        JsValueBridge::Json(j) => j.clone(),
        JsValueBridge::V8Serialized(b) => serde_json::json!({ V8_KEY: b }),

        JsValueBridge::Error {
            name,
            message,
            stack,
            code,
            cause,
        } => serde_json::json!({
            TYPE_KEY: TYPE_ERROR,
            "name": name,
            "message": message,
            "stack": stack,
            "code": code,
            "cause": cause.as_ref().map(|c| to_wire_json(c)),
        }),

        JsValueBridge::HostFunction { id, is_async } => serde_json::json!({
            TYPE_KEY: TYPE_FUNCTION,
            "id": id,
            "async": is_async
        }),
    }
}

/// Best effort parse from the wire JSON format into a bridge value.
/// This is intentionally permissive because callers may give us plain JSON.
#[allow(dead_code)]
pub fn from_wire_json(v: serde_json::Value) -> JsValueBridge {
    match v {
        serde_json::Value::Null => JsValueBridge::Null,
        serde_json::Value::Bool(b) => JsValueBridge::Bool(b),

        serde_json::Value::Number(n) => {
            let f = n.as_f64().unwrap_or(0.0);
            if f == 0.0 && f.is_sign_negative() {
                JsValueBridge::Number(-0.0)
            } else {
                JsValueBridge::Number(f)
            }
        }

        serde_json::Value::String(s) => JsValueBridge::String(s),

        serde_json::Value::Array(a) => JsValueBridge::Json(serde_json::Value::Array(a)),

        serde_json::Value::Object(map) => {
            if map.get(UNDEFINED_KEY).and_then(|v| v.as_bool()) == Some(true) {
                return JsValueBridge::Undefined;
            }

            if map.get(NUMBER_NEG_ZERO_KEY).and_then(|x| x.as_str()) == Some("-0") {
                return JsValueBridge::Number(-0.0);
            }

            if let Some(tag) = map.get(NUMBER_KEY).and_then(|v| v.as_str()) {
                return match tag {
                    "NaN" => JsValueBridge::Number(f64::NAN),
                    "Infinity" => JsValueBridge::Number(f64::INFINITY),
                    "-Infinity" => JsValueBridge::Number(f64::NEG_INFINITY),
                    _ => JsValueBridge::Undefined,
                };
            }

            if let Some(ms) = map.get(DATE_KEY).and_then(|v| v.as_f64()) {
                return JsValueBridge::DateMs(ms);
            }

            if let Some(s) = map.get(BIGINT_KEY).and_then(|v| v.as_str()) {
                return JsValueBridge::BigInt(s.to_string());
            }

            if let Some(obj) = map.get(REGEXP_KEY).and_then(|v| v.as_object()) {
                let source = obj
                    .get("source")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let flags = obj
                    .get("flags")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                return JsValueBridge::RegExp { source, flags };
            }

            if let Some(obj) = map.get(BUFFER_KEY).and_then(|v| v.as_object()) {
                let kind = obj
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Uint8Array")
                    .to_string();

                let byte_offset =
                    obj.get("byteOffset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;

                let length = obj.get("length").and_then(|v| v.as_u64()).unwrap_or(0) as usize;

                if let Some(bytes_arr) = obj.get("bytes").and_then(|v| v.as_array()) {
                    let mut out = Vec::with_capacity(bytes_arr.len());
                    for b in bytes_arr {
                        if let Some(n) = b.as_u64() {
                            out.push((n & 0xFF) as u8);
                        } else {
                            return JsValueBridge::Json(serde_json::Value::Object(map));
                        }
                    }

                    return JsValueBridge::BufferView {
                        kind,
                        bytes: out,
                        byte_offset,
                        length,
                    };
                }
            }

            if let Some(arr) = map.get(MAP_KEY).and_then(|v| v.as_array()) {
                let mut out = Vec::with_capacity(arr.len());
                for item in arr {
                    let Some(pair) = item.as_array() else {
                        continue;
                    };
                    if pair.len() != 2 {
                        continue;
                    }
                    out.push((
                        from_wire_json(pair[0].clone()),
                        from_wire_json(pair[1].clone()),
                    ));
                }
                return JsValueBridge::Map(out);
            }

            if let Some(arr) = map.get(SET_KEY).and_then(|v| v.as_array()) {
                let mut out = Vec::with_capacity(arr.len());
                for item in arr {
                    out.push(from_wire_json(item.clone()));
                }
                return JsValueBridge::Set(out);
            }

            if let Some(href) = map.get(URL_KEY).and_then(|v| v.as_str()) {
                return JsValueBridge::Url {
                    href: href.to_string(),
                };
            }

            if let Some(q) = map.get(URL_SEARCH_PARAMS_KEY).and_then(|v| v.as_str()) {
                return JsValueBridge::UrlSearchParams {
                    query: q.to_string(),
                };
            }

            if let Some(bytes) = map.get(V8_KEY).and_then(|v| v.as_array()) {
                let mut out = Vec::with_capacity(bytes.len());
                for b in bytes {
                    if let Some(n) = b.as_u64() {
                        out.push((n & 0xFF) as u8);
                    } else {
                        return JsValueBridge::Json(serde_json::Value::Object(map));
                    }
                }
                return JsValueBridge::V8Serialized(out);
            }

            if map.get(TYPE_KEY).and_then(|v| v.as_str()) == Some(TYPE_ERROR) {
                let name = map
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Error")
                    .to_string();
                let message = map
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let stack = map
                    .get("stack")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let code = map
                    .get("code")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                let cause = map.get("cause").cloned().and_then(|v| {
                    if v.is_null() {
                        None
                    } else {
                        Some(Box::new(from_wire_json(v)))
                    }
                });

                return JsValueBridge::Error {
                    name,
                    message,
                    stack,
                    code,
                    cause,
                };
            }

            if map.get(TYPE_KEY).and_then(|v| v.as_str()) == Some(TYPE_FUNCTION) {
                if let Some(id) = map.get("id").and_then(|v| v.as_u64()) {
                    let is_async = map.get("async").and_then(|v| v.as_bool()).unwrap_or(false);
                    return JsValueBridge::HostFunction {
                        id: id as usize,
                        is_async,
                    };
                }
            }

            JsValueBridge::Json(serde_json::Value::Object(map))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{from_wire_json, to_wire_json};
    use crate::bridge::types::JsValueBridge;

    fn assert_number_eq(actual: f64, expected: f64) {
        if expected.is_nan() {
            assert!(actual.is_nan(), "expected NaN, got {}", actual);
            return;
        }
        if expected == 0.0 && expected.is_sign_negative() {
            assert!(
                actual == 0.0 && actual.is_sign_negative(),
                "expected -0, got {}",
                actual
            );
            return;
        }
        assert_eq!(actual, expected);
    }

    fn assert_bridge_eq(actual: JsValueBridge, expected: JsValueBridge) {
        match (actual, expected) {
            (JsValueBridge::Undefined, JsValueBridge::Undefined)
            | (JsValueBridge::Null, JsValueBridge::Null) => {}

            (JsValueBridge::Bool(a), JsValueBridge::Bool(b)) => assert_eq!(a, b),
            (JsValueBridge::String(a), JsValueBridge::String(b)) => assert_eq!(a, b),
            (JsValueBridge::Number(a), JsValueBridge::Number(b)) => assert_number_eq(a, b),
            (JsValueBridge::BigInt(a), JsValueBridge::BigInt(b)) => assert_eq!(a, b),
            (JsValueBridge::DateMs(a), JsValueBridge::DateMs(b)) => assert_eq!(a, b),
            (
                JsValueBridge::RegExp {
                    source: asrc,
                    flags: aflags,
                },
                JsValueBridge::RegExp {
                    source: bsrc,
                    flags: bflags,
                },
            ) => {
                assert_eq!(asrc, bsrc);
                assert_eq!(aflags, bflags);
            }
            (
                JsValueBridge::BufferView {
                    kind: ak,
                    bytes: ab,
                    byte_offset: abo,
                    length: al,
                },
                JsValueBridge::BufferView {
                    kind: bk,
                    bytes: bb,
                    byte_offset: bbo,
                    length: bl,
                },
            ) => {
                assert_eq!(ak, bk);
                assert_eq!(ab, bb);
                assert_eq!(abo, bbo);
                assert_eq!(al, bl);
            }
            (JsValueBridge::Map(a), JsValueBridge::Map(b)) => {
                assert_eq!(a.len(), b.len());
                for (ap, bp) in a.into_iter().zip(b.into_iter()) {
                    assert_bridge_eq(ap.0, bp.0);
                    assert_bridge_eq(ap.1, bp.1);
                }
            }
            (JsValueBridge::Set(a), JsValueBridge::Set(b)) => {
                assert_eq!(a.len(), b.len());
                for (av, bv) in a.into_iter().zip(b.into_iter()) {
                    assert_bridge_eq(av, bv);
                }
            }
            (JsValueBridge::Url { href: a }, JsValueBridge::Url { href: b }) => {
                assert_eq!(a, b);
            }
            (
                JsValueBridge::UrlSearchParams { query: a },
                JsValueBridge::UrlSearchParams { query: b },
            ) => {
                assert_eq!(a, b);
            }
            (JsValueBridge::Json(a), JsValueBridge::Json(b)) => assert_eq!(a, b),
            (JsValueBridge::V8Serialized(a), JsValueBridge::V8Serialized(b)) => assert_eq!(a, b),
            (
                JsValueBridge::HostFunction {
                    id: aid,
                    is_async: aa,
                },
                JsValueBridge::HostFunction {
                    id: bid,
                    is_async: ba,
                },
            ) => {
                assert_eq!(aid, bid);
                assert_eq!(aa, ba);
            }
            (
                JsValueBridge::Error {
                    name: an,
                    message: am,
                    stack: ast,
                    code: ac,
                    cause: acause,
                },
                JsValueBridge::Error {
                    name: bn,
                    message: bm,
                    stack: bst,
                    code: bc,
                    cause: bcause,
                },
            ) => {
                assert_eq!(an, bn);
                assert_eq!(am, bm);
                assert_eq!(ast, bst);
                assert_eq!(ac, bc);
                match (acause, bcause) {
                    (Some(a), Some(b)) => assert_bridge_eq(*a, *b),
                    (None, None) => {}
                    (a, b) => panic!("cause mismatch: {:?} vs {:?}", a, b),
                }
            }
            (a, b) => panic!("bridge mismatch: {:?} vs {:?}", a, b),
        }
    }

    #[test]
    fn round_trips_special_numbers_and_undefined() {
        for val in [
            JsValueBridge::Undefined,
            JsValueBridge::Number(-0.0),
            JsValueBridge::Number(f64::NAN),
            JsValueBridge::Number(f64::INFINITY),
            JsValueBridge::Number(f64::NEG_INFINITY),
            JsValueBridge::Number(42.5),
        ] {
            let out = from_wire_json(to_wire_json(&val));
            assert_bridge_eq(out, val);
        }
    }

    #[test]
    fn round_trips_structured_values() {
        let val = JsValueBridge::Map(vec![
            (
                JsValueBridge::String("k".into()),
                JsValueBridge::Set(vec![
                    JsValueBridge::DateMs(1700000000000.0),
                    JsValueBridge::BigInt("9007199254740993".into()),
                    JsValueBridge::BufferView {
                        kind: "Uint8Array".into(),
                        bytes: vec![1, 2, 3, 255],
                        byte_offset: 0,
                        length: 4,
                    },
                ]),
            ),
            (
                JsValueBridge::Bool(true),
                JsValueBridge::RegExp {
                    source: "ab+".into(),
                    flags: "gi".into(),
                },
            ),
        ]);

        let out = from_wire_json(to_wire_json(&val));
        assert_bridge_eq(out, val);
    }

    #[test]
    fn round_trips_error_and_host_fn() {
        let val = JsValueBridge::Error {
            name: "TypeError".into(),
            message: "boom".into(),
            stack: Some("stack".into()),
            code: Some("E_BANG".into()),
            cause: Some(Box::new(JsValueBridge::HostFunction {
                id: 12,
                is_async: true,
            })),
        };
        let out = from_wire_json(to_wire_json(&val));
        assert_bridge_eq(out, val);
    }

    #[test]
    fn preserves_plain_json_objects_as_json_variant() {
        let j = serde_json::json!({
            "a": 1,
            "b": [true, null, "x"],
            "nested": { "k": "v" }
        });
        let out = from_wire_json(j.clone());
        assert_bridge_eq(out, JsValueBridge::Json(j));
    }
}
