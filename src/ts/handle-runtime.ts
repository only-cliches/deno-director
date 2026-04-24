/* eslint-disable @typescript-eslint/no-explicit-any */

export const HANDLE_RUNTIME_KEY = "__denojs_worker_handle_v1";

export const HANDLE_RUNTIME_INSTALL_SOURCE = `var $args = globalThis.$args ?? [];
(() => {
    const mkErr = (code, message) => {
        const e = new Error(message);
        e.code = code;
        throw e;
    };

    const existing = globalThis.${HANDLE_RUNTIME_KEY};
    if (existing) {
        if (existing.__denojs_worker_handle_api_v1 === true) return true;
        mkErr("HANDLE_BRIDGE_TAMPERED", "Handle runtime bridge key is already occupied by incompatible value");
    }

    const reg = new Map();
    const splitPath = (path) => {
        if (path == null || path === "") return [];
        if (typeof path !== "string") mkErr("HANDLE_PATH_INVALID", "Handle path must be a string");
        const segs = path.split(".").map((s) => s.trim());
        if (segs.length === 0 || segs.some((s) => !s)) {
            mkErr("HANDLE_PATH_INVALID", \`Invalid handle path: \${String(path)}\`);
        }
        if (segs.some((s) => s === "__proto__" || s === "prototype" || s === "constructor")) {
            mkErr("HANDLE_PATH_FORBIDDEN", "Path contains forbidden prototype mutation segment");
        }
        return segs;
    };
    const mustObjectLike = (v, path) => {
        const t = typeof v;
        if (v == null || (t !== "object" && t !== "function")) {
            mkErr("HANDLE_PATH_INVALID", \`Cannot traverse handle path '\${path}'\`);
        }
    };
    const hasOwnOrProto = (obj, key) => key in Object(obj);
    const resolve = (base, path) => {
        const segs = splitPath(path);
        let cur = base;
        for (const seg of segs) {
            mustObjectLike(cur, path);
            cur = cur[seg];
        }
        return cur;
    };
    const resolveWithExistence = (base, path) => {
        const segs = splitPath(path);
        let cur = base;
        for (const seg of segs) {
            mustObjectLike(cur, path);
            if (!hasOwnOrProto(cur, seg)) return { exists: false, value: undefined };
            cur = cur[seg];
        }
        return { exists: true, value: cur };
    };
    const resolveParent = (base, path) => {
        const segs = splitPath(path);
        if (segs.length === 0) mkErr("HANDLE_PATH_INVALID", "Handle set/call path cannot be empty");
        let cur = base;
        for (let i = 0; i < segs.length - 1; i += 1) {
            const seg = segs[i];
            mustObjectLike(cur, path);
            cur = cur[seg];
        }
        return { parent: cur, key: segs[segs.length - 1] };
    };
    const toEntries = (value) => {
        if (value == null) return [];
        if (value instanceof Map) return Array.from(value.entries());
        if (value instanceof Set) return Array.from(value.entries());
        if (typeof value === "object" || typeof value === "function") return Object.entries(value);
        return [];
    };
    const toKeys = (value) => {
        if (value == null) return [];
        if (value instanceof Map || value instanceof Set) return Array.from(value.keys());
        if (typeof value === "object" || typeof value === "function") return Object.keys(value);
        return [];
    };
    const toJsonSnapshot = (value) => {
        const seen = new WeakSet();
        const s = JSON.stringify(value, (_key, v) => {
            if (typeof v === "bigint") return { __bigint: v.toString() };
            if (typeof v === "function") return \`[Function \${v.name || "anonymous"}]\`;
            if (typeof v === "symbol") return String(v);
            if (v instanceof Map) return { __map: Array.from(v.entries()) };
            if (v instanceof Set) return { __set: Array.from(v.values()) };
            if (v instanceof Date) return { __date: v.toISOString() };
            if (v instanceof Error) return { __error: { name: v.name, message: v.message, stack: v.stack } };
            if (v && typeof v === "object") {
                if (seen.has(v)) return "[Circular]";
                seen.add(v);
            }
            return v;
        });
        if (s === undefined) return undefined;
        return JSON.parse(s);
    };
    const isPromiseLike = (value) =>
        value != null &&
        (typeof value === "object" || typeof value === "function") &&
        typeof value.then === "function";
    const awaitOne = (value) =>
        new Promise((resolve, reject) => {
            try {
                value.then(
                    (v) => resolve({ value: v }),
                    reject,
                );
            } catch (e) {
                reject(e);
            }
        });
    const withCallArgs = (args, invoke) => {
        const prevArgs = $args;
        $args = Array.isArray(args) ? args : [];
        try {
            const out = invoke();
            if (isPromiseLike(out)) {
                return Promise.resolve(out).finally(() => {
                    $args = prevArgs;
                });
            }
            $args = prevArgs;
            return out;
        } catch (e) {
            $args = prevArgs;
            throw e;
        }
    };
    const typeInfo = (value) => {
        const tag = Object.prototype.toString.call(value);
        let type = "object";
        if (value === undefined) type = "undefined";
        else if (value === null) type = "null";
        else if (Array.isArray(value)) type = "array";
        else if (tag === "[object Date]") type = "date";
        else if (tag === "[object RegExp]") type = "regexp";
        else if (tag === "[object Map]") type = "map";
        else if (tag === "[object Set]") type = "set";
        else if (tag === "[object ArrayBuffer]") type = "arraybuffer";
        else if (typeof ArrayBuffer !== "undefined" && typeof ArrayBuffer.isView === "function" && ArrayBuffer.isView(value)) type = "typedarray";
        else if (value instanceof Error) type = "error";
        else if (tag === "[object Promise]") type = "promise";
        else type = typeof value;
        const out = { type, callable: typeof value === "function" };
        if (value && (typeof value === "object" || typeof value === "function")) {
            const ctorName = value.constructor && typeof value.constructor.name === "string" ? value.constructor.name : undefined;
            if (ctorName) out.constructorName = ctorName;
        }
        return out;
    };
    const api = {
        async run(payload) {
            if (!payload || typeof payload !== "object") mkErr("HANDLE_PAYLOAD_INVALID", "Invalid handle payload");
            const op = String(payload.op || "");
            const id = String(payload.id || "");
            if (!id) mkErr("HANDLE_ID_INVALID", "Invalid handle id");

            if (op === "createFromPath") {
                const found = resolveWithExistence(globalThis, payload.path);
                if (!found.exists) mkErr("HANDLE_PATH_NOT_FOUND", \`Handle path not found: \${String(payload.path)}\`);
                reg.set(id, found.value);
                return { id };
            }
            if (op === "createFromEval") {
                const src = String(payload.source || "");
                if (!src.trim()) mkErr("HANDLE_EVAL_SOURCE_EMPTY", "handle.eval(source) requires non-empty source");
                const root = (0, eval)(src);
                reg.set(id, root);
                return { id };
            }
            if (op === "dispose") {
                reg.delete(id);
                return true;
            }

            if (!reg.has(id)) mkErr("HANDLE_INVALIDATED", "Handle disposed or invalidated");
            const root = reg.get(id);
            const unsupported = Symbol("handle-op-unsupported");
            const runRootOp = async (entry, options = {}) => {
                const opName = String(entry?.op || "");
                const path = entry?.path == null ? "" : String(entry.path);
                const args = Array.isArray(entry?.args) ? entry.args : [];
                const awaitCallResult = options.awaitCallResult === true;

                if (opName === "get") return resolve(root, path);
                if (opName === "set") {
                    const { parent, key } = resolveParent(root, path);
                    mustObjectLike(parent, path);
                    parent[key] = entry.value;
                    return null;
                }
                if (opName === "has") return resolveWithExistence(root, path).exists;
                if (opName === "delete") {
                    const { parent, key } = resolveParent(root, path);
                    mustObjectLike(parent, path);
                    return key in Object(parent) ? delete parent[key] : false;
                }
                if (opName === "keys") return toKeys(resolve(root, path));
                if (opName === "entries") return toEntries(resolve(root, path));
                if (opName === "getOwnPropertyDescriptor") {
                    const { parent, key } = resolveParent(root, path);
                    mustObjectLike(parent, path);
                    return Object.getOwnPropertyDescriptor(parent, key);
                }
                if (opName === "define") {
                    const { parent, key } = resolveParent(root, path);
                    mustObjectLike(parent, path);
                    Object.defineProperty(parent, key, entry.descriptor || {});
                    return true;
                }
                if (opName === "instanceOf") {
                    const ctor = resolve(globalThis, entry.constructorPath);
                    if (typeof ctor !== "function") mkErr("HANDLE_CTOR_INVALID", "constructorPath does not resolve to a function");
                    return root instanceof ctor;
                }
                if (opName === "isCallable") return typeof resolve(root, path) === "function";
                if (opName === "isPromise") return isPromiseLike(resolve(root, path));
                if (opName === "call") {
                    let result;
                    if (!path) {
                        if (typeof root !== "function") mkErr("HANDLE_NOT_CALLABLE", "Handle root is not callable");
                        result = withCallArgs(args, () => root(...args));
                    } else {
                        const { parent, key } = resolveParent(root, path);
                        mustObjectLike(parent, path);
                        const fn = parent[key];
                        if (typeof fn !== "function") mkErr("HANDLE_NOT_CALLABLE", \`Handle path is not callable: \${path}\`);
                        result = withCallArgs(args, () => fn.apply(parent, args));
                    }
                    if (awaitCallResult && isPromiseLike(result)) {
                        result = await Promise.resolve(result);
                    }
                    return result;
                }
                if (opName === "construct") {
                    if (typeof root !== "function") mkErr("HANDLE_NOT_CONSTRUCTABLE", "Handle root is not constructable");
                    return withCallArgs(args, () => new root(...args));
                }
                if (opName === "await") {
                    const returnValue = entry.returnValue !== false;
                    const untilNonPromise = entry.untilNonPromise === true;
                    const run = async () => {
                        if (!untilNonPromise) return await Promise.resolve(root);
                        let resolved = root;
                        for (let i = 0; i < 1024; i += 1) {
                            if (!isPromiseLike(resolved)) break;
                            const step = await awaitOne(resolved);
                            resolved = step.value;
                        }
                        if (isPromiseLike(resolved)) {
                            mkErr("HANDLE_AWAIT_MAX_DEPTH", "handle.await({ untilNonPromise: true }) exceeded max unwrap depth");
                        }
                        return resolved;
                    };
                    return run().then((resolved) => {
                        reg.set(id, resolved);
                        return returnValue ? resolved : undefined;
                    });
                }
                if (opName === "clone") {
                    const nextId = String(entry.nextId || "");
                    if (!nextId) mkErr("HANDLE_CLONE_ID_INVALID", "clone requires nextId");
                    reg.set(nextId, root);
                    return { id: nextId };
                }
                if (opName === "toJSON") return toJsonSnapshot(resolve(root, path));
                return unsupported;
            };
            if (op === "apply") {
                const items = Array.isArray(payload.ops) ? payload.ops : [];
                const out = [];
                const supported = new Set(["get", "set", "call", "has", "delete", "getType", "toJSON", "isCallable", "isPromise"]);
                for (const item of items) {
                    const opName = item && typeof item.op === "string" ? item.op : "";
                    if (!opName) mkErr("HANDLE_APPLY_OP_INVALID", "Invalid handle apply op");
                    if (!supported.has(opName)) {
                        mkErr("HANDLE_APPLY_OP_UNSUPPORTED", \`Unsupported apply op: \${opName}\`);
                    }
                    if (opName === "getType") {
                        out.push(typeInfo(resolve(root, item.path == null ? "" : item.path)));
                    } else {
                        out.push(await runRootOp(item, { awaitCallResult: true }));
                    }
                }
                return out;
            }
            if (op === "getType") return typeInfo(resolve(root, payload.path));

            const single = await runRootOp(payload, { awaitCallResult: false });
            if (single !== unsupported) return single;

            mkErr("HANDLE_OP_UNKNOWN", \`Unknown handle operation: \${op}\`);
        },
    };
    Object.defineProperty(api, "__denojs_worker_handle_api_v1", {
        value: true,
        enumerable: false,
        configurable: false,
        writable: false,
    });

    Object.defineProperty(globalThis, "${HANDLE_RUNTIME_KEY}", {
        value: api,
        configurable: false,
        enumerable: false,
        writable: false,
    });
    return true;
})()`;

export const HANDLE_RUNTIME_RUN_SOURCE = `(payload) => {
    const api = globalThis.${HANDLE_RUNTIME_KEY};
    if (!api || typeof api.run !== "function") {
        const e = new Error("Handle runtime bridge is not installed");
        e.code = "HANDLE_BRIDGE_MISSING";
        throw e;
    }
    return api.run(payload);
}`;

export const HANDLE_RUNTIME_CALL_SOURCE = `(id, path, ...args) => {
    const api = globalThis.${HANDLE_RUNTIME_KEY};
    if (!api || typeof api.run !== "function") {
        const e = new Error("Handle runtime bridge is not installed");
        e.code = "HANDLE_BRIDGE_MISSING";
        throw e;
    }
    return api.run({ op: "call", id, path, args });
}`;
