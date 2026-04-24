use bytes::Bytes;
use neon::{prelude::*, result::Throw};
use serde::{Deserialize, Serialize};

/// Runtime-neutral representation of JavaScript values crossing the Node, Rust, and Deno boundary.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", content = "v")]
pub enum JsValueBridge {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(String),

    /// Decimal string form, preserving values that cannot round-trip through `f64`.
    BigInt(String),
    DateMs(f64),

    RegExp {
        source: String,
        flags: String,
    },

    /// Raw bytes plus the JS view metadata needed to reconstruct ArrayBuffer views.
    BufferView {
        /// Constructor name such as `ArrayBuffer`, `Uint8Array`, `Int32Array`, or `DataView`.
        kind: String,
        bytes: Bytes,
        byte_offset: usize,
        /// Typed arrays use element length; DataView and ArrayBuffer use byte length.
        length: usize,
    },

    /// Map entries in insertion order. Some JS-side encoders may omit non-primitive keys.
    Map(Vec<(JsValueBridge, JsValueBridge)>),
    Set(Vec<JsValueBridge>),

    Url {
        href: String,
    },
    UrlSearchParams {
        query: String,
    },

    Json(serde_json::Value),
    V8Serialized(Vec<u8>),

    Error {
        name: String,
        message: String,
        stack: Option<String>,
        code: Option<String>,
        cause: Option<Box<JsValueBridge>>,
    },

    HostFunction {
        id: usize,
        is_async: bool,
    },
}

/// Options attached to one eval or evalModule request.
#[derive(Debug, Clone)]
pub struct EvalOptions {
    pub filename: String,
    pub is_module: bool,
    pub loader: String,
    pub args: Vec<JsValueBridge>,
    pub args_provided: bool,
    pub max_eval_ms: Option<u64>,
    pub max_cpu_ms: Option<u64>,
}

impl Default for EvalOptions {
    // Defaults match script eval behavior unless callers request module loading or limits.
    fn default() -> Self {
        Self {
            filename: "Unnamed Script".to_string(),
            is_module: false,
            loader: "js".to_string(),
            args: vec![],
            args_provided: false,
            max_eval_ms: None,
            max_cpu_ms: None,
        }
    }
}

impl EvalOptions {
    /// Parses eval options from a JavaScript options object.
    pub fn from_neon<'a>(cx: &mut FunctionContext<'a>, idx: i32) -> Result<Self, Throw> {
        let mut out = EvalOptions::default();

        if (idx as usize) >= cx.len() {
            return Ok(out);
        }

        let raw = cx.argument::<JsValue>(idx as usize)?;
        if raw.is_a::<JsNull, _>(cx) || raw.is_a::<JsUndefined, _>(cx) {
            return Ok(out);
        }

        let obj = match raw.downcast::<JsObject, _>(cx) {
            Ok(o) => o,
            Err(_) => return Ok(out),
        };

        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "filename") {
            if let Ok(s) = v.downcast::<JsString, _>(cx) {
                out.filename = s.value(cx);
            }
        }

        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "type") {
            if let Ok(s) = v.downcast::<JsString, _>(cx) {
                out.is_module = s.value(cx) == "module";
            }
        }

        let source_loader_value = obj
            .get::<JsValue, _, _>(cx, "srcLoader")
            .or_else(|_| obj.get::<JsValue, _, _>(cx, "loader"));
        if let Ok(v) = source_loader_value {
            if let Ok(s) = v.downcast::<JsString, _>(cx) {
                let loader = s.value(cx);
                if matches!(loader.as_str(), "js" | "ts" | "tsx" | "jsx") {
                    out.loader = loader;
                }
            }
        }

        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "args") {
            out.args_provided = true;
            if let Ok(arr) = v.downcast::<JsArray, _>(cx) {
                for i in 0..arr.len(cx) {
                    let item = arr.get::<JsValue, _, _>(cx, i)?;
                    out.args
                        .push(crate::bridge::neon_codec::from_neon_value(cx, item)?);
                }
            }
        }

        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "maxEvalMs") {
            if let Ok(n) = v.downcast::<JsNumber, _>(cx) {
                let ms = n.value(cx);
                if ms.is_finite() && ms > 0.0 {
                    out.max_eval_ms = Some(ms as u64);
                }
            }
        }
        if let Ok(v) = obj.get::<JsValue, _, _>(cx, "maxCpuMs") {
            if let Ok(n) = v.downcast::<JsNumber, _>(cx) {
                let ms = n.value(cx);
                if ms.is_finite() && ms > 0.0 {
                    out.max_cpu_ms = Some(ms as u64);
                }
            }
        }

        Ok(out)
    }
}

impl JsValueBridge {
    /// Converts a Deno core JavaScript error into a bridge error payload.
    pub fn js_error_to_bridge(e: Box<deno_core::error::JsError>) -> Self {
        Self::Error {
            name: "Error".into(),
            message: e.to_string(),
            stack: None,
            code: None,
            cause: None,
        }
    }

    /// Converts an arbitrary Rust error into a bridge error payload.
    pub fn any_error_to_bridge(e: deno_core::error::AnyError) -> Self {
        Self::Error {
            name: "Error".into(),
            message: e.to_string(),
            stack: None,
            code: None,
            cause: None,
        }
    }

    /// Builds a generic bridge error with only a message.
    pub fn simple_err(msg: String) -> Self {
        Self::Error {
            name: "Error".into(),
            message: msg,
            stack: None,
            code: None,
            cause: None,
        }
    }
}
