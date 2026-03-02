use crate::bridge::types::JsValueBridge;

pub fn err_wire(name: &str, message: impl Into<String>) -> serde_json::Value {
    let e = JsValueBridge::Error {
        name: name.into(),
        message: message.into(),
        stack: None,
        code: None,
        cause: None,
    };
    crate::bridge::wire::to_wire_json(&e)
}

pub fn ok_wire(value: JsValueBridge) -> serde_json::Value {
    crate::bridge::wire::to_wire_json(&value)
}

pub fn ok_reply(value: JsValueBridge) -> serde_json::Value {
    serde_json::json!({ "ok": true, "value": ok_wire(value) })
}

pub fn err_reply(name: &str, message: impl Into<String>) -> serde_json::Value {
    serde_json::json!({ "ok": false, "error": err_wire(name, message) })
}
