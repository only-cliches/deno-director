use crate::bridge::types::JsValueBridge;

/// Builds a bridge error with optional fields left unset.
pub fn error(name: impl Into<String>, message: impl Into<String>) -> JsValueBridge {
    JsValueBridge::Error {
        name: name.into(),
        message: message.into(),
        stack: None,
        code: None,
        cause: None,
    }
}

/// Builds the standard error shape for failures in Node-hosted callbacks.
pub fn host_function_error(message: impl Into<String>) -> JsValueBridge {
    error("HostFunctionError", message)
}
