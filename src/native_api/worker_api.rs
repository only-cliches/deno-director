use bytes::Bytes;
use neon::prelude::*;
use neon::types::buffer::TypedArray;
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use crate::bridge::promise::PromiseSettler;
use crate::bridge::tags::{TYPE_FUNCTION, TYPE_KEY};
use crate::bridge::types::JsValueBridge;
use crate::queue_deno_msg_or_reject;
use crate::worker;
use crate::worker::messages::{DenoMsg, EvalReply};
use crate::worker::state::WorkerHandle;
use crate::{
    NEXT_ID, WORKERS, deno_control_tx_for_worker, deno_data_tx_for_worker, mk_err,
    parse_eval_options,
};
use neon::result::Throw;
use neon::types::JsDate;

mod channel_send;
use channel_send::{SendOutcome, send_with_backpressure};

fn send_bool_with_optional_blocking(
    tx: &tokio::sync::mpsc::Sender<DenoMsg>,
    msg: DenoMsg,
    strict_message: &str,
) -> Result<bool, String> {
    match tx.try_send(msg) {
        Ok(()) => Ok(true),
        Err(tokio::sync::mpsc::error::TrySendError::Full(msg)) => match tx.blocking_send(msg) {
            Ok(()) => Ok(true),
            Err(_e) => {
                if strict_channel() {
                    Err(strict_message.to_string())
                } else {
                    Ok(false)
                }
            }
        },
        Err(tokio::sync::mpsc::error::TrySendError::Closed(_msg)) => {
            if strict_channel() {
                Err(strict_message.to_string())
            } else {
                Ok(false)
            }
        }
    }
}

// Reads an optional string property from a JS object.
fn get_string_prop<'a, C: Context<'a>>(
    cx: &mut C,
    obj: Handle<'a, JsObject>,
    key: &str,
) -> Option<String> {
    let v = obj.get_value(cx, key).ok()?;
    let s = v.downcast::<JsString, _>(cx).ok()?;
    Some(s.value(cx))
}

// Wire marker consumed by bootstrap hydration to create worker-callable host functions.
fn host_fn_tag(id: usize, is_async: bool) -> serde_json::Value {
    json!({
        TYPE_KEY: TYPE_FUNCTION,
        "id": id,
        "async": is_async
    })
}

// Roots a JS function and registers it in the worker host-function table.
fn register_host_fn<'a>(
    worker_id: usize,
    cx: &mut FunctionContext<'a>,
    func: Handle<'a, JsFunction>,
) -> Option<usize> {
    let rooted = func.root(cx);
    let mut map = WORKERS.write().ok()?;
    let w = map.get_mut(&worker_id)?;
    Some(w.register_global_fn(rooted))
}

// Builds a sync Node console callback used by console:"node" routing.
fn build_node_console_bridge_fn<'a>(
    cx: &mut FunctionContext<'a>,
    method: &'static str,
) -> NeonResult<Handle<'a, JsFunction>> {
    let method_str: String = method.to_string();
    JsFunction::new(cx, move |mut cx| {
        let console_obj = match cx.global::<JsObject>("console") {
            Ok(c) => c,
            Err(_) => return Ok(cx.undefined()),
        };

        let func_any = match console_obj.get_value(&mut cx, method_str.as_str()) {
            Ok(v) => v,
            Err(_) => return Ok(cx.undefined()),
        };

        let Ok(func) = func_any.downcast::<JsFunction, _>(&mut cx) else {
            return Ok(cx.undefined());
        };

        let argc = cx.len();
        let mut argv: Vec<Handle<JsValue>> = Vec::with_capacity(argc);
        for i in 0..argc {
            let v = cx.argument::<JsValue>(i)?;

            // Jest worker transport cannot JSON stringify BigInt, so sanitize here.
            let v2: Handle<JsValue> = if v.is_a::<neon::types::JsBigInt, _>(&mut cx) {
                let s = cx
                    .try_catch(|cx| v.to_string(cx))
                    .ok()
                    .map(|ss| ss.value(&mut cx))
                    .unwrap_or_else(|| "0".to_string());
                cx.string(format!("{s}n")).upcast()
            } else {
                v
            };

            argv.push(v2);
        }

        let _ = cx.try_catch(|cx| {
            let _ = func.call(cx, console_obj, argv.as_slice())?;
            Ok(())
        });

        Ok(cx.undefined())
    })
}

// Best-effort detection for async functions used to choose sync vs async callback path.
fn is_async_like<'a>(cx: &mut FunctionContext<'a>, func: Handle<'a, JsFunction>) -> bool {
    let candidate: Handle<'a, JsFunction> = func;

    let tag_is_async = (|| -> Option<bool> {
        let object_ctor: Handle<JsFunction> = cx.global("Object").ok()?;
        let proto_val = object_ctor.get_value(cx, "prototype").ok()?;
        let proto = proto_val.downcast::<JsObject, _>(cx).ok()?;
        let to_string_val = proto.get_value(cx, "toString").ok()?;
        let to_string = to_string_val.downcast::<JsFunction, _>(cx).ok()?;

        let s = to_string
            .call_with(cx)
            .this(candidate)
            .apply::<JsString, _>(cx)
            .ok()?
            .value(cx);

        Some(s == "[object AsyncFunction]")
    })()
    .unwrap_or(false);

    if tag_is_async {
        return true;
    }

    (|| -> Option<bool> {
        let obj = candidate.upcast::<JsObject>();
        let ctor_val = obj.get_value(cx, "constructor").ok()?;
        let ctor_obj = ctor_val.downcast::<JsObject, _>(cx).ok()?;
        let name_val = ctor_obj.get_value(cx, "name").ok()?;
        let name = name_val.downcast::<JsString, _>(cx).ok()?.value(cx);
        Some(name == "AsyncFunction")
    })()
    .unwrap_or(false)
}

// Converts the public `console` option into the worker-side console routing map.
fn build_console_config_from_neon<'a>(
    cx: &mut FunctionContext<'a>,
    worker_id: usize,
    raw_console: Handle<'a, JsValue>,
) -> Option<serde_json::Value> {
    if raw_console.is_a::<JsUndefined, _>(cx) || raw_console.is_a::<JsNull, _>(cx) {
        return None;
    }

    if let Ok(b) = raw_console.downcast::<JsBoolean, _>(cx) {
        if b.value(cx) == false {
            return Some(serde_json::Value::Bool(false));
        }
        return None;
    }

    let Ok(obj) = raw_console.downcast::<JsObject, _>(cx) else {
        return None;
    };

    // Marker mode: { __denojs_worker_console_mode: "node" }
    // This should be synchronous so logs stream during long sync CPU loops.
    if get_string_prop(cx, obj, "__denojs_worker_console_mode").as_deref() == Some("node") {
        let methods: &[(&str, &'static str)] = &[
            ("log", "log"),
            ("info", "info"),
            ("warn", "warn"),
            ("error", "error"),
            ("debug", "debug"),
            ("trace", "trace"),
        ];

        let mut map = serde_json::Map::new();

        for (k, m) in methods {
            if let Ok(f) = build_node_console_bridge_fn(cx, m) {
                if let Some(id) = register_host_fn(worker_id, cx, f) {
                    // Node console routing should be sync.
                    map.insert((*k).to_string(), host_fn_tag(id, false));
                }
            }
        }

        if map.is_empty() {
            None
        } else {
            Some(serde_json::Value::Object(map))
        }
    } else {
        // Per-method mode: { log, info, warn, error, debug, trace }
        // - function: sync by default
        // - async function: use async host call
        // - false: ignore
        // - missing: default behavior (restore originals in worker)
        let keys: &[&str] = &["log", "info", "warn", "error", "debug", "trace"];
        let mut map = serde_json::Map::new();

        for k in keys {
            let v = match obj.get_value(cx, *k) {
                Ok(v) => v,
                Err(_) => continue,
            };

            if v.is_a::<JsUndefined, _>(cx) || v.is_a::<JsNull, _>(cx) {
                continue;
            }

            if let Ok(b) = v.downcast::<JsBoolean, _>(cx) {
                if b.value(cx) == false {
                    map.insert((*k).to_string(), serde_json::Value::Bool(false));
                }
                continue;
            }

            if let Ok(f) = v.downcast::<JsFunction, _>(cx) {
                let async_like = is_async_like(cx, f);
                if let Some(id) = register_host_fn(worker_id, cx, f) {
                    map.insert((*k).to_string(), host_fn_tag(id, async_like));
                }
                continue;
            }
        }

        if map.is_empty() {
            None
        } else {
            Some(serde_json::Value::Object(map))
        }
    }
}

// Opt-in mode for callers that prefer exceptions over best-effort false/zero returns.
fn strict_channel() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var("DENOJS_WORKER_STRICT_CHANNEL")
            .ok()
            .map(|v| {
                let v = v.trim().to_ascii_lowercase();
                v == "1" || v == "true" || v == "yes" || v == "on"
            })
            .unwrap_or(false)
    })
}

// Looks up the current data-plane sender; absence means the worker is already closed.
fn data_tx(worker_id: usize) -> Option<tokio::sync::mpsc::Sender<DenoMsg>> {
    deno_data_tx_for_worker(worker_id)
}

// Gets Object.prototype.toString.call(value), which is reliable across JS realms.
fn object_to_string_tag<'a>(
    cx: &mut FunctionContext<'a>,
    value: Handle<'a, JsValue>,
) -> Option<String> {
    let object_ctor: Handle<JsFunction> = cx.global("Object").ok()?;
    let proto_any = object_ctor.get_value(cx, "prototype").ok()?;
    let proto = proto_any.downcast::<JsObject, _>(cx).ok()?;
    let to_string_any = proto.get_value(cx, "toString").ok()?;
    let to_string = to_string_any.downcast::<JsFunction, _>(cx).ok()?;
    let s = to_string
        .call_with(cx)
        .this(value)
        .apply::<JsString, _>(cx)
        .ok()?;
    Some(s.value(cx))
}

// Detects ArrayBuffer views without relying on every typed-array class being imported into Rust.
fn is_arraybuffer_view<'a>(cx: &mut FunctionContext<'a>, value: Handle<'a, JsValue>) -> bool {
    cx.try_catch(|cx| {
        let ab_ctor: Handle<JsFunction> = cx.global("ArrayBuffer")?;
        let is_view = ab_ctor.get::<JsFunction, _, _>(cx, "isView")?;
        let out = is_view
            .call_with(cx)
            .this(ab_ctor)
            .arg(value)
            .apply::<JsBoolean, _>(cx)?
            .value(cx);
        Ok(out)
    })
    .unwrap_or(false)
}

fn is_binary_js_value<'a>(cx: &mut FunctionContext<'a>, value: Handle<'a, JsValue>) -> bool {
    value.is_a::<JsBuffer, _>(cx)
        || value.is_a::<JsUint8Array, _>(cx)
        || value.is_a::<JsArrayBuffer, _>(cx)
}

// Copies Node binary values into Bytes so they can be moved across the runtime channel safely.
fn js_value_to_bytes<'a>(
    cx: &mut FunctionContext<'a>,
    value: Handle<'a, JsValue>,
) -> Option<Bytes> {
    if let Ok(buf) = value.downcast::<JsBuffer, _>(cx) {
        return Some(Bytes::copy_from_slice(buf.as_slice(cx)));
    }
    if let Ok(u8) = value.downcast::<JsUint8Array, _>(cx) {
        return Some(Bytes::copy_from_slice(u8.as_slice(cx)));
    }
    if let Ok(ab) = value.downcast::<JsArrayBuffer, _>(cx) {
        return Some(Bytes::copy_from_slice(ab.as_slice(cx)));
    }
    None
}

// Returns true for plain objects that should be walked to preserve nested host functions.
fn should_expand_object<'a>(
    cx: &mut FunctionContext<'a>,
    value: Handle<'a, JsValue>,
    obj: Handle<'a, JsObject>,
) -> bool {
    if value.is_a::<JsDate, _>(cx)
        || value.is_a::<JsBuffer, _>(cx)
        || value.is_a::<JsError, _>(cx)
        || value.is_a::<JsArray, _>(cx)
    {
        return false;
    }

    if is_arraybuffer_view(cx, value) {
        return false;
    }

    if let Some(tag) = object_to_string_tag(cx, value) {
        match tag.as_str() {
            "[object Date]"
            | "[object RegExp]"
            | "[object Map]"
            | "[object Set]"
            | "[object URL]"
            | "[object URLSearchParams]"
            | "[object ArrayBuffer]"
            | "[object SharedArrayBuffer]"
            | "[object DataView]"
            | "[object Promise]" => return false,
            _ => {}
        }
    }

    // For plain containers (including module namespace-like objects), walk keys
    // recursively so nested JS functions are converted to host-callable bridge
    // tags instead of being silently dropped.
    !own_enumerable_string_keys(cx, obj).is_empty()
}

// Detects already-encoded wire markers so recursive object expansion does not corrupt them.
fn is_special_wire_json_object(v: &serde_json::Value) -> bool {
    let Some(obj) = v.as_object() else {
        return false;
    };

    if let Some(t) = obj
        .get("__denojs_worker_type")
        .and_then(|x| x.as_str())
        .filter(|x| *x == "error" || *x == "function")
    {
        let _ = t;
        return true;
    }

    // These tags represent already-encoded wire payloads and must not be
    // traversed/expanded again, or type markers can be corrupted.
    const SPECIAL_KEYS: [&str; 11] = [
        "__buffer",
        "__map",
        "__set",
        "__url",
        "__urlSearchParams",
        "__date",
        "__bigint",
        "__regexp",
        "__num",
        "__denojs_worker_num",
        "__undef",
    ];

    SPECIAL_KEYS.iter().any(|k| obj.contains_key(*k))
}

// Returns own enumerable string keys using JS `Object.keys` semantics.
fn own_enumerable_string_keys<'a>(
    cx: &mut FunctionContext<'a>,
    obj: Handle<'a, JsObject>,
) -> Vec<String> {
    cx.try_catch(|cx| {
        let object_ctor: Handle<JsFunction> = cx.global("Object")?;
        let keys_fn = object_ctor.get::<JsFunction, _, _>(cx, "keys")?;
        let keys_arr = keys_fn
            .call_with(cx)
            .this(object_ctor)
            .arg(obj)
            .apply::<JsArray, _>(cx)?;

        let mut out = Vec::with_capacity(keys_arr.len(cx) as usize);
        for i in 0..keys_arr.len(cx) {
            let v = keys_arr.get_value(cx, i)?;
            if let Ok(s) = v.downcast::<JsString, _>(cx) {
                out.push(s.value(cx));
            }
        }
        Ok(out)
    })
    .unwrap_or_default()
}

// Encodes setGlobal values while preserving nested functions as callable host bridges.
// The general Neon codec handles rich data types first; plain containers are
// walked only so nested functions survive as host callback markers.
fn encode_set_global_value<'a>(
    cx: &mut FunctionContext<'a>,
    worker: &mut WorkerHandle,
    value: Handle<'a, JsValue>,
    depth: usize,
) -> Result<JsValueBridge, Throw> {
    if depth > 32 {
        return Ok(JsValueBridge::Undefined);
    }

    if let Ok(func) = value.downcast::<JsFunction, _>(cx) {
        // Functions become callback IDs that can be invoked from the worker via ops.
        let is_async = is_async_like(cx, func);
        let callback_id = worker.register_global_fn(func.root(cx));
        return Ok(JsValueBridge::HostFunction {
            id: callback_id,
            is_async,
        });
    }

    if let Ok(arr) = value.downcast::<JsArray, _>(cx) {
        let mut out = Vec::with_capacity(arr.len(cx) as usize);
        for i in 0..arr.len(cx) {
            let item = arr
                .get_value(cx, i)
                .unwrap_or_else(|_| cx.undefined().upcast::<JsValue>());
            let bridged = encode_set_global_value(cx, worker, item, depth + 1)?;
            out.push(crate::bridge::wire::to_wire_json(&bridged));
        }
        return Ok(JsValueBridge::Json(serde_json::Value::Array(out)));
    }

    if let Ok(obj) = value.downcast::<JsObject, _>(cx) {
        // Keep literal wire-marker objects untouched, but avoid V8 serialized
        // blobs for structured globals. setGlobal installs values via worker
        // bootstrap hydration, so canonical wire JSON is the safe boundary for
        // realm-sensitive constructors like Map/Set/URL/typed arrays.
        let baseline = crate::bridge::neon_codec::from_neon_value(cx, value)?;
        if let JsValueBridge::Json(j) = &baseline {
            if is_special_wire_json_object(j) {
                return Ok(baseline);
            }
        }

        if should_expand_object(cx, value, obj) {
            let keys = own_enumerable_string_keys(cx, obj);
            let mut out = serde_json::Map::new();
            for key in keys {
                let vv = obj
                    .get_value(cx, key.as_str())
                    .unwrap_or_else(|_| cx.undefined().upcast::<JsValue>());
                let bridged = encode_set_global_value(cx, worker, vv, depth + 1)?;
                out.insert(key, crate::bridge::wire::to_wire_json(&bridged));
            }
            return Ok(JsValueBridge::Json(serde_json::Value::Object(out)));
        }

        return crate::bridge::neon_codec::dehydrate_neon_to_wire(cx, value)
            .map(JsValueBridge::Json);
    }

    crate::bridge::neon_codec::from_neon_value(cx, value)
}

/// Creates a native worker and returns the JavaScript-facing addon API object.
pub fn create_worker(mut cx: FunctionContext) -> JsResult<JsObject> {
    let mut opts = worker::state::WorkerCreateOptions::from_neon(&mut cx, 0)?;
    let inspect_cfg = opts.runtime_options.inspect.clone();

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let channel = cx.channel();

    let (handle, deno_rx, deno_data_rx, node_rx) =
        WorkerHandle::new(id, channel.clone(), opts.channel_size);

    {
        let mut map = WORKERS
            .write()
            .map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;
        map.insert(id, handle.clone());
    }

    // Store the imports callback before startup so module resolution can call
    // back into Node during the worker's first import graph load.
    {
        let raw_opts = cx.argument_opt(0);
        if let Some(raw) = raw_opts {
            if let Ok(obj) = raw.downcast::<JsObject, _>(&mut cx) {
                if let Ok(v) = obj.get_value(&mut cx, "imports") {
                    if let Ok(f) = v.downcast::<JsFunction, _>(&mut cx) {
                        let rooted = f.root(&mut cx);

                        if let Ok(mut map) = WORKERS.write() {
                            if let Some(w) = map.get_mut(&id) {
                                w.callbacks.imports = Some(Arc::new(rooted));
                            }
                        }
                    }
                }
            }
        }
    }

    // Console routing is part of runtime bootstrap state, so build the wire
    // config before the worker thread starts.
    {
        let raw_opts = cx.argument_opt(0);
        if let Some(raw) = raw_opts {
            if let Ok(obj) = raw.downcast::<JsObject, _>(&mut cx) {
                if let Ok(v) = obj.get_value(&mut cx, "console") {
                    opts.runtime_options.console = build_console_config_from_neon(&mut cx, id, v);
                }
            }
        }
    }

    worker::runtime::spawn_worker_thread(id, opts.runtime_options, deno_rx, deno_data_rx, node_rx);

    // When inspect is enabled, wait briefly for the inspector listener to bind so
    // immediate host probes (e.g. /json/version in tests) do not race startup.
    if inspect_cfg.is_some() {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1200);
        loop {
            let bound_port = WORKERS
                .read()
                .ok()
                .and_then(|map| {
                    map.get(&id)
                        .map(|w| w.inspect_bound_port.load(Ordering::SeqCst))
                })
                .unwrap_or(0);
            if bound_port > 0 || std::time::Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    let api = cx.empty_object();

    // postMessage(msg) -> boolean
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let value = cx.argument::<JsValue>(0)?;
            let msg = crate::bridge::neon_codec::from_neon_value(&mut cx, value)?;

            let Some(tx) = data_tx(id2) else {
                if strict_channel() {
                    return cx.throw_error("Runtime is closed (postMessage)");
                }
                return Ok(cx.boolean(false));
            };

            let msg = DenoMsg::PostMessage { value: msg };
            match send_bool_with_optional_blocking(&tx, msg, "Runtime is closed (postMessage)") {
                Ok(sent) => Ok(cx.boolean(sent)),
                Err(message) => cx.throw_error(message),
            }
        })?;
        api.set(&mut cx, "postMessage", f)?;
    }

    // postMessages(msgs) -> number (accepted count)
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let values = cx.argument::<JsValue>(0)?;
            let arr = match values.downcast::<JsArray, _>(&mut cx) {
                Ok(a) => a,
                Err(_) => return Ok(cx.number(0.0)),
            };

            let Some(tx) = data_tx(id2) else {
                if strict_channel() {
                    return cx.throw_error("Runtime is closed (postMessages)");
                }
                return Ok(cx.number(0.0));
            };

            let mut sent: usize = 0;
            let mut all_binary = true;
            for i in 0..arr.len(&mut cx) {
                let v = arr.get_value(&mut cx, i)?;
                if !is_binary_js_value(&mut cx, v) {
                    all_binary = false;
                    break;
                }
            }

            if all_binary {
                for i in 0..arr.len(&mut cx) {
                    let v = arr.get_value(&mut cx, i)?;
                    let Some(payload) = js_value_to_bytes(&mut cx, v) else {
                        continue;
                    };
                    let len = payload.len();
                    let msg = DenoMsg::PostMessage {
                        value: JsValueBridge::BufferView {
                            kind: "Uint8Array".into(),
                            bytes: payload,
                            byte_offset: 0,
                            length: len,
                        },
                    };
                    match send_bool_with_optional_blocking(
                        &tx,
                        msg,
                        "Runtime is closed (postMessages)",
                    ) {
                        Ok(true) => sent += 1,
                        Ok(false) => break,
                        Err(message) => return cx.throw_error(message),
                    }
                }
                return Ok(cx.number(sent as f64));
            }

            for i in 0..arr.len(&mut cx) {
                let v = arr.get_value(&mut cx, i)?;
                let msg = crate::bridge::neon_codec::from_neon_value(&mut cx, v)?;
                let msg = DenoMsg::PostMessage { value: msg };
                match send_bool_with_optional_blocking(&tx, msg, "Runtime is closed (postMessages)")
                {
                    Ok(true) => sent += 1,
                    Ok(false) => break,
                    Err(message) => return cx.throw_error(message),
                }
            }

            Ok(cx.number(sent as f64))
        })?;
        api.set(&mut cx, "postMessages", f)?;
    }

    // postMessageTyped(type, id, payload) -> boolean
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let message_type = cx.argument::<JsString>(0)?.value(&mut cx);
            let id_num = cx.argument::<JsNumber>(1)?.value(&mut cx);
            if !id_num.is_finite() || id_num < 0.0 || id_num > (u32::MAX as f64) {
                return cx.throw_error("postMessageTyped id must be a finite uint32");
            }
            let payload_js = cx.argument::<JsValue>(2)?;
            let payload = crate::bridge::neon_codec::from_neon_value(&mut cx, payload_js)?;

            let Some(tx) = data_tx(id2) else {
                if strict_channel() {
                    return cx.throw_error("Runtime is closed (postMessageTyped)");
                }
                return Ok(cx.boolean(false));
            };

            let msg = DenoMsg::PostMessageTyped {
                message_type,
                id: id_num as u32,
                payload,
            };

            match send_bool_with_optional_blocking(&tx, msg, "Runtime is closed (postMessageTyped)")
            {
                Ok(sent) => Ok(cx.boolean(sent)),
                Err(message) => cx.throw_error(message),
            }
        })?;
        api.set(&mut cx, "postMessageTyped", f)?;
    }

    // postStreamChunk(streamId, payload) -> boolean
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let stream_id = cx.argument::<JsString>(0)?.value(&mut cx);
            if stream_id.trim().is_empty() {
                return cx.throw_error("postStreamChunk streamId must be non-empty");
            }
            let payload_js = cx.argument::<JsValue>(1)?;
            let payload = if let Some(bytes) = js_value_to_bytes(&mut cx, payload_js) {
                crate::bridge::types::JsValueBridge::BufferView {
                    kind: "Uint8Array".to_string(),
                    byte_offset: 0,
                    length: bytes.len(),
                    bytes,
                }
            } else {
                crate::bridge::neon_codec::from_neon_value(&mut cx, payload_js)?
            };

            let Some(tx) = data_tx(id2) else {
                if strict_channel() {
                    return cx.throw_error("Runtime is closed (postStreamChunk)");
                }
                return Ok(cx.boolean(false));
            };

            let msg = DenoMsg::PostStreamChunk { stream_id, payload };

            match send_with_backpressure(&tx, msg) {
                SendOutcome::Sent => Ok(cx.boolean(true)),
                SendOutcome::Full => {
                    if strict_channel() {
                        cx.throw_error("Runtime channel saturated (postStreamChunk)")
                    } else {
                        Ok(cx.boolean(false))
                    }
                }
                SendOutcome::Closed => {
                    if strict_channel() {
                        cx.throw_error("Runtime is closed (postStreamChunk)")
                    } else {
                        Ok(cx.boolean(false))
                    }
                }
            }
        })?;
        api.set(&mut cx, "postStreamChunk", f)?;
    }

    // postStreamChunkRaw(streamId, payload, credit?) -> boolean
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let stream_id_num = cx.argument::<JsNumber>(0)?.value(&mut cx);
            if !stream_id_num.is_finite()
                || stream_id_num < 1.0
                || stream_id_num > (u32::MAX as f64)
            {
                return cx.throw_error("postStreamChunkRaw streamId must be a finite uint32");
            }
            let payload_js = cx.argument::<JsValue>(1)?;
            let payload = crate::bridge::neon_codec::from_neon_value(&mut cx, payload_js)?;
            let credit = if cx.len() >= 3 {
                let c = cx.argument::<JsValue>(2)?;
                if c.is_a::<JsUndefined, _>(&mut cx) || c.is_a::<JsNull, _>(&mut cx) {
                    None
                } else if let Ok(n) = c.downcast::<JsNumber, _>(&mut cx) {
                    let raw = n.value(&mut cx);
                    if raw.is_finite() && raw >= 0.0 && raw <= (u32::MAX as f64) {
                        Some(raw as u32)
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            };

            let Some(tx) = data_tx(id2) else {
                if strict_channel() {
                    return cx.throw_error("Runtime is closed (postStreamChunkRaw)");
                }
                return Ok(cx.boolean(false));
            };

            let msg = DenoMsg::PostStreamChunkRaw {
                stream_id: stream_id_num as u32,
                payload,
                credit,
            };

            match send_with_backpressure(&tx, msg) {
                SendOutcome::Sent => Ok(cx.boolean(true)),
                SendOutcome::Full => {
                    if strict_channel() {
                        cx.throw_error("Runtime channel saturated (postStreamChunkRaw)")
                    } else {
                        Ok(cx.boolean(false))
                    }
                }
                SendOutcome::Closed => {
                    if strict_channel() {
                        cx.throw_error("Runtime is closed (postStreamChunkRaw)")
                    } else {
                        Ok(cx.boolean(false))
                    }
                }
            }
        })?;
        api.set(&mut cx, "postStreamChunkRaw", f)?;
    }

    // postStreamChunkRawBin(streamId, payload, credit?) -> boolean
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let stream_id_num = cx.argument::<JsNumber>(0)?.value(&mut cx);
            if !stream_id_num.is_finite()
                || stream_id_num < 1.0
                || stream_id_num > (u32::MAX as f64)
            {
                return cx.throw_error("postStreamChunkRawBin streamId must be a finite uint32");
            }
            let payload_js = cx.argument::<JsValue>(1)?;
            let payload = if let Some(bytes) = js_value_to_bytes(&mut cx, payload_js) {
                bytes
            } else {
                return cx.throw_error(
                    "postStreamChunkRawBin payload must be Buffer/Uint8Array/ArrayBuffer",
                );
            };
            let credit = if cx.len() >= 3 {
                let c = cx.argument::<JsValue>(2)?;
                if c.is_a::<JsUndefined, _>(&mut cx) || c.is_a::<JsNull, _>(&mut cx) {
                    None
                } else if let Ok(n) = c.downcast::<JsNumber, _>(&mut cx) {
                    let raw = n.value(&mut cx);
                    if raw.is_finite() && raw >= 0.0 && raw <= (u32::MAX as f64) {
                        Some(raw as u32)
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            };

            let Some(tx) = data_tx(id2) else {
                if strict_channel() {
                    return cx.throw_error("Runtime is closed (postStreamChunkRawBin)");
                }
                return Ok(cx.boolean(false));
            };

            let msg = DenoMsg::PostStreamChunkRawBin {
                stream_id: stream_id_num as u32,
                payload,
                credit,
            };

            match send_with_backpressure(&tx, msg) {
                SendOutcome::Sent => Ok(cx.boolean(true)),
                SendOutcome::Full => {
                    if strict_channel() {
                        cx.throw_error("Runtime channel saturated (postStreamChunkRawBin)")
                    } else {
                        Ok(cx.boolean(false))
                    }
                }
                SendOutcome::Closed => {
                    if strict_channel() {
                        cx.throw_error("Runtime is closed (postStreamChunkRawBin)")
                    } else {
                        Ok(cx.boolean(false))
                    }
                }
            }
        })?;
        api.set(&mut cx, "postStreamChunkRawBin", f)?;
    }

    // postStreamChunks(streamId, payloads) -> number
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let stream_id = cx.argument::<JsString>(0)?.value(&mut cx);
            if stream_id.trim().is_empty() {
                return cx.throw_error("postStreamChunks streamId must be non-empty");
            }
            let values = cx.argument::<JsValue>(1)?;
            let arr = match values.downcast::<JsArray, _>(&mut cx) {
                Ok(a) => a,
                Err(_) => return Ok(cx.number(0.0)),
            };

            let Some(tx) = data_tx(id2) else {
                if strict_channel() {
                    return cx.throw_error("Runtime is closed (postStreamChunks)");
                }
                return Ok(cx.number(0.0));
            };

            let mut payloads: Vec<crate::bridge::types::JsValueBridge> =
                Vec::with_capacity(arr.len(&mut cx) as usize);
            for i in 0..arr.len(&mut cx) {
                let v = arr.get_value(&mut cx, i)?;
                let msg = crate::bridge::neon_codec::from_neon_value(&mut cx, v)?;
                payloads.push(msg);
            }
            let count = payloads.len();

            let msg = DenoMsg::PostStreamChunks {
                stream_id,
                payloads,
            };
            match send_with_backpressure(&tx, msg) {
                SendOutcome::Sent => Ok(cx.number(count as f64)),
                SendOutcome::Full => {
                    if strict_channel() {
                        cx.throw_error("Runtime channel saturated (postStreamChunks)")
                    } else {
                        Ok(cx.number(0.0))
                    }
                }
                SendOutcome::Closed => {
                    if strict_channel() {
                        cx.throw_error("Runtime is closed (postStreamChunks)")
                    } else {
                        Ok(cx.number(0.0))
                    }
                }
            }
        })?;
        api.set(&mut cx, "postStreamChunks", f)?;
    }

    // postStreamChunksRaw(streamId, payload) -> boolean
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let stream_id_num = cx.argument::<JsNumber>(0)?.value(&mut cx);
            if !stream_id_num.is_finite()
                || stream_id_num < 1.0
                || stream_id_num > (u32::MAX as f64)
            {
                return cx.throw_error("postStreamChunksRaw streamId must be a finite uint32");
            }
            let payload_js = cx.argument::<JsValue>(1)?;
            let payload = crate::bridge::neon_codec::from_neon_value(&mut cx, payload_js)?;

            let Some(tx) = data_tx(id2) else {
                if strict_channel() {
                    return cx.throw_error("Runtime is closed (postStreamChunksRaw)");
                }
                return Ok(cx.boolean(false));
            };

            let msg = DenoMsg::PostStreamChunksRaw {
                stream_id: stream_id_num as u32,
                payload,
            };
            match send_with_backpressure(&tx, msg) {
                SendOutcome::Sent => Ok(cx.boolean(true)),
                SendOutcome::Full => {
                    if strict_channel() {
                        cx.throw_error("Runtime channel saturated (postStreamChunksRaw)")
                    } else {
                        Ok(cx.boolean(false))
                    }
                }
                SendOutcome::Closed => {
                    if strict_channel() {
                        cx.throw_error("Runtime is closed (postStreamChunksRaw)")
                    } else {
                        Ok(cx.boolean(false))
                    }
                }
            }
        })?;
        api.set(&mut cx, "postStreamChunksRaw", f)?;
    }

    // postStreamControl(kind, streamId, aux?) -> boolean
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let kind = cx.argument::<JsString>(0)?.value(&mut cx);
            if kind.trim().is_empty() {
                return cx.throw_error("postStreamControl kind must be non-empty");
            }
            let stream_id = cx.argument::<JsString>(1)?.value(&mut cx);
            if stream_id.trim().is_empty() {
                return cx.throw_error("postStreamControl streamId must be non-empty");
            }
            let aux = if cx.len() >= 3 {
                let aux_js = cx.argument::<JsValue>(2)?;
                if aux_js.is_a::<JsUndefined, _>(&mut cx) || aux_js.is_a::<JsNull, _>(&mut cx) {
                    None
                } else {
                    Some(aux_js.to_string(&mut cx)?.value(&mut cx))
                }
            } else {
                None
            };

            let Some(tx) = data_tx(id2) else {
                if strict_channel() {
                    return cx.throw_error("Runtime is closed (postStreamControl)");
                }
                return Ok(cx.boolean(false));
            };

            let msg = DenoMsg::PostStreamControl {
                kind,
                stream_id,
                aux,
            };

            match send_with_backpressure(&tx, msg) {
                SendOutcome::Sent => Ok(cx.boolean(true)),
                SendOutcome::Full => {
                    if strict_channel() {
                        cx.throw_error("Runtime channel saturated (postStreamControl)")
                    } else {
                        Ok(cx.boolean(false))
                    }
                }
                SendOutcome::Closed => {
                    if strict_channel() {
                        cx.throw_error("Runtime is closed (postStreamControl)")
                    } else {
                        Ok(cx.boolean(false))
                    }
                }
            }
        })?;
        api.set(&mut cx, "postStreamControl", f)?;
    }

    // on(event, cb)
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let event = cx.argument::<JsString>(0)?.value(&mut cx);
            let cb = cx.argument::<JsFunction>(1)?.root(&mut cx);

            let mut map = WORKERS
                .write()
                .map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;
            let worker = map
                .get_mut(&id2)
                .ok_or_else(|| cx.throw_error::<_, ()>("Runtime is closed").unwrap_err())?;

            match event.as_str() {
                "message" => worker.callbacks.on_message = Some(Arc::new(cb)),
                "close" => worker.callbacks.on_close = Some(Arc::new(cb)),
                "runtime" => worker.callbacks.on_runtime = Some(Arc::new(cb)),
                _ => {}
            }

            Ok(cx.undefined())
        })?;
        api.set(&mut cx, "on", f)?;
    }

    // isClosed()
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let closed = {
                let map = WORKERS
                    .read()
                    .map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;
                map.get(&id2)
                    .map(|w| w.closed.load(Ordering::SeqCst))
                    .unwrap_or(true)
            };
            Ok(cx.boolean(closed))
        })?;
        api.set(&mut cx, "isClosed", f)?;
    }

    // close(): Promise<void>
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let (deferred, promise) = cx.promise();
            let settler = PromiseSettler::new(deferred, cx.channel());
            queue_deno_msg_or_reject(id2, settler, |deferred| DenoMsg::Close { deferred });

            Ok(promise)
        })?;
        api.set(&mut cx, "close", f)?;
    }

    // forceDispose(): void (best-effort immediate native handle teardown)
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            if let Ok(mut map) = WORKERS.write() {
                if let Some(w) = map.get(&id2) {
                    w.closed.store(true, Ordering::SeqCst);
                }
                let _ = map.remove(&id2);
            }
            Ok(cx.undefined())
        })?;
        api.set(&mut cx, "forceDispose", f)?;
    }

    // __isRegistered(): boolean (internal test/teardown helper)
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let registered = WORKERS
                .read()
                .ok()
                .map(|map| map.contains_key(&id2))
                .unwrap_or(false);
            Ok(cx.boolean(registered))
        })?;
        api.set(&mut cx, "__isRegistered", f)?;
    }

    // memory(): Promise<any>
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let (deferred, promise) = cx.promise();
            let settler = PromiseSettler::new(deferred, cx.channel());
            queue_deno_msg_or_reject(id2, settler, |deferred| DenoMsg::Memory { deferred });

            Ok(promise)
        })?;
        api.set(&mut cx, "memory", f)?;
    }

    // gc(): Promise<void>
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let (deferred, promise) = cx.promise();
            let settler = PromiseSettler::new(deferred, cx.channel());
            queue_deno_msg_or_reject(id2, settler, |deferred| DenoMsg::Gc { deferred });

            Ok(promise)
        })?;
        api.set(&mut cx, "gc", f)?;
    }

    // setGlobal(key, value): Promise<void>
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let key = cx.argument::<JsString>(0)?.value(&mut cx);
            let js = cx.argument::<JsValue>(1)?;

            let (deferred, promise) = cx.promise();
            let settler = PromiseSettler::new(deferred, cx.channel());

            let tx_and_value = {
                let mut map = WORKERS
                    .write()
                    .map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;
                let worker = map
                    .get_mut(&id2)
                    .ok_or_else(|| cx.throw_error::<_, ()>("Runtime is closed").unwrap_err())?;

                let value = encode_set_global_value(&mut cx, worker, js, 0)?;

                Some((worker.deno_tx.clone(), value))
            };

            if let Some((tx, value)) = tx_and_value {
                crate::queue_deno_msg_or_reject_with_backpressure(
                    tx,
                    DenoMsg::SetGlobal {
                        key,
                        value,
                        deferred: settler,
                    },
                );
            } else {
                settler.reject_with_value_via_channel(mk_err("Runtime is closed"));
            }

            Ok(promise)
        })?;
        api.set(&mut cx, "setGlobal", f)?;
    }

    // eval(src, options?): Promise<any>
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let src = cx.argument::<JsString>(0)?.value(&mut cx);
            let options = parse_eval_options(&mut cx, 1);

            let (deferred, promise) = cx.promise();
            let mut settler = PromiseSettler::new(deferred, cx.channel());
            if let Ok(date_ctor) = cx.global::<JsFunction>("Date") {
                settler = settler.with_date_ctor(date_ctor.root(&mut cx));
            }

            queue_deno_msg_or_reject(id2, settler, |deferred| DenoMsg::Eval {
                source: src,
                options,
                deferred: Some(deferred),
                sync_reply: None,
            });

            Ok(promise)
        })?;
        api.set(&mut cx, "eval", f)?;
    }

    // evalSync(src, options?): any
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            struct EvalSyncGuard(std::sync::Arc<std::sync::atomic::AtomicBool>);
            impl Drop for EvalSyncGuard {
                // Releases scoped guard resources and restores associated runtime state on scope exit.
                fn drop(&mut self) {
                    self.0.store(false, std::sync::atomic::Ordering::SeqCst);
                }
            }

            let src = cx.argument::<JsString>(0)?.value(&mut cx);
            let options = parse_eval_options(&mut cx, 1);

            let eval_sync_active = {
                let map = WORKERS
                    .read()
                    .map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;
                map.get(&id2)
                    .map(|w| w.eval_sync_active.clone())
                    .ok_or_else(|| cx.throw_error::<_, ()>("Runtime is closed").unwrap_err())?
            };
            eval_sync_active.store(true, std::sync::atomic::Ordering::SeqCst);
            let _guard = EvalSyncGuard(eval_sync_active);

            let tx = deno_control_tx_for_worker(id2)
                .ok_or_else(|| cx.throw_error::<_, ()>("Runtime is closed").unwrap_err())?;

            let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
            tx.blocking_send(DenoMsg::Eval {
                source: src,
                options,
                deferred: None,
                sync_reply: Some(reply_tx),
            })
            .map_err(|_e| cx.throw_error::<_, ()>("Runtime is closed").unwrap_err())?;

            let result = reply_rx
                .blocking_recv()
                .map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;

            {
                if let Ok(mut map) = WORKERS.write() {
                    if let Some(w) = map.get_mut(&id2) {
                        let stats = match &result {
                            EvalReply::Ok { stats, .. } => stats.clone(),
                            EvalReply::Err { stats, .. } => stats.clone(),
                        };
                        if let Ok(mut g) = w.last_stats.lock() {
                            *g = Some(stats);
                        }
                    }
                }
            }

            crate::bridge::neon_codec::eval_result_to_neon(&mut cx, result)
        })?;
        api.set(&mut cx, "evalSync", f)?;
    }

    // evalModule(src, options?): Promise<any>
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let src = cx.argument::<JsString>(0)?.value(&mut cx);

            let mut options = parse_eval_options(&mut cx, 1);
            options.is_module = true;

            let (deferred, promise) = cx.promise();
            let settler = PromiseSettler::new(deferred, cx.channel());

            queue_deno_msg_or_reject(id2, settler, |deferred| DenoMsg::Eval {
                source: src,
                options,
                deferred: Some(deferred),
                sync_reply: None,
            });

            Ok(promise)
        })?;
        api.set(&mut cx, "evalModule", f)?;
    }

    // buildModuleEvalCjsSource(source): string
    {
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let source = cx.argument::<JsString>(0)?.value(&mut cx);
            let transformed =
                crate::worker::modules::DynamicModuleLoader::build_module_eval_cjs_source(&source)
                    .ok_or_else(|| {
                        cx.throw_error::<_, ()>("Failed to build module.eval CommonJS facade")
                            .unwrap_err()
                    })?;
            Ok(cx.string(transformed))
        })?;
        api.set(&mut cx, "buildModuleEvalCjsSource", f)?;
    }

    // registerModule(moduleName, source): Promise<void>
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let module_name = cx.argument::<JsString>(0)?.value(&mut cx);
            let source = cx.argument::<JsString>(1)?.value(&mut cx);
            let mut loader = "js".to_string();
            if let Some(raw) = cx.argument_opt(2) {
                if let Ok(opts) = raw.downcast::<JsObject, _>(&mut cx) {
                    let source_loader_value = opts
                        .get::<JsValue, _, _>(&mut cx, "srcLoader")
                        .or_else(|_| opts.get::<JsValue, _, _>(&mut cx, "loader"));
                    if let Ok(v) = source_loader_value {
                        if let Ok(s) = v.downcast::<JsString, _>(&mut cx) {
                            let parsed = s.value(&mut cx);
                            if matches!(parsed.as_str(), "js" | "ts" | "tsx" | "jsx") {
                                loader = parsed;
                            }
                        }
                    }
                }
            }
            let (deferred, promise) = cx.promise();
            let settler = PromiseSettler::new(deferred, cx.channel());
            queue_deno_msg_or_reject(id2, settler, |deferred| DenoMsg::RegisterModule {
                module_name,
                source,
                loader,
                deferred,
            });
            Ok(promise)
        })?;
        api.set(&mut cx, "registerModule", f)?;
    }

    // clearModule(moduleName): Promise<boolean>
    {
        let id2 = id;
        let f = JsFunction::new(&mut cx, move |mut cx| {
            let module_name = cx.argument::<JsString>(0)?.value(&mut cx);
            let (deferred, promise) = cx.promise();
            let settler = PromiseSettler::new(deferred, cx.channel());
            queue_deno_msg_or_reject(id2, settler, |deferred| DenoMsg::ClearModule {
                module_name,
                deferred,
            });
            Ok(promise)
        })?;
        api.set(&mut cx, "clearModule", f)?;
    }

    // lastExecutionStats getter
    {
        let id2 = id;

        let getter = JsFunction::new(&mut cx, move |mut cx| -> JsResult<JsValue> {
            let stats_opt = {
                let map = WORKERS
                    .read()
                    .map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;

                map.get(&id2)
                    .and_then(|w| w.last_stats.lock().ok().and_then(|g| (*g).clone()))
            };

            match stats_opt {
                Some(st) => {
                    let obj = cx.empty_object();
                    let cpu_time = cx.number(st.cpu_time_ms);
                    let eval_time = cx.number(st.eval_time_ms);
                    obj.set(&mut cx, "cpuTimeMs", cpu_time)?;
                    obj.set(&mut cx, "evalTimeMs", eval_time)?;
                    Ok(obj.upcast())
                }
                None => Ok(cx.empty_object().upcast()),
            }
        })?;

        let object_ctor: Option<Handle<JsFunction>> = cx.global("Object").ok();
        if let Some(object_ctor) = object_ctor {
            let object_obj: Handle<JsObject> = object_ctor.upcast();

            let define_prop: Option<Handle<JsFunction>> =
                object_obj.get(&mut cx, "defineProperty").ok();

            if let Some(define_prop) = define_prop {
                let desc = cx.empty_object();
                let bool_true = cx.boolean(true);
                desc.set(&mut cx, "get", getter)?;
                desc.set(&mut cx, "enumerable", bool_true)?;
                desc.set(&mut cx, "configurable", bool_true)?;

                let prop_name = cx.string("lastExecutionStats");
                let _ = define_prop.call(
                    &mut cx,
                    object_obj,
                    &[api.upcast(), prop_name.upcast(), desc.upcast()],
                );
            }
        }
    };

    // inspectPort getter (actual bound inspector port; supports inspect.port = 0)
    {
        let id2 = id;

        let getter = JsFunction::new(&mut cx, move |mut cx| -> JsResult<JsValue> {
            let port_opt = {
                let map = WORKERS
                    .read()
                    .map_err(|e| cx.throw_error::<_, ()>(e.to_string()).unwrap_err())?;
                map.get(&id2)
                    .map(|w| w.inspect_bound_port.load(Ordering::SeqCst))
            };

            match port_opt {
                Some(port) if port > 0 => Ok(cx.number(port as f64).upcast()),
                _ => Ok(cx.undefined().upcast()),
            }
        })?;

        let object_ctor: Option<Handle<JsFunction>> = cx.global("Object").ok();
        if let Some(object_ctor) = object_ctor {
            let object_obj: Handle<JsObject> = object_ctor.upcast();
            let define_prop: Option<Handle<JsFunction>> =
                object_obj.get(&mut cx, "defineProperty").ok();

            if let Some(define_prop) = define_prop {
                let desc = cx.empty_object();
                let bool_true = cx.boolean(true);
                desc.set(&mut cx, "get", getter)?;
                desc.set(&mut cx, "enumerable", bool_true)?;
                desc.set(&mut cx, "configurable", bool_true)?;

                let prop_name = cx.string("inspectPort");
                let _ = define_prop.call(
                    &mut cx,
                    object_obj,
                    &[api.upcast(), prop_name.upcast(), desc.upcast()],
                );
            }
        }
    }

    Ok(api)
}
