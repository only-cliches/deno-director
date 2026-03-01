use crate::bridge::types::JsValueBridge;

/// Canonical "wire" JSON format used between Rust and the Deno runtime bootstrap hydration layer.
/// This must stay stable, because bootstrap.js depends on these tags.
pub fn to_wire_json(v: &JsValueBridge) -> serde_json::Value {
    match v {
        JsValueBridge::Undefined => serde_json::json!({ "__undef": true }),
        JsValueBridge::Null => serde_json::Value::Null,
        JsValueBridge::Bool(b) => serde_json::json!(b),

        JsValueBridge::Number(n) => {
            if n.is_nan() {
                serde_json::json!({ "__num": "NaN" })
            } else if *n == f64::INFINITY {
                serde_json::json!({ "__num": "Infinity" })
            } else if *n == f64::NEG_INFINITY {
                serde_json::json!({ "__num": "-Infinity" })
            } else if *n == 0.0 && n.is_sign_negative() {
                serde_json::json!({ "__denojs_worker_num": "-0" })
            } else if n.is_finite() {
                serde_json::json!(n)
            } else {
                // Fallback: should not happen, but never emit invalid JSON numbers.
                serde_json::json!({ "__undef": true })
            }
        }

        JsValueBridge::String(s) => serde_json::json!(s),

        JsValueBridge::BigInt(s) => serde_json::json!({ "__bigint": s }),
        JsValueBridge::DateMs(ms) => serde_json::json!({ "__date": ms }),

        JsValueBridge::RegExp { source, flags } => serde_json::json!({
            "__regexp": { "source": source, "flags": flags }
        }),

        JsValueBridge::BufferView {
            kind,
            bytes,
            byte_offset,
            length,
        } => serde_json::json!({
            "__buffer": {
                "kind": kind,
                "bytes": bytes,
                "byteOffset": byte_offset,
                "length": length,
            }
        }),

        JsValueBridge::Map(entries) => serde_json::json!({
            "__map": entries
                .iter()
                .map(|(k, vv)| [to_wire_json(k), to_wire_json(vv)])
                .collect::<Vec<_>>()
        }),

        JsValueBridge::Set(items) => serde_json::json!({
            "__set": items.iter().map(to_wire_json).collect::<Vec<_>>()
        }),

        JsValueBridge::Url { href } => serde_json::json!({ "__url": href }),
        JsValueBridge::UrlSearchParams { query } => serde_json::json!({ "__urlSearchParams": query }),

        JsValueBridge::Json(j) => j.clone(),
        JsValueBridge::V8Serialized(b) => serde_json::json!({ "__v8": b }),

        JsValueBridge::Error {
            name,
            message,
            stack,
            code,
            cause,
        } => serde_json::json!({
            "__denojs_worker_type": "error",
            "name": name,
            "message": message,
            "stack": stack,
            "code": code,
            "cause": cause.as_ref().map(|c| to_wire_json(c)),
        }),

        JsValueBridge::HostFunction { id, is_async } => serde_json::json!({
            "__denojs_worker_type": "function",
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
            if map.get("__undef").and_then(|v| v.as_bool()) == Some(true) {
                return JsValueBridge::Undefined;
            }

            if map.get("__denojs_worker_num").and_then(|x| x.as_str()) == Some("-0") {
                return JsValueBridge::Number(-0.0);
            }

            if let Some(tag) = map.get("__num").and_then(|v| v.as_str()) {
                return match tag {
                    "NaN" => JsValueBridge::Number(f64::NAN),
                    "Infinity" => JsValueBridge::Number(f64::INFINITY),
                    "-Infinity" => JsValueBridge::Number(f64::NEG_INFINITY),
                    _ => JsValueBridge::Undefined,
                };
            }

            if let Some(ms) = map.get("__date").and_then(|v| v.as_f64()) {
                return JsValueBridge::DateMs(ms);
            }

            if let Some(s) = map.get("__bigint").and_then(|v| v.as_str()) {
                return JsValueBridge::BigInt(s.to_string());
            }

            if let Some(obj) = map.get("__regexp").and_then(|v| v.as_object()) {
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

            if let Some(obj) = map.get("__buffer").and_then(|v| v.as_object()) {
                let kind = obj
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Uint8Array")
                    .to_string();

                let byte_offset = obj
                    .get("byteOffset")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as usize;

                let length = obj
                    .get("length")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as usize;

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

            if let Some(arr) = map.get("__map").and_then(|v| v.as_array()) {
                let mut out = Vec::with_capacity(arr.len());
                for item in arr {
                    let Some(pair) = item.as_array() else { continue };
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

            if let Some(arr) = map.get("__set").and_then(|v| v.as_array()) {
                let mut out = Vec::with_capacity(arr.len());
                for item in arr {
                    out.push(from_wire_json(item.clone()));
                }
                return JsValueBridge::Set(out);
            }

            if let Some(href) = map.get("__url").and_then(|v| v.as_str()) {
                return JsValueBridge::Url {
                    href: href.to_string(),
                };
            }

            if let Some(q) = map.get("__urlSearchParams").and_then(|v| v.as_str()) {
                return JsValueBridge::UrlSearchParams {
                    query: q.to_string(),
                };
            }

            if let Some(bytes) = map.get("__v8").and_then(|v| v.as_array()) {
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

            if map.get("__denojs_worker_type").and_then(|v| v.as_str()) == Some("error") {
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

                let cause = map
                    .get("cause")
                    .cloned()
                    .and_then(|v| if v.is_null() { None } else { Some(Box::new(from_wire_json(v))) });

                return JsValueBridge::Error {
                    name,
                    message,
                    stack,
                    code,
                    cause,
                };
            }

            if map.get("__denojs_worker_type").and_then(|v| v.as_str()) == Some("function") {
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