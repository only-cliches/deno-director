/* eslint-disable @typescript-eslint/no-explicit-any */

export const nativeAddon = require("../../index.node");

// Provide a stable V8 serialize/deserialize bridge for the native addon.
// The Rust side may emit JsValueBridge::V8Serialized values.
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const v8mod = require("node:v8");
    const g: any = globalThis as any;
    if (!g.__v8) {
        g.__v8 = {
            serialize: (value: any) => v8mod.serialize(value),
            deserialize: (buf: any) => v8mod.deserialize(buf),
        };
    }
} catch {
    // ignore
}
