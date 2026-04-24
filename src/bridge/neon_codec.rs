// src/bridge/neon_codec.rs
use base64::Engine;
use bytes::Bytes;
use neon::prelude::*;
use neon::result::Throw;
use neon::types::JsDate;
use std::cell::RefCell;

use super::types::JsValueBridge;
use crate::bridge::tags::{
    BIGINT_KEY, BUFFER_KEY, DATE_KEY, MAP_KEY, NUMBER_KEY, NUMBER_NEG_ZERO_KEY, REGEXP_KEY,
    SET_KEY, TYPE_ERROR, TYPE_KEY, UNDEFINED_KEY, URL_KEY, URL_SEARCH_PARAMS_KEY,
};
use crate::worker::messages::EvalReply;
use neon::types::buffer::TypedArray;

const GRAPH_ID_KEY: &str = "__denojs_worker_graph_id";
const GRAPH_REF_KEY: &str = "__denojs_worker_graph_ref";
const GRAPH_KIND_KEY: &str = "__denojs_worker_graph_kind";
const GRAPH_VALUE_KEY: &str = "__denojs_worker_graph_value";
const GRAPH_KIND_ARRAY: &str = "array";
const GRAPH_KIND_OBJECT: &str = "object";

thread_local! {
    static BYTE_VEC_POOL: RefCell<Vec<Vec<u8>>> = const { RefCell::new(Vec::new()) };
}

// Reuses short-lived byte buffers created while decoding JSON wire payloads.
fn rent_byte_vec(min_capacity: usize) -> Vec<u8> {
    BYTE_VEC_POOL.with(|pool| {
        let mut pool = pool.borrow_mut();
        if let Some(i) = pool.iter().position(|v| v.capacity() >= min_capacity) {
            let mut out = pool.swap_remove(i);
            out.clear();
            out
        } else {
            Vec::with_capacity(min_capacity)
        }
    })
}

// Returns a rented byte buffer unless it grew too large to keep around.
fn give_back_byte_vec(mut v: Vec<u8>) {
    // Keep pooled buffers bounded; 1 MiB covers common transfer chunks.
    if v.capacity() > 1024 * 1024 {
        return;
    }
    v.clear();
    BYTE_VEC_POOL.with(|pool| {
        let mut pool = pool.borrow_mut();
        if pool.len() < 16 {
            pool.push(v);
        }
    });
}

// Reads an own/inherited string property without requiring callers to handle JS exceptions.
fn get_string_prop<'a, C: Context<'a>>(
    cx: &mut C,
    obj: Handle<'a, JsObject>,
    key: &str,
) -> Option<String> {
    let v = obj.get_value(cx, key).ok()?;
    let s = v.downcast::<JsString, _>(cx).ok()?;
    Some(s.value(cx))
}

// Gets Object.prototype.toString.call(value), which is more robust across JS realms.
fn object_to_string_tag<'a, C: Context<'a>>(cx: &mut C, v: Handle<'a, JsValue>) -> Option<String> {
    let out: Handle<JsString> = cx
        .try_catch(|cx| {
            let object_ctor = cx.global::<JsFunction>("Object")?;
            let proto_any = object_ctor.get_value(cx, "prototype")?;

            let Ok(proto) = proto_any.downcast::<JsObject, _>(cx) else {
                return Ok(cx.string(""));
            };

            let to_string_any = proto.get_value(cx, "toString")?;
            let Ok(to_string_fn) = to_string_any.downcast::<JsFunction, _>(cx) else {
                return Ok(cx.string(""));
            };

            // Correct: Object.prototype.toString called with `this = v`
            let s = to_string_fn
                .call_with(cx)
                .this(v)
                .apply::<JsString, _>(cx)?;

            Ok(s)
        })
        .ok()?;

    Some(out.value(cx))
}

fn is_node_buffer<'a, C: Context<'a>>(cx: &mut C, value: Handle<'a, JsValue>) -> bool {
    let Ok(buf_ctor) = cx.global::<JsFunction>("Buffer") else {
        return false;
    };

    cx.try_catch(|cx| {
        let fn_any = buf_ctor.get_value(cx, "isBuffer")?;
        let fn_is_buffer = fn_any.downcast::<JsFunction, _>(cx).unwrap();
        fn_is_buffer
            .call_with(cx)
            .this(buf_ctor)
            .arg(value)
            .apply::<JsBoolean, _>(cx)
    })
    .ok()
    .map(|b| b.value(cx))
    .unwrap_or(false)
}

// Returns own enumerable string keys using JavaScript Object.keys semantics.
fn own_enumerable_string_keys<'a, C: Context<'a>>(
    cx: &mut C,
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

/// Constructs `ctor(...args)` through `Reflect.construct`.
pub(crate) fn reflect_construct<'a, C: Context<'a>>(
    cx: &mut C,
    ctor: Handle<'a, JsFunction>,
    args: &[Handle<'a, JsValue>],
) -> Result<Handle<'a, JsValue>, Throw> {
    let reflect = cx.global::<JsObject>("Reflect")?;
    let construct = reflect.get::<JsFunction, _, _>(cx, "construct")?;

    let arr = JsArray::new(cx, args.len());
    for (i, a) in args.iter().enumerate() {
        let _ = arr.set(cx, i as u32, *a);
    }

    construct
        .call_with(cx)
        .this(reflect)
        .arg(ctor)
        .arg(arr)
        .apply::<JsValue, _>(cx)
}

/// Detect RegExp without relying on Neon JsRegExp or JsObject::is_instance_of (not available in neon 1.1.x).
/// Primary: Object.prototype.toString.call(v) === "[object RegExp]"
/// Fallback: duck typing { source: string, flags: string, exec: function }
fn is_regexp_like<'a, C: Context<'a>>(cx: &mut C, v: Handle<'a, JsValue>) -> bool {
    let tag_match = object_to_string_tag(cx, v)
        .map(|s| s == "[object RegExp]")
        .unwrap_or(false);

    if tag_match {
        return true;
    }

    let Ok(obj) = v.downcast::<JsObject, _>(cx) else {
        return false;
    };

    let has_source = obj
        .get_value(cx, "source")
        .map(|x| x.is_a::<JsString, _>(cx))
        .unwrap_or(false);

    let has_flags = obj
        .get_value(cx, "flags")
        .map(|x| x.is_a::<JsString, _>(cx))
        .unwrap_or(false);

    let has_exec = obj
        .get_value(cx, "exec")
        .map(|x| x.is_a::<JsFunction, _>(cx))
        .unwrap_or(false);

    has_source && has_flags && has_exec
}

// JSON.stringify with a replacer that preserves supported non-JSON bridge types.
fn try_json_stringify_with_replacer<'a, C: Context<'a>>(
    cx: &mut C,
    value: Handle<'a, JsValue>,
) -> Option<serde_json::Value> {
    let s: Handle<JsString> = cx
        .try_catch(|cx| {
            let json = cx.global::<JsObject>("JSON")?;
            let stringify = json.get::<JsFunction, _, _>(cx, "stringify")?;

            // Replacer encodes non-JSON types into tagged objects compatible with wire hydration.
            let replacer = JsFunction::new(cx, |mut cx| {
                let v = cx.argument::<JsValue>(1)?;

                // Preserve -0
                if let Ok(n) = v.downcast::<JsNumber, _>(&mut cx) {
                    let f = n.value(&mut cx);
                    if f == 0.0 && f.is_sign_negative() {
                        let marker = cx.empty_object();
                        let val = cx.string("-0");
                        marker.set(&mut cx, NUMBER_NEG_ZERO_KEY, val)?;
                        return Ok(marker.upcast());
                    }
                }

                // BigInt
                if v.is_a::<neon::types::JsBigInt, _>(&mut cx) {
                    // BigInt ToString is safe (no trailing 'n')
                    let out_s = v
                        .to_string(&mut cx)
                        .map(|s| s.value(&mut cx))
                        .unwrap_or_else(|_| "0".to_string());

                    let marker = cx.empty_object();
                    let out_v = cx.string(out_s);
                    marker.set(&mut cx, BIGINT_KEY, out_v)?;
                    return Ok(marker.upcast());
                }

                // Date
                if let Ok(d) = v.downcast::<JsDate, _>(&mut cx) {
                    let ms = d.value(&mut cx);
                    let marker = cx.empty_object();
                    let ms_v = cx.number(ms);
                    marker.set(&mut cx, DATE_KEY, ms_v)?;
                    return Ok(marker.upcast());
                }

                // Error (best-effort, includes cause if it is JSON-safe)
                if v.is_a::<neon::types::JsError, _>(&mut cx) {
                    let obj = v
                        .downcast::<JsObject, _>(&mut cx)
                        .unwrap_or_else(|_| cx.empty_object());

                    let name =
                        get_string_prop(&mut cx, obj, "name").unwrap_or_else(|| "Error".into());
                    let message = get_string_prop(&mut cx, obj, "message").unwrap_or_default();
                    let stack = get_string_prop(&mut cx, obj, "stack");
                    let code = get_string_prop(&mut cx, obj, "code");

                    let marker = cx.empty_object();

                    let t_v = cx.string(TYPE_ERROR);
                    marker.set(&mut cx, TYPE_KEY, t_v)?;

                    let name_v = cx.string(name);
                    marker.set(&mut cx, "name", name_v)?;

                    let msg_v = cx.string(message);
                    marker.set(&mut cx, "message", msg_v)?;

                    if let Some(stack) = stack {
                        let stack_v = cx.string(stack);
                        marker.set(&mut cx, "stack", stack_v)?;
                    }

                    if let Some(code) = code {
                        let code_v = cx.string(code);
                        marker.set(&mut cx, "code", code_v)?;
                    }

                    if let Ok(cause_any) = obj.get_value(&mut cx, "cause") {
                        if !cause_any.is_a::<JsUndefined, _>(&mut cx)
                            && !cause_any.is_a::<JsNull, _>(&mut cx)
                        {
                            marker.set(&mut cx, "cause", cause_any)?;
                        }
                    }

                    return Ok(marker.upcast());
                }

                // RegExp
                if is_regexp_like(&mut cx, v) {
                    let obj = v
                        .downcast::<JsObject, _>(&mut cx)
                        .unwrap_or_else(|_| cx.empty_object());

                    let source = get_string_prop(&mut cx, obj, "source").unwrap_or_default();
                    let flags = get_string_prop(&mut cx, obj, "flags").unwrap_or_default();

                    let inner = cx.empty_object();
                    let src_v = cx.string(source);
                    inner.set(&mut cx, "source", src_v)?;
                    let flags_v = cx.string(flags);
                    inner.set(&mut cx, "flags", flags_v)?;

                    let marker = cx.empty_object();
                    marker.set(&mut cx, REGEXP_KEY, inner)?;
                    return Ok(marker.upcast());
                }

                // URL / URLSearchParams
                if let Ok(obj) = v.downcast::<JsObject, _>(&mut cx) {
                    if let Some(href) = get_string_prop(&mut cx, obj, "href") {
                        let marker = cx.empty_object();
                        let href_v = cx.string(href);
                        marker.set(&mut cx, URL_KEY, href_v)?;
                        return Ok(marker.upcast());
                    }

                    let to_string_is_fn = obj
                        .get_value(&mut cx, "toString")
                        .map(|x| x.is_a::<JsFunction, _>(&mut cx))
                        .unwrap_or(false);

                    if to_string_is_fn {
                        let has_append = obj
                            .get_value(&mut cx, "append")
                            .map(|x| x.is_a::<JsFunction, _>(&mut cx))
                            .unwrap_or(false);
                        let has_get = obj
                            .get_value(&mut cx, "get")
                            .map(|x| x.is_a::<JsFunction, _>(&mut cx))
                            .unwrap_or(false);

                        if has_append && has_get {
                            if let Ok(ts_any) = obj.get_value(&mut cx, "toString") {
                                if let Ok(ts_fn) = ts_any.downcast::<JsFunction, _>(&mut cx) {
                                    let out_any = ts_fn
                                        .call_with(&mut cx)
                                        .this(obj)
                                        .apply::<JsValue, _>(&mut cx)
                                        .unwrap_or_else(|_| cx.string("").upcast());

                                    let out_s = out_any
                                        .downcast::<JsString, _>(&mut cx)
                                        .map(|s| s.value(&mut cx))
                                        .unwrap_or_else(|_| "".to_string());

                                    let marker = cx.empty_object();
                                    let out_v = cx.string(out_s);
                                    marker.set(&mut cx, URL_SEARCH_PARAMS_KEY, out_v)?;
                                    return Ok(marker.upcast());
                                }
                            }
                        }
                    }
                }

                // Nested ArrayBuffer/view values need raw view bytes, not
                // typed-array element values. Buffer.from(view) would truncate
                // Int16Array/Float64Array/etc.; pass the backing buffer window.
                if let Ok(ab_ctor) = cx.global::<JsFunction>("ArrayBuffer") {
                    let is_view = cx
                        .try_catch(|cx| {
                            let fn_any = ab_ctor.get_value(cx, "isView")?;
                            let fn_is_view = fn_any.downcast::<JsFunction, _>(cx).unwrap();
                            let out = fn_is_view
                                .call_with(cx)
                                .this(ab_ctor)
                                .arg(v)
                                .apply::<JsValue, _>(cx)?;
                            Ok(out)
                        })
                        .ok()
                        .and_then(|x| x.downcast::<JsBoolean, _>(&mut cx).ok())
                        .map(|b| b.value(&mut cx))
                        .unwrap_or(false);

                    let is_array_buffer = object_to_string_tag(&mut cx, v)
                        .map(|s| s == "[object ArrayBuffer]")
                        .unwrap_or(false);
                    let is_shared_array_buffer = object_to_string_tag(&mut cx, v)
                        .map(|s| s == "[object SharedArrayBuffer]")
                        .unwrap_or(false);

                    if is_view || is_array_buffer || is_shared_array_buffer {
                        if let Ok(buf_ctor) = cx.global::<JsFunction>("Buffer") {
                            if let Ok(from_any) = buf_ctor.get_value(&mut cx, "from") {
                                if let Ok(from_fn) = from_any.downcast::<JsFunction, _>(&mut cx) {
                                    let out_any = if is_view {
                                        if let Ok(obj) = v.downcast::<JsObject, _>(&mut cx) {
                                            let buf_any = obj
                                                .get_value(&mut cx, "buffer")
                                                .unwrap_or_else(|_| cx.undefined().upcast());
                                            let bo_any = obj
                                                .get_value(&mut cx, "byteOffset")
                                                .unwrap_or_else(|_| cx.number(0.0).upcast());
                                            let bl_any = obj
                                                .get_value(&mut cx, "byteLength")
                                                .unwrap_or_else(|_| cx.number(0.0).upcast());

                                            from_fn
                                                .call_with(&mut cx)
                                                .this(buf_ctor)
                                                .arg(buf_any)
                                                .arg(bo_any)
                                                .arg(bl_any)
                                                .apply::<JsValue, _>(&mut cx)
                                                .unwrap_or_else(|_| cx.undefined().upcast())
                                        } else {
                                            cx.undefined().upcast()
                                        }
                                    } else {
                                        from_fn
                                            .call_with(&mut cx)
                                            .this(buf_ctor)
                                            .arg(v)
                                            .apply::<JsValue, _>(&mut cx)
                                            .unwrap_or_else(|_| cx.undefined().upcast())
                                    };

                                    if let Ok(out_buf) = out_any.downcast::<JsBuffer, _>(&mut cx) {
                                        let bytes = out_buf.as_slice(&mut cx).to_vec();

                                        let bytes_arr = JsArray::new(&mut cx, bytes.len());
                                        for (i, b) in bytes.iter().enumerate() {
                                            let n = cx.number(*b as f64);
                                            let _ = bytes_arr.set(&mut cx, i as u32, n);
                                        }

                                        let kind = if is_array_buffer {
                                            "ArrayBuffer".to_string()
                                        } else if is_shared_array_buffer {
                                            "SharedArrayBuffer".to_string()
                                        } else {
                                            let mut name = "Uint8Array".to_string();
                                            if let Ok(obj) = v.downcast::<JsObject, _>(&mut cx) {
                                                if let Ok(ctor_any) =
                                                    obj.get_value(&mut cx, "constructor")
                                                {
                                                    if let Ok(ctor_obj) =
                                                        ctor_any.downcast::<JsObject, _>(&mut cx)
                                                    {
                                                        if let Some(nm) = get_string_prop(
                                                            &mut cx, ctor_obj, "name",
                                                        ) {
                                                            if !nm.trim().is_empty() {
                                                                name = nm;
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                            name
                                        };

                                        let byte_offset = if is_view {
                                            v.downcast::<JsObject, _>(&mut cx)
                                                .ok()
                                                .and_then(|o| {
                                                    o.get_value(&mut cx, "byteOffset")
                                                        .ok()
                                                        .and_then(|vv| {
                                                            vv.downcast::<JsNumber, _>(&mut cx).ok()
                                                        })
                                                        .map(|n| n.value(&mut cx) as usize)
                                                })
                                                .unwrap_or(0usize)
                                        } else {
                                            0usize
                                        };

                                        let byte_length = if is_view {
                                            v.downcast::<JsObject, _>(&mut cx)
                                                .ok()
                                                .and_then(|o| {
                                                    o.get_value(&mut cx, "byteLength")
                                                        .ok()
                                                        .and_then(|vv| {
                                                            vv.downcast::<JsNumber, _>(&mut cx).ok()
                                                        })
                                                        .map(|n| n.value(&mut cx) as usize)
                                                })
                                                .unwrap_or(bytes.len())
                                        } else {
                                            bytes.len()
                                        };

                                        let length = if kind == "DataView"
                                            || is_array_buffer
                                            || is_shared_array_buffer
                                        {
                                            byte_length
                                        } else {
                                            v.downcast::<JsObject, _>(&mut cx)
                                                .ok()
                                                .and_then(|o| {
                                                    o.get_value(&mut cx, "length")
                                                        .ok()
                                                        .and_then(|vv| {
                                                            vv.downcast::<JsNumber, _>(&mut cx).ok()
                                                        })
                                                        .map(|n| n.value(&mut cx) as usize)
                                                })
                                                .unwrap_or(byte_length)
                                        };

                                        let inner = cx.empty_object();
                                        let kind_v = cx.string(kind);
                                        inner.set(&mut cx, "kind", kind_v)?;
                                        inner.set(&mut cx, "bytes", bytes_arr)?;
                                        let bo_v = cx.number(byte_offset as f64);
                                        inner.set(&mut cx, "byteOffset", bo_v)?;
                                        let len_v = cx.number(length as f64);
                                        inner.set(&mut cx, "length", len_v)?;

                                        let marker = cx.empty_object();
                                        marker.set(&mut cx, BUFFER_KEY, inner)?;
                                        return Ok(marker.upcast());
                                    }
                                }
                            }
                        }
                    }
                }

                // Map / Set (encode as tagged arrays)
                if let Ok(obj) = v.downcast::<JsObject, _>(&mut cx) {
                    let tag = object_to_string_tag(&mut cx, v);
                    let is_map = tag.as_deref() == Some("[object Map]");

                    if is_map {
                        let array_ctor = cx.global::<JsFunction>("Array")?;
                        let array_obj = array_ctor.upcast::<JsObject>();
                        let from_any = array_obj.get_value(&mut cx, "from")?;
                        if let Ok(from_fn) = from_any.downcast::<JsFunction, _>(&mut cx) {
                            let entries_any = obj.get_value(&mut cx, "entries")?;
                            if let Ok(entries_fn) = entries_any.downcast::<JsFunction, _>(&mut cx) {
                                let iter = entries_fn
                                    .call_with(&mut cx)
                                    .this(obj)
                                    .apply::<JsValue, _>(&mut cx)
                                    .unwrap_or_else(|_| cx.undefined().upcast());

                                let pairs_any = from_fn
                                    .call_with(&mut cx)
                                    .this(array_obj)
                                    .arg(iter)
                                    .apply::<JsValue, _>(&mut cx)
                                    .unwrap_or_else(|_| cx.undefined().upcast());

                                let marker = cx.empty_object();
                                marker.set(&mut cx, MAP_KEY, pairs_any)?;
                                return Ok(marker.upcast());
                            }
                        }
                    }

                    let is_set = tag.as_deref() == Some("[object Set]");

                    if is_set {
                        let array_ctor = cx.global::<JsFunction>("Array")?;
                        let array_obj = array_ctor.upcast::<JsObject>();
                        let from_any = array_obj.get_value(&mut cx, "from")?;
                        if let Ok(from_fn) = from_any.downcast::<JsFunction, _>(&mut cx) {
                            let values_any = obj.get_value(&mut cx, "values")?;
                            if let Ok(values_fn) = values_any.downcast::<JsFunction, _>(&mut cx) {
                                let iter = values_fn
                                    .call_with(&mut cx)
                                    .this(obj)
                                    .apply::<JsValue, _>(&mut cx)
                                    .unwrap_or_else(|_| cx.undefined().upcast());

                                let vals_any = from_fn
                                    .call_with(&mut cx)
                                    .this(array_obj)
                                    .arg(iter)
                                    .apply::<JsValue, _>(&mut cx)
                                    .unwrap_or_else(|_| cx.undefined().upcast());

                                let marker = cx.empty_object();
                                marker.set(&mut cx, SET_KEY, vals_any)?;
                                return Ok(marker.upcast());
                            }
                        }
                    }
                }

                Ok(v)
            })?;

            let s = stringify
                .call_with(cx)
                .this(json)
                .arg(value)
                .arg(replacer)
                .apply::<JsString, _>(cx)?;

            Ok(s)
        })
        .ok()?;

    serde_json::from_str::<serde_json::Value>(&s.value(cx)).ok()
}

// Uses Node's v8 serializer when a non-plain object cannot be represented by wire JSON.
fn try_v8_serialize_bytes<'a, C: Context<'a>>(
    cx: &mut C,
    value: Handle<'a, JsValue>,
) -> Option<Vec<u8>> {
    cx.try_catch(|cx| {
        // __v8 is installed as a global object property (globalThis.__v8), not
        // as a global lexical binding, so resolve it from the global object.
        let global = cx.global_object();
        let v8_any = global.get_value(cx, "__v8")?;
        let v8obj = v8_any.downcast::<JsObject, _>(cx).map_err(|_| {
            cx.throw_error::<_, Throw>("globalThis.__v8 is not an object")
                .unwrap_err()
        })?;

        let ser_any = v8obj.get_value(cx, "serialize")?;
        let ser = ser_any.downcast::<JsFunction, _>(cx).map_err(|_| {
            cx.throw_error::<_, Throw>("globalThis.__v8.serialize is not a function")
                .unwrap_err()
        })?;

        let buf_any = ser.call_with(cx).arg(value).apply::<JsValue, _>(cx)?;
        let buf = buf_any.downcast::<JsBuffer, _>(cx).map_err(|_| {
            cx.throw_error::<_, Throw>("globalThis.__v8.serialize did not return Buffer")
                .unwrap_err()
        })?;

        Ok(buf.as_slice(cx).to_vec())
    })
    .ok()
}

struct NeonGraphEncodeState<'a> {
    seen: Vec<(u64, Handle<'a, JsObject>)>,
    next_id: u64,
}

impl<'a> NeonGraphEncodeState<'a> {
    fn new() -> Self {
        Self {
            seen: Vec::new(),
            next_id: 1,
        }
    }

    fn seen_id<C: Context<'a>>(&self, cx: &mut C, obj: Handle<'a, JsObject>) -> Option<u64> {
        self.seen.iter().find_map(|(id, seen)| {
            if seen.strict_equals(cx, obj) {
                Some(*id)
            } else {
                None
            }
        })
    }

    fn remember(&mut self, obj: Handle<'a, JsObject>) -> u64 {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1).max(1);
        self.seen.push((id, obj));
        id
    }
}

fn wire_undefined_json() -> serde_json::Value {
    serde_json::json!({ UNDEFINED_KEY: true })
}

fn wire_number_json(tag: &str) -> serde_json::Value {
    serde_json::json!({ NUMBER_KEY: tag })
}

fn graph_ref_json(id: u64) -> serde_json::Value {
    serde_json::json!({ GRAPH_REF_KEY: id })
}

fn graph_value_json(id: u64, kind: &str, value: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        GRAPH_ID_KEY: id,
        GRAPH_KIND_KEY: kind,
        GRAPH_VALUE_KEY: value,
    })
}

fn object_is_arraybuffer_view<'a, C: Context<'a>>(cx: &mut C, value: Handle<'a, JsValue>) -> bool {
    if let Ok(ab_ctor) = cx.global::<JsFunction>("ArrayBuffer") {
        return cx
            .try_catch(|cx| {
                let fn_any = ab_ctor.get_value(cx, "isView")?;
                let fn_is_view = fn_any.downcast::<JsFunction, _>(cx).unwrap();
                fn_is_view
                    .call_with(cx)
                    .this(ab_ctor)
                    .arg(value)
                    .apply::<JsBoolean, _>(cx)
            })
            .ok()
            .map(|b| b.value(cx))
            .unwrap_or(false);
    }
    false
}

fn is_binary_like_value<'a, C: Context<'a>>(cx: &mut C, value: Handle<'a, JsValue>) -> bool {
    if value.is_a::<JsBuffer, _>(cx)
        || value.is_a::<JsUint8Array, _>(cx)
        || value.is_a::<JsArrayBuffer, _>(cx)
    {
        return true;
    }

    matches!(
        object_to_string_tag(cx, value).as_deref(),
        Some("[object SharedArrayBuffer]")
    ) || object_is_arraybuffer_view(cx, value)
}

fn dehydrate_neon_to_wire_inner<'a, C: Context<'a>>(
    cx: &mut C,
    value: Handle<'a, JsValue>,
    state: &mut NeonGraphEncodeState<'a>,
    depth: usize,
) -> Result<serde_json::Value, Throw> {
    if depth > 200 {
        return Ok(wire_undefined_json());
    }

    if value.is_a::<JsUndefined, _>(cx) {
        return Ok(wire_undefined_json());
    }
    if value.is_a::<JsNull, _>(cx) {
        return Ok(serde_json::Value::Null);
    }
    if let Ok(v) = value.downcast::<JsBoolean, _>(cx) {
        return Ok(serde_json::Value::Bool(v.value(cx)));
    }
    if let Ok(v) = value.downcast::<JsString, _>(cx) {
        return Ok(serde_json::Value::String(v.value(cx)));
    }
    if let Ok(v) = value.downcast::<JsNumber, _>(cx) {
        let n = v.value(cx);
        if n == 0.0 && n.is_sign_negative() {
            return Ok(serde_json::json!({ NUMBER_NEG_ZERO_KEY: "-0" }));
        }
        if n.is_nan() {
            return Ok(wire_number_json("NaN"));
        }
        if n == f64::INFINITY {
            return Ok(wire_number_json("Infinity"));
        }
        if n == f64::NEG_INFINITY {
            return Ok(wire_number_json("-Infinity"));
        }
        return Ok(serde_json::Number::from_f64(n)
            .map(serde_json::Value::Number)
            .unwrap_or_else(wire_undefined_json));
    }
    if value.is_a::<neon::types::JsBigInt, _>(cx) {
        let s = value
            .to_string(cx)
            .map(|s| s.value(cx))
            .unwrap_or_else(|_| "0".to_string());
        return Ok(serde_json::json!({ BIGINT_KEY: s }));
    }
    if value.is_a::<JsFunction, _>(cx) {
        return Ok(wire_undefined_json());
    }

    if is_binary_like_value(cx, value) || value.downcast::<JsDate, _>(cx).is_ok() {
        return Ok(crate::bridge::wire::to_wire_json(&from_neon_value(
            cx, value,
        )?));
    }

    let tag = object_to_string_tag(cx, value);

    if matches!(tag.as_deref(), Some("[object Map]" | "[object Set]")) {
        if let Some(j) = try_json_stringify_with_replacer(cx, value) {
            return Ok(j);
        }
        return Ok(crate::bridge::wire::to_wire_json(&from_neon_value(
            cx, value,
        )?));
    }

    if matches!(
        tag.as_deref(),
        Some("[object RegExp]" | "[object URL]" | "[object URLSearchParams]" | "[object Error]")
    ) {
        return Ok(crate::bridge::wire::to_wire_json(&from_neon_value(
            cx, value,
        )?));
    }

    if let Ok(arr) = value.downcast::<JsArray, _>(cx) {
        let Ok(obj) = value.downcast::<JsObject, _>(cx) else {
            return Ok(wire_undefined_json());
        };
        if let Some(id) = state.seen_id(cx, obj) {
            return Ok(graph_ref_json(id));
        }
        let id = state.remember(obj);
        let mut out = Vec::with_capacity(arr.len(cx) as usize);
        for i in 0..arr.len(cx) {
            let item = arr
                .get_value(cx, i)
                .unwrap_or_else(|_| cx.undefined().upcast::<JsValue>());
            out.push(dehydrate_neon_to_wire_inner(cx, item, state, depth + 1)?);
        }
        return Ok(graph_value_json(
            id,
            GRAPH_KIND_ARRAY,
            serde_json::Value::Array(out),
        ));
    }

    if matches!(tag.as_deref(), Some("[object Object]")) {
        let Ok(obj) = value.downcast::<JsObject, _>(cx) else {
            return Ok(wire_undefined_json());
        };
        if let Some(id) = state.seen_id(cx, obj) {
            return Ok(graph_ref_json(id));
        }
        let id = state.remember(obj);
        let mut out = serde_json::Map::new();
        for key in own_enumerable_string_keys(cx, obj) {
            if key == "__proto__" {
                continue;
            }
            let vv = obj
                .get_value(cx, key.as_str())
                .unwrap_or_else(|_| cx.undefined().upcast::<JsValue>());
            out.insert(key, dehydrate_neon_to_wire_inner(cx, vv, state, depth + 1)?);
        }
        return Ok(graph_value_json(
            id,
            GRAPH_KIND_OBJECT,
            serde_json::Value::Object(out),
        ));
    }

    if let Some(j) = try_json_stringify_with_replacer(cx, value) {
        return Ok(j);
    }

    Ok(wire_undefined_json())
}

pub(crate) fn dehydrate_neon_to_wire<'a, C: Context<'a>>(
    cx: &mut C,
    value: Handle<'a, JsValue>,
) -> Result<serde_json::Value, Throw> {
    let mut state = NeonGraphEncodeState::new();
    dehydrate_neon_to_wire_inner(cx, value, &mut state, 0)
}

fn buffer_view_kind_from_tag(tag: Option<&str>) -> Option<String> {
    let tag = tag?;
    if !tag.starts_with("[object ") || !tag.ends_with(']') {
        return None;
    }
    let kind = &tag[8..tag.len().saturating_sub(1)];
    if kind.is_empty() {
        None
    } else {
        Some(kind.to_string())
    }
}

fn constructor_name<'a, C: Context<'a>>(cx: &mut C, value: Handle<'a, JsValue>) -> Option<String> {
    let obj = value.downcast::<JsObject, _>(cx).ok()?;
    let ctor_any = obj.get_value(cx, "constructor").ok()?;
    if let Ok(ctor_fn) = ctor_any.downcast::<JsFunction, _>(cx) {
        let ctor_obj = ctor_fn.upcast::<JsObject>();
        return get_string_prop(cx, ctor_obj, "name").filter(|s| !s.trim().is_empty());
    }
    if let Ok(ctor_obj) = ctor_any.downcast::<JsObject, _>(cx) {
        return get_string_prop(cx, ctor_obj, "name").filter(|s| !s.trim().is_empty());
    }
    None
}

/// Converts a Node/Neon value into the internal bridge representation.
pub fn from_neon_value<'a, C: Context<'a>>(
    cx: &mut C,
    value: Handle<'a, JsValue>,
) -> Result<JsValueBridge, Throw> {
    if value.is_a::<JsUndefined, _>(cx) {
        return Ok(JsValueBridge::Undefined);
    }
    if value.is_a::<JsNull, _>(cx) {
        return Ok(JsValueBridge::Null);
    }

    if let Ok(v) = value.downcast::<JsBoolean, _>(cx) {
        return Ok(JsValueBridge::Bool(v.value(cx)));
    }
    if let Ok(v) = value.downcast::<JsNumber, _>(cx) {
        return Ok(JsValueBridge::Number(v.value(cx)));
    }
    if let Ok(v) = value.downcast::<JsString, _>(cx) {
        return Ok(JsValueBridge::String(v.value(cx)));
    }

    // BigInt primitive (critical for setGlobal + args)
    if value.is_a::<neon::types::JsBigInt, _>(cx) {
        let s = cx
            .try_catch(|cx| value.to_string(cx))
            .ok()
            .map(|ss| ss.value(cx))
            .unwrap_or_else(|| "0".to_string());
        return Ok(JsValueBridge::BigInt(s));
    }

    if let Ok(v) = value.downcast::<JsDate, _>(cx) {
        return Ok(JsValueBridge::DateMs(v.value(cx)));
    }

    if is_regexp_like(cx, value) {
        let obj = value
            .downcast::<JsObject, _>(cx)
            .unwrap_or_else(|_| cx.empty_object());
        let source = get_string_prop(cx, obj, "source").unwrap_or_default();
        let flags = get_string_prop(cx, obj, "flags").unwrap_or_default();
        return Ok(JsValueBridge::RegExp { source, flags });
    }

    if let Some(tag) = object_to_string_tag(cx, value) {
        if tag == "[object URL]" {
            if let Ok(obj) = value.downcast::<JsObject, _>(cx) {
                if let Some(href) = get_string_prop(cx, obj, "href") {
                    return Ok(JsValueBridge::Url { href });
                }
            }
        }

        if tag == "[object URLSearchParams]" {
            if let Ok(obj) = value.downcast::<JsObject, _>(cx) {
                let query = cx
                    .try_catch(|cx| {
                        let to_string_fn = obj.get::<JsFunction, _, _>(cx, "toString")?;
                        let out = to_string_fn
                            .call_with(cx)
                            .this(obj)
                            .apply::<JsString, _>(cx)?;
                        Ok(out.value(cx))
                    })
                    .unwrap_or_default();
                return Ok(JsValueBridge::UrlSearchParams { query });
            }
        }
    }

    // Fast-path Buffer (Node): treat as Uint8Array bytes.
    if is_node_buffer(cx, value) {
        if let Ok(v) = value.downcast::<JsBuffer, _>(cx) {
            let bytes = v.as_slice(cx).to_vec();
            let len = bytes.len();
            return Ok(JsValueBridge::BufferView {
                kind: "Uint8Array".into(),
                bytes: Bytes::from(bytes),
                byte_offset: 0,
                length: len,
            });
        }
    }

    // Fast-path non-Buffer ArrayBuffer / TypedArray / DataView.
    if let Ok(buf_ctor) = cx.global::<JsFunction>("Buffer") {
        if let Ok(from_any) = buf_ctor.get_value(cx, "from") {
            if let Ok(from_fn) = from_any.downcast::<JsFunction, _>(cx) {
                let tag = object_to_string_tag(cx, value);
                let is_ab = tag.as_deref() == Some("[object ArrayBuffer]");
                let is_sab = tag.as_deref() == Some("[object SharedArrayBuffer]");
                let is_view = if let Ok(ab_ctor) = cx.global::<JsFunction>("ArrayBuffer") {
                    cx.try_catch(|cx| {
                        let fn_any = ab_ctor.get_value(cx, "isView")?;
                        let fn_is_view = fn_any.downcast::<JsFunction, _>(cx).unwrap();
                        fn_is_view
                            .call_with(cx)
                            .this(ab_ctor)
                            .arg(value)
                            .apply::<JsBoolean, _>(cx)
                    })
                    .ok()
                    .map(|b| b.value(cx))
                    .unwrap_or(false)
                } else {
                    false
                };

                if is_ab || is_sab || is_view {
                    let out_any = if is_view {
                        if let Ok(obj) = value.downcast::<JsObject, _>(cx) {
                            let buf_any = obj
                                .get_value(cx, "buffer")
                                .unwrap_or_else(|_| cx.undefined().upcast::<JsValue>());
                            let bo_any = obj
                                .get_value(cx, "byteOffset")
                                .unwrap_or_else(|_| cx.number(0.0).upcast::<JsValue>());
                            let bl_any = obj
                                .get_value(cx, "byteLength")
                                .unwrap_or_else(|_| cx.number(0.0).upcast::<JsValue>());

                            from_fn
                                .call_with(cx)
                                .this(buf_ctor)
                                .arg(buf_any)
                                .arg(bo_any)
                                .arg(bl_any)
                                .apply::<JsValue, _>(cx)
                                .unwrap_or_else(|_| cx.undefined().upcast())
                        } else {
                            cx.undefined().upcast()
                        }
                    } else {
                        from_fn
                            .call_with(cx)
                            .this(buf_ctor)
                            .arg(value)
                            .apply::<JsValue, _>(cx)
                            .unwrap_or_else(|_| cx.undefined().upcast())
                    };

                    if let Ok(out_buf) = out_any.downcast::<JsBuffer, _>(cx) {
                        let bytes = out_buf.as_slice(cx).to_vec();

                        let kind = if is_ab {
                            "ArrayBuffer".to_string()
                        } else if is_sab {
                            "SharedArrayBuffer".to_string()
                        } else {
                            constructor_name(cx, value)
                                .or_else(|| buffer_view_kind_from_tag(tag.as_deref()))
                                .unwrap_or_else(|| "Uint8Array".to_string())
                        };

                        let byte_offset = if is_ab || is_sab {
                            0usize
                        } else {
                            value
                                .downcast::<JsObject, _>(cx)
                                .ok()
                                .and_then(|o| o.get_value(cx, "byteOffset").ok())
                                .and_then(|n| n.downcast::<JsNumber, _>(cx).ok())
                                .map(|n| n.value(cx) as usize)
                                .unwrap_or(0usize)
                        };

                        let byte_length = if is_ab || is_sab {
                            bytes.len()
                        } else {
                            value
                                .downcast::<JsObject, _>(cx)
                                .ok()
                                .and_then(|o| o.get_value(cx, "byteLength").ok())
                                .and_then(|n| n.downcast::<JsNumber, _>(cx).ok())
                                .map(|n| n.value(cx) as usize)
                                .unwrap_or(bytes.len())
                        };

                        let length = if kind == "DataView" || is_ab || is_sab {
                            byte_length
                        } else {
                            value
                                .downcast::<JsObject, _>(cx)
                                .ok()
                                .and_then(|o| o.get_value(cx, "length").ok())
                                .and_then(|n| n.downcast::<JsNumber, _>(cx).ok())
                                .map(|n| n.value(cx) as usize)
                                .unwrap_or(byte_length)
                        };

                        return Ok(JsValueBridge::BufferView {
                            kind,
                            bytes: Bytes::from(bytes),
                            byte_offset,
                            length,
                        });
                    }
                }
            }
        }
    }

    // Error-like objects
    if let Ok(obj) = value.downcast::<JsObject, _>(cx) {
        let is_native_err = value.is_a::<neon::types::JsError, _>(cx);
        let name_opt = get_string_prop(cx, obj, "name");
        let is_error_name = name_opt.as_deref().unwrap_or("").ends_with("Error");
        let has_message = obj
            .get_value(cx, "message")
            .map(|v| v.is_a::<JsString, _>(cx))
            .unwrap_or(false);
        let has_stack = obj
            .get_value(cx, "stack")
            .map(|v| v.is_a::<JsString, _>(cx))
            .unwrap_or(false);

        if is_native_err || (is_error_name && (has_message || has_stack)) {
            return Ok(JsValueBridge::Error {
                name: name_opt.unwrap_or_else(|| "Error".into()),
                message: get_string_prop(cx, obj, "message").unwrap_or_default(),
                stack: get_string_prop(cx, obj, "stack"),
                code: get_string_prop(cx, obj, "code"),
                cause: None,
            });
        }
    }

    // Structured values (objects/arrays):
    // - Plain Object/Array prefer structured clone so cyclic/shared graphs
    //   preserve identity without relying on JS-side graph markers.
    // - When structured clone is unavailable (for example nested functions),
    //   fall back to Rust-side wire encoding.
    // - Non-plain structured objects try V8 structured clone first, then JSON fallback.
    if value.is_a::<JsArray, _>(cx) || value.is_a::<JsObject, _>(cx) {
        let tag = object_to_string_tag(cx, value);
        let is_plain = matches!(tag.as_deref(), Some("[object Object]" | "[object Array]"));

        if is_plain {
            if let Some(bytes) = try_v8_serialize_bytes(cx, value) {
                return Ok(JsValueBridge::V8Serialized(bytes));
            }
            return dehydrate_neon_to_wire(cx, value).map(JsValueBridge::Json);
        }

        if !is_plain {
            if let Some(bytes) = try_v8_serialize_bytes(cx, value) {
                return Ok(JsValueBridge::V8Serialized(bytes));
            }
        }

        if let Some(j) = try_json_stringify_with_replacer(cx, value) {
            return Ok(JsValueBridge::Json(j));
        }

        return Ok(JsValueBridge::Undefined);
    }

    Ok(JsValueBridge::Undefined)
}

// Builds an exact ArrayBuffer copy from raw bytes.
fn make_arraybuffer_from_bytes<'a, C: Context<'a>>(
    cx: &mut C,
    bytes: &[u8],
) -> Result<Handle<'a, JsValue>, Throw> {
    if let Ok(mut src) = JsBuffer::new(cx, bytes.len()) {
        src.as_mut_slice(cx).copy_from_slice(bytes);
        let src_obj = src.upcast::<JsObject>();

        let out = cx.try_catch(|cx| {
            let ab_any = src_obj.get_value(cx, "buffer")?;
            let ab_obj = ab_any.downcast::<JsObject, _>(cx).map_err(|_| {
                cx.throw_error::<_, Throw>("Buffer.buffer is not an object")
                    .unwrap_err()
            })?;

            let bo = src_obj.get_value(cx, "byteOffset")?;
            let bl = src_obj.get_value(cx, "byteLength")?;

            let end = {
                let bo_n = bo
                    .downcast::<JsNumber, _>(cx)
                    .ok()
                    .map(|n| n.value(cx))
                    .unwrap_or(0.0);
                let bl_n = bl
                    .downcast::<JsNumber, _>(cx)
                    .ok()
                    .map(|n| n.value(cx))
                    .unwrap_or(bytes.len() as f64);
                cx.number(bo_n + bl_n).upcast::<JsValue>()
            };

            let slice_any = ab_obj.get_value(cx, "slice")?;
            let slice_fn = slice_any.downcast::<JsFunction, _>(cx).map_err(|_| {
                cx.throw_error::<_, Throw>("ArrayBuffer.slice is not a function")
                    .unwrap_err()
            })?;

            slice_fn
                .call_with(cx)
                .this(ab_obj)
                .arg(bo)
                .arg(end)
                .apply::<JsValue, _>(cx)
        });

        if let Ok(v) = out {
            return Ok(v);
        }
    }

    let ab_ctor = cx.global::<JsFunction>("ArrayBuffer")?;
    let len_v = cx.number(bytes.len() as f64).upcast::<JsValue>();
    let ab_any = reflect_construct(cx, ab_ctor, &[len_v])?;

    let ab_obj = ab_any.downcast::<JsObject, _>(cx).map_err(|_| {
        cx.throw_error::<_, Throw>("Failed to construct ArrayBuffer")
            .unwrap_err()
    })?;

    let u8_ctor = cx.global::<JsFunction>("Uint8Array")?;
    let ab_v = ab_obj.upcast::<JsValue>();
    let u8_any = reflect_construct(cx, u8_ctor, &[ab_v])?;
    let u8 = u8_any.downcast::<JsObject, _>(cx).map_err(|_| {
        cx.throw_error::<_, Throw>("Failed to construct Uint8Array(ArrayBuffer)")
            .unwrap_err()
    })?;

    let mut src = JsBuffer::new(cx, bytes.len())?;
    src.as_mut_slice(cx).copy_from_slice(bytes);
    let set_any = u8.get_value(cx, "set")?;
    let set_fn = set_any.downcast::<JsFunction, _>(cx).map_err(|_| {
        cx.throw_error::<_, Throw>("Uint8Array.set is not a function")
            .unwrap_err()
    })?;
    let _ = set_fn
        .call_with(cx)
        .this(u8)
        .arg(src)
        .apply::<JsValue, _>(cx);

    Ok(ab_obj.upcast())
}

// Builds a SharedArrayBuffer copy when available, otherwise falls back to ArrayBuffer.
fn make_shared_arraybuffer_from_bytes<'a, C: Context<'a>>(
    cx: &mut C,
    bytes: &[u8],
) -> Result<Handle<'a, JsValue>, Throw> {
    let sab_ctor = match cx.global::<JsFunction>("SharedArrayBuffer") {
        Ok(f) => f,
        Err(_) => return make_arraybuffer_from_bytes(cx, bytes),
    };

    let len_v = cx.number(bytes.len() as f64).upcast::<JsValue>();
    let sab_any = reflect_construct(cx, sab_ctor, &[len_v])?;

    let sab_obj = sab_any.downcast::<JsObject, _>(cx).map_err(|_| {
        cx.throw_error::<_, Throw>("Failed to construct SharedArrayBuffer")
            .unwrap_err()
    })?;

    let u8_ctor = cx.global::<JsFunction>("Uint8Array")?;
    let sab_v = sab_obj.upcast::<JsValue>();
    let u8_any = reflect_construct(cx, u8_ctor, &[sab_v])?;
    let u8 = u8_any.downcast::<JsObject, _>(cx).map_err(|_| {
        cx.throw_error::<_, Throw>("Failed to construct Uint8Array(SharedArrayBuffer)")
            .unwrap_err()
    })?;

    let mut src = JsBuffer::new(cx, bytes.len())?;
    src.as_mut_slice(cx).copy_from_slice(bytes);
    let set_any = u8.get_value(cx, "set")?;
    let set_fn = set_any.downcast::<JsFunction, _>(cx).map_err(|_| {
        cx.throw_error::<_, Throw>("Uint8Array.set is not a function")
            .unwrap_err()
    })?;
    let _ = set_fn
        .call_with(cx)
        .this(u8)
        .arg(src)
        .apply::<JsValue, _>(cx);

    Ok(sab_obj.upcast())
}

fn buffer_view_bytes_per_element(kind: &str) -> usize {
    match kind {
        "Int8Array" | "Uint8Array" | "Uint8ClampedArray" | "DataView" => 1,
        "Int16Array" | "Uint16Array" => 2,
        "Int32Array" | "Uint32Array" | "Float32Array" => 4,
        "Float64Array" | "BigInt64Array" | "BigUint64Array" => 8,
        _ => 1,
    }
}

fn buffer_view_window(
    kind: &str,
    raw_byte_len: usize,
    byte_offset: usize,
    length: usize,
) -> Option<(usize, usize)> {
    if matches!(kind, "ArrayBuffer" | "SharedArrayBuffer") {
        return Some((0, length.min(raw_byte_len)));
    }

    let bytes_per_element = buffer_view_bytes_per_element(kind);
    let span_bytes = length.checked_mul(bytes_per_element)?;

    if byte_offset <= raw_byte_len {
        if let Some(end) = byte_offset.checked_add(span_bytes) {
            if end <= raw_byte_len {
                return Some((byte_offset, length));
            }
        }
    }

    // Some producers copy only the view bytes but preserve the original
    // byteOffset. Rebase those copied payloads onto offset 0 before constructing.
    if span_bytes <= raw_byte_len {
        return Some((0, length));
    }

    let safe_offset = byte_offset.min(raw_byte_len);
    let available = raw_byte_len.saturating_sub(safe_offset);
    Some((safe_offset, available / bytes_per_element))
}

// Reconstructs ArrayBuffer/TypedArray/DataView values for the Node realm.
fn buffer_view_to_neon<'a, C: Context<'a>>(
    cx: &mut C,
    kind: &str,
    bytes: &[u8],
    byte_offset: usize,
    length: usize,
) -> Result<Handle<'a, JsValue>, Throw> {
    let (view_offset, view_length) = buffer_view_window(kind, bytes.len(), byte_offset, length)
        .ok_or_else(|| {
            cx.throw_error::<_, Throw>("Invalid buffer view bounds")
                .unwrap_err()
        })?;

    // Hot path: most message payloads are full Uint8Array byte buffers.
    // Returning Node Buffer here avoids expensive per-byte JS property sets.
    if kind == "Uint8Array" && view_offset == 0 && view_length == bytes.len() {
        let mut out = JsBuffer::new(cx, bytes.len())?;
        out.as_mut_slice(cx).copy_from_slice(bytes);
        return Ok(out.upcast());
    }

    let ab_any = if kind == "SharedArrayBuffer" {
        make_shared_arraybuffer_from_bytes(cx, bytes)?
    } else {
        make_arraybuffer_from_bytes(cx, bytes)?
    };

    let ab_obj = ab_any.downcast::<JsObject, _>(cx).map_err(|_| {
        cx.throw_error::<_, Throw>("Failed to construct ArrayBuffer")
            .unwrap_err()
    })?;

    if kind == "ArrayBuffer" || kind == "SharedArrayBuffer" {
        return Ok(ab_obj.upcast());
    }

    if kind == "DataView" {
        let dv_ctor = cx.global::<JsFunction>("DataView")?;
        let ab_v = ab_obj.upcast::<JsValue>();
        let bo_v = cx.number(view_offset as f64).upcast::<JsValue>();
        let len_v = cx.number(view_length as f64).upcast::<JsValue>();
        return reflect_construct(cx, dv_ctor, &[ab_v, bo_v, len_v]);
    }

    // Typed arrays by global constructor name.
    let ctor_any = cx
        .global::<JsObject>("globalThis")
        .and_then(|g| g.get_value(cx, kind))
        .ok();

    if let Some(ctor_any) = ctor_any {
        if let Ok(ctor) = ctor_any.downcast::<JsFunction, _>(cx) {
            let ab_v = ab_obj.upcast::<JsValue>();
            let bo_v = cx.number(view_offset as f64).upcast::<JsValue>();
            let len_v = cx.number(view_length as f64).upcast::<JsValue>();

            if let Ok(v) = reflect_construct(cx, ctor, &[ab_v, bo_v, len_v]) {
                return Ok(v);
            }
        }
    }

    // Fallback: Uint8Array view.
    let u8_ctor = cx.global::<JsFunction>("Uint8Array")?;
    let ab_v = ab_obj.upcast::<JsValue>();
    let bo_v = cx.number(view_offset as f64).upcast::<JsValue>();
    let len_v = cx.number(view_length as f64).upcast::<JsValue>();
    reflect_construct(cx, u8_ctor, &[ab_v, bo_v, len_v])
}

// Converts plain/wire JSON into Node values, including tagged bridge objects.
fn json_to_neon<'a, C: Context<'a>>(
    cx: &mut C,
    v: &serde_json::Value,
    depth: usize,
) -> Result<Handle<'a, JsValue>, Throw> {
    if depth > 200 {
        return Ok(cx.undefined().upcast());
    }

    match v {
        serde_json::Value::Null => Ok(cx.null().upcast()),
        serde_json::Value::Bool(b) => Ok(cx.boolean(*b).upcast()),
        serde_json::Value::Number(n) => Ok(cx.number(n.as_f64().unwrap_or(0.0)).upcast()),
        serde_json::Value::String(s) => Ok(cx.string(s).upcast()),
        serde_json::Value::Array(arr) => {
            let out = JsArray::new(cx, arr.len());
            for (i, item) in arr.iter().enumerate() {
                let vv = json_to_neon(cx, item, depth + 1)?;
                let _ = out.set(cx, i as u32, vv);
            }
            Ok(out.upcast())
        }
        serde_json::Value::Object(map) => {
            // Console: { __denojs_worker_console_buffer: number[] } -> Node Buffer
            if let Some(arr) = map
                .get("__denojs_worker_console_buffer")
                .and_then(|x| x.as_array())
            {
                let mut bytes = rent_byte_vec(arr.len());
                for it in arr.iter() {
                    match it.as_u64() {
                        Some(n) if n <= 255 => bytes.push(n as u8),
                        _ => {
                            give_back_byte_vec(bytes);
                            return Ok(cx.undefined().upcast());
                        }
                    }
                }

                let mut b = JsBuffer::new(cx, bytes.len())?;
                b.as_mut_slice(cx).copy_from_slice(&bytes);
                give_back_byte_vec(bytes);
                return Ok(b.upcast());
            }

            if map.get(NUMBER_NEG_ZERO_KEY).and_then(|x| x.as_str()) == Some("-0") {
                return Ok(cx.number(-0.0).upcast());
            }

            if let Some(ms) = map.get(DATE_KEY).and_then(|x| x.as_f64()) {
                return cx
                    .date(ms)
                    .map(|d| d.upcast())
                    .or_else(|_| Ok(cx.undefined().upcast()));
            }

            if let Some(ms) = map
                .get("__denojs_worker_console_date")
                .and_then(|x| x.as_f64())
            {
                return cx
                    .date(ms)
                    .map(|d| d.upcast())
                    .or_else(|_| Ok(cx.undefined().upcast()));
            }

            if let Some(ms) = map
                .get("__denojs_worker_console_nested_date")
                .and_then(|x| x.as_f64())
            {
                let o = cx.empty_object();
                let key = cx.string(DATE_KEY);
                let vv = cx.number(ms);
                let _ = o.set(cx, key, vv);
                return Ok(o.upcast());
            }

            if let Some(s) = map.get(BIGINT_KEY).and_then(|x| x.as_str()) {
                let ctor = match cx.global::<JsFunction>("BigInt") {
                    Ok(f) => f,
                    Err(_) => return Ok(cx.string(s).upcast()),
                };
                let arg = cx.string(s).upcast::<JsValue>();
                let out = cx
                    .try_catch(|cx| ctor.call_with(cx).arg(arg).apply::<JsValue, _>(cx))
                    .ok();
                return Ok(out.unwrap_or_else(|| cx.string(s).upcast()));
            }

            if let Some(re) = map.get(REGEXP_KEY).and_then(|x| x.as_object()) {
                let source = re.get("source").and_then(|x| x.as_str()).unwrap_or("");
                let flags = re.get("flags").and_then(|x| x.as_str()).unwrap_or("");

                let ctor = match cx.global::<JsFunction>("RegExp") {
                    Ok(f) => f,
                    Err(_) => {
                        let o = cx.empty_object();
                        let src_v = cx.string(source);
                        o.set(cx, "source", src_v)?;
                        let flags_v = cx.string(flags);
                        o.set(cx, "flags", flags_v)?;
                        return Ok(o.upcast());
                    }
                };

                let src_v = cx.string(source).upcast::<JsValue>();
                let flags_v = cx.string(flags).upcast::<JsValue>();

                let out = cx
                    .try_catch(|cx| reflect_construct(cx, ctor, &[src_v, flags_v]))
                    .ok();

                return Ok(out.unwrap_or_else(|| cx.undefined().upcast()));
            }

            if let Some(s) = map.get(URL_KEY).and_then(|x| x.as_str()) {
                let ctor = cx.global::<JsFunction>("URL").ok();
                if let Some(ctor) = ctor {
                    let ss = cx.string(s).upcast::<JsValue>();
                    let out = cx.try_catch(|cx| reflect_construct(cx, ctor, &[ss])).ok();
                    return Ok(out.unwrap_or_else(|| cx.string(s).upcast()));
                }
                return Ok(cx.string(s).upcast());
            }

            if let Some(s) = map.get(URL_SEARCH_PARAMS_KEY).and_then(|x| x.as_str()) {
                let ctor = cx.global::<JsFunction>("URLSearchParams").ok();
                if let Some(ctor) = ctor {
                    let ss = cx.string(s).upcast::<JsValue>();
                    let out = cx.try_catch(|cx| reflect_construct(cx, ctor, &[ss])).ok();
                    return Ok(out.unwrap_or_else(|| cx.string(s).upcast()));
                }
                return Ok(cx.string(s).upcast());
            }

            // __buffer wire tag: { __buffer: { kind, bytes|base64, byteOffset, length } }
            if let Some(b) = map.get(BUFFER_KEY).and_then(|x| x.as_object()) {
                let kind = b
                    .get("kind")
                    .and_then(|x| x.as_str())
                    .unwrap_or("Uint8Array");

                let byte_offset =
                    b.get("byteOffset").and_then(|x| x.as_u64()).unwrap_or(0) as usize;

                let length = b.get("length").and_then(|x| x.as_u64()).unwrap_or(0) as usize;

                if let Some(bytes_arr_ref) = b.get("bytes").and_then(|x| x.as_array()) {
                    let mut out_bytes = rent_byte_vec(bytes_arr_ref.len());
                    for it in bytes_arr_ref.iter() {
                        match it.as_u64() {
                            Some(n) if n <= 255 => out_bytes.push(n as u8),
                            _ => {
                                give_back_byte_vec(out_bytes);
                                return Ok(cx.undefined().upcast());
                            }
                        }
                    }

                    let out = buffer_view_to_neon(cx, kind, &out_bytes, byte_offset, length)
                        .unwrap_or_else(|_| cx.undefined().upcast());
                    give_back_byte_vec(out_bytes);
                    return Ok(out);
                }

                if let Some(base64) = b.get("base64").and_then(|x| x.as_str()) {
                    let Ok(out_bytes) = base64::engine::general_purpose::STANDARD.decode(base64)
                    else {
                        return Ok(cx.undefined().upcast());
                    };
                    let out = buffer_view_to_neon(cx, kind, &out_bytes, byte_offset, length)
                        .unwrap_or_else(|_| cx.undefined().upcast());
                    return Ok(out);
                }

                return Ok(cx.undefined().upcast());
            }

            if let Some(pairs) = map.get(MAP_KEY).and_then(|x| x.as_array()) {
                let ctor = cx.global::<JsFunction>("Map").ok();
                if let Some(ctor) = ctor {
                    let js_pairs = JsArray::new(cx, pairs.len());
                    for (i, pair) in pairs.iter().enumerate() {
                        let js_pair = json_to_neon(cx, pair, depth + 1)?;
                        let _ = js_pairs.set(cx, i as u32, js_pair);
                    }

                    let arg = js_pairs.upcast::<JsValue>();
                    let out = cx.try_catch(|cx| reflect_construct(cx, ctor, &[arg])).ok();

                    return Ok(out.unwrap_or_else(|| cx.undefined().upcast()));
                }
            }

            if let Some(items) = map.get(SET_KEY).and_then(|x| x.as_array()) {
                let ctor = cx.global::<JsFunction>("Set").ok();
                if let Some(ctor) = ctor {
                    let js_items = JsArray::new(cx, items.len());
                    for (i, item) in items.iter().enumerate() {
                        let vv = json_to_neon(cx, item, depth + 1)?;
                        let _ = js_items.set(cx, i as u32, vv);
                    }

                    let arg = js_items.upcast::<JsValue>();
                    let out = cx.try_catch(|cx| reflect_construct(cx, ctor, &[arg])).ok();

                    return Ok(out.unwrap_or_else(|| cx.undefined().upcast()));
                }
            }

            if map.get(TYPE_KEY).and_then(|x| x.as_str()) == Some(TYPE_ERROR) {
                let name = map.get("name").and_then(|x| x.as_str()).unwrap_or("Error");
                let message = map.get("message").and_then(|x| x.as_str()).unwrap_or("");

                let err_obj: Handle<JsObject> = cx
                    .try_catch(|cx| cx.error(message).map(|e| e.upcast::<JsObject>()))
                    .unwrap_or_else(|_| cx.empty_object());

                let name_v: Handle<JsValue> = cx.string(name).upcast();
                let msg_v: Handle<JsValue> = cx.string(message).upcast();
                let stack_v: Option<Handle<JsValue>> = map
                    .get("stack")
                    .and_then(|x| x.as_str())
                    .map(|s| cx.string(s).upcast());
                let code_v: Option<Handle<JsValue>> = map
                    .get("code")
                    .and_then(|x| x.as_str())
                    .map(|s| cx.string(s).upcast());

                let cause_v: Option<Handle<JsValue>> = map.get("cause").map(|c| {
                    json_to_neon(cx, c, depth + 1).unwrap_or_else(|_| cx.undefined().upcast())
                });

                let _ = cx.try_catch(|cx| {
                    let object_obj = cx.global::<JsObject>("Object")?;
                    let define = object_obj.get::<JsFunction, _, _>(cx, "defineProperty")?;

                    let define_enum = |cx: &mut C, key: &str, val: Handle<JsValue>| {
                        let desc = cx.empty_object();
                        let t = cx.boolean(true);
                        let _ = desc.set(cx, "value", val);
                        let _ = desc.set(cx, "enumerable", t);
                        let _ = desc.set(cx, "configurable", t);
                        let _ = desc.set(cx, "writable", t);

                        let k = cx.string(key).upcast::<JsValue>();
                        let _ = define.call(cx, object_obj, &[err_obj.upcast(), k, desc.upcast()]);
                    };

                    define_enum(cx, "name", name_v);
                    define_enum(cx, "message", msg_v);
                    if let Some(v) = stack_v {
                        define_enum(cx, "stack", v);
                    }
                    if let Some(v) = code_v {
                        define_enum(cx, "code", v);
                    }
                    if let Some(v) = cause_v {
                        define_enum(cx, "cause", v);
                    }
                    Ok(())
                });

                let _ = cx.try_catch(|cx| {
                    let n = cx.string(name);
                    let m = cx.string(message);
                    let _ = err_obj.set(cx, "name", n);
                    let _ = err_obj.set(cx, "message", m);

                    if let Some(s) = map.get("stack").and_then(|x| x.as_str()) {
                        let sv = cx.string(s);
                        let _ = err_obj.set(cx, "stack", sv);
                    }
                    if let Some(s) = map.get("code").and_then(|x| x.as_str()) {
                        let cv = cx.string(s);
                        let _ = err_obj.set(cx, "code", cv);
                    }
                    if let Some(cause) = map.get("cause") {
                        let vv = json_to_neon(cx, cause, depth + 1)
                            .unwrap_or_else(|_| cx.undefined().upcast());
                        let _ = err_obj.set(cx, "cause", vv);
                    }
                    Ok(())
                });

                return Ok(err_obj.upcast());
            }

            let obj = cx.empty_object();
            for (k, val) in map.iter() {
                let vv = json_to_neon(cx, val, depth + 1)?;
                let _ = obj.set(cx, k.as_str(), vv);
            }
            Ok(obj.upcast())
        }
    }
}

/// Converts neon value into output representation for bridge encoding/decoding between Rust, V8, and Neon.
pub fn to_neon_value<'a, C: Context<'a>>(
    cx: &mut C,
    value: &JsValueBridge,
) -> Result<Handle<'a, JsValue>, Throw> {
    match value {
        JsValueBridge::Undefined => Ok(cx.undefined().upcast()),
        JsValueBridge::Null => Ok(cx.null().upcast()),
        JsValueBridge::Bool(v) => Ok(cx.boolean(*v).upcast()),
        JsValueBridge::Number(v) => Ok(cx.number(*v).upcast()),
        JsValueBridge::String(v) => Ok(cx.string(v).upcast()),
        JsValueBridge::DateMs(ms) => match JsDate::new(cx, *ms) {
            Ok(d) => Ok(d.upcast()),
            Err(_) => Ok(cx.undefined().upcast()),
        },

        JsValueBridge::BigInt(s) => {
            let ctor = cx.global::<JsFunction>("BigInt").ok();
            if let Some(ctor) = ctor {
                let arg = cx.string(s).upcast::<JsValue>();
                let out = cx
                    .try_catch(|cx| ctor.call_with(cx).arg(arg).apply::<JsValue, _>(cx))
                    .ok();
                Ok(out.unwrap_or_else(|| cx.string(s).upcast()))
            } else {
                Ok(cx.string(s).upcast())
            }
        }

        JsValueBridge::RegExp { source, flags } => {
            let ctor = cx.global::<JsFunction>("RegExp").ok();
            if let Some(ctor) = ctor {
                let src_v = cx.string(source).upcast::<JsValue>();
                let flags_v = cx.string(flags).upcast::<JsValue>();
                let out = cx
                    .try_catch(|cx| reflect_construct(cx, ctor, &[src_v, flags_v]))
                    .ok();
                Ok(out.unwrap_or_else(|| cx.undefined().upcast()))
            } else {
                Ok(cx.undefined().upcast())
            }
        }

        // Construct proper ArrayBuffer / TypedArray / DataView in Node.
        JsValueBridge::BufferView {
            kind,
            bytes,
            byte_offset,
            length,
        } => {
            let out = buffer_view_to_neon(cx, kind, bytes.as_ref(), *byte_offset, *length)
                .unwrap_or_else(|_| cx.undefined().upcast());
            Ok(out)
        }

        JsValueBridge::Map(entries) => {
            let ctor = cx.global::<JsFunction>("Map").ok();
            if let Some(ctor) = ctor {
                let pairs = JsArray::new(cx, entries.len());
                for (i, (k, v)) in entries.iter().enumerate() {
                    let pair = JsArray::new(cx, 2);
                    let kk = to_neon_value(cx, k).unwrap_or_else(|_| cx.undefined().upcast());
                    let vv = to_neon_value(cx, v).unwrap_or_else(|_| cx.undefined().upcast());
                    let _ = pair.set(cx, 0u32, kk);
                    let _ = pair.set(cx, 1u32, vv);
                    let _ = pairs.set(cx, i as u32, pair.upcast::<JsValue>());
                }

                let arg = pairs.upcast::<JsValue>();
                let out = cx.try_catch(|cx| reflect_construct(cx, ctor, &[arg])).ok();

                Ok(out.unwrap_or_else(|| cx.undefined().upcast()))
            } else {
                Ok(cx.undefined().upcast())
            }
        }

        JsValueBridge::Set(items) => {
            let ctor = cx.global::<JsFunction>("Set").ok();
            if let Some(ctor) = ctor {
                let arr = JsArray::new(cx, items.len());
                for (i, item) in items.iter().enumerate() {
                    let vv = to_neon_value(cx, item).unwrap_or_else(|_| cx.undefined().upcast());
                    let _ = arr.set(cx, i as u32, vv);
                }

                let arg = arr.upcast::<JsValue>();
                let out = cx.try_catch(|cx| reflect_construct(cx, ctor, &[arg])).ok();

                Ok(out.unwrap_or_else(|| cx.undefined().upcast()))
            } else {
                Ok(cx.undefined().upcast())
            }
        }

        JsValueBridge::Url { href } => {
            let ctor = cx.global::<JsFunction>("URL").ok();
            if let Some(ctor) = ctor {
                let arg = cx.string(href).upcast::<JsValue>();
                let out = cx.try_catch(|cx| reflect_construct(cx, ctor, &[arg])).ok();
                Ok(out.unwrap_or_else(|| cx.string(href).upcast()))
            } else {
                Ok(cx.string(href).upcast())
            }
        }

        JsValueBridge::UrlSearchParams { query } => {
            let ctor = cx.global::<JsFunction>("URLSearchParams").ok();
            if let Some(ctor) = ctor {
                let arg = cx.string(query).upcast::<JsValue>();
                let out = cx.try_catch(|cx| reflect_construct(cx, ctor, &[arg])).ok();
                Ok(out.unwrap_or_else(|| cx.string(query).upcast()))
            } else {
                Ok(cx.string(query).upcast())
            }
        }

        JsValueBridge::Json(v) => json_to_neon(cx, v, 0),

        JsValueBridge::V8Serialized(bytes) => {
            let global = cx.global::<JsObject>("globalThis")?;

            // Prefer globalThis.__v8 (index.ts installs it), else require("node:v8") on demand.
            let v8_any: Handle<JsValue> = match global.get_value(cx, "__v8") {
                Ok(v) => v,
                Err(_) => {
                    // try require("node:v8")
                    let req = cx.global::<JsFunction>("require").ok();
                    if let Some(req) = req {
                        let arg = cx.string("node:v8");
                        let undef = cx.undefined();
                        cx.try_catch(|cx| req.call(cx, undef, &[arg.upcast()]))
                            .ok()
                            .unwrap_or_else(|| cx.undefined().upcast())
                    } else {
                        cx.undefined().upcast()
                    }
                }
            };

            let v8obj = v8_any.downcast::<JsObject, _>(cx).map_err(|_| {
                cx.throw_error::<_, Throw>(
                    "Bridge decode failed: globalThis.__v8 is unavailable or invalid",
                )
                .unwrap_err()
            })?;

            let deser_any: Handle<JsValue> = match v8obj.get_value(cx, "deserialize") {
                Ok(v) => v,
                Err(_) => {
                    return cx.throw_error("Bridge decode failed: __v8.deserialize is missing");
                }
            };

            let deser = deser_any.downcast::<JsFunction, _>(cx).map_err(|_| {
                cx.throw_error::<_, Throw>(
                    "Bridge decode failed: __v8.deserialize is not a function",
                )
                .unwrap_err()
            })?;

            let mut b = JsBuffer::new(cx, bytes.len())?;
            b.as_mut_slice(cx).copy_from_slice(bytes);

            cx.try_catch(|cx| {
                deser
                    .call_with(cx)
                    .this(v8obj)
                    .arg(b)
                    .apply::<JsValue, _>(cx)
            })
            .map_err(|_| {
                cx.throw_error::<_, Throw>("Bridge decode failed: __v8.deserialize threw")
                    .unwrap_err()
            })
        }

        JsValueBridge::Error {
            name,
            message,
            stack,
            code,
            cause,
        } => {
            let err_obj: Handle<JsObject> = cx
                .try_catch(|cx| cx.error(message).map(|e| e.upcast::<JsObject>()))
                .unwrap_or_else(|_| cx.empty_object());

            let name_v: Handle<JsValue> = cx.string(name).upcast();
            let msg_v: Handle<JsValue> = cx.string(message).upcast();
            let stack_v: Option<Handle<JsValue>> = stack.as_ref().map(|s| cx.string(s).upcast());
            let code_v: Option<Handle<JsValue>> = code.as_ref().map(|s| cx.string(s).upcast());
            let cause_v: Option<Handle<JsValue>> = cause
                .as_ref()
                .and_then(|c| cx.try_catch(|cx| to_neon_value(cx, c)).ok());

            let _ = cx.try_catch(|cx| {
                let object_obj = cx.global::<JsObject>("Object")?;
                let define = object_obj.get::<JsFunction, _, _>(cx, "defineProperty")?;

                let define_enum = |cx: &mut C, key: &str, val: Handle<JsValue>| {
                    let desc = cx.empty_object();
                    let t = cx.boolean(true);
                    let _ = desc.set(cx, "value", val);
                    let _ = desc.set(cx, "enumerable", t);
                    let _ = desc.set(cx, "configurable", t);
                    let _ = desc.set(cx, "writable", t);

                    let k = cx.string(key).upcast::<JsValue>();
                    let _ = define.call(cx, object_obj, &[err_obj.upcast(), k, desc.upcast()]);
                };

                define_enum(cx, "name", name_v);
                define_enum(cx, "message", msg_v);
                if let Some(v) = stack_v {
                    define_enum(cx, "stack", v);
                }
                if let Some(v) = code_v {
                    define_enum(cx, "code", v);
                }
                if let Some(v) = cause_v {
                    define_enum(cx, "cause", v);
                }
                Ok(())
            });

            let _ = cx.try_catch(|cx| {
                let n = cx.string(name);
                let m = cx.string(message);
                let _ = err_obj.set(cx, "name", n);
                let _ = err_obj.set(cx, "message", m);

                if let Some(s) = stack.as_ref() {
                    let sv = cx.string(s);
                    let _ = err_obj.set(cx, "stack", sv);
                }
                if let Some(s) = code.as_ref() {
                    let cv = cx.string(s);
                    let _ = err_obj.set(cx, "code", cv);
                }
                if let Some(c) = cause.as_ref() {
                    let vv = to_neon_value(cx, c).unwrap_or_else(|_| cx.undefined().upcast());
                    let _ = err_obj.set(cx, "cause", vv);
                }
                Ok(())
            });

            Ok(err_obj.upcast())
        }

        JsValueBridge::HostFunction { .. } => Ok(cx.undefined().upcast()),
    }
}

/// Evaluates result to neon within the execution flow for bridge encoding/decoding between Rust, V8, and Neon.
pub fn eval_result_to_neon<'a>(
    cx: &mut FunctionContext<'a>,
    reply: EvalReply,
) -> JsResult<'a, JsValue> {
    match reply {
        EvalReply::Ok { value, .. } => to_neon_value(cx, &value),
        EvalReply::Err { error, .. } => {
            let err_val = to_neon_value(cx, &error)?;
            cx.throw(err_val)
        }
    }
}
