<div align="center">

# 🦕 Deno Director 🎬

**Run isolated Deno runtimes inside a Node.js process with explicit boundaries and practical controls.**

[![GitHub Repo stars](https://img.shields.io/github/stars/only-cliches/deno-director)](https://github.com/only-cliches/deno-director)
[![NPM Version](https://img.shields.io/npm/v/deno-director)](https://www.npmjs.com/package/deno-director)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)


</div>

**Orchestrate, sandbox, and bridge Deno runtimes directly within Node.js.**

Deno Director is a high-performance orchestration layer that allows you to spawn, manage, and communicate with embedded Deno V8 isolates from your Node.js applications. Whether you are building a multi-tenant edge compute platform, a plugin system, or need to run third-party code with explicit permissions and resource limits, Deno Director provides a seamless, type-safe, and highly tunable bridge between runtimes.

---

## 🚀 Why Deno Director?

* **Explicit Sandboxing:** Control what each runtime can access with fine-grained limits on memory, CPU time, file system (`read`/`write`), and network (`net`).
* **TypeScript & JSX Support:** Evaluate `.ts`, `.tsx`, and `.jsx` sources. Deno Director handles AST parsing and transpilation, with optional caching for loader paths that use a cache directory.
* **High-Fidelity Bridging:** Stop fighting with `JSON.stringify`. Naturally pass complex JavaScript types across the runtime boundary, including `Map`, `Set`, `Date`, `RegExp`, `Error`, `ArrayBuffer`, and `Uint8Array`.
* **Flow-Controlled Streams:** Built-in support for bi-directional binary streaming between Node and Deno using native Node `Duplex` streams.
* **Node.js & CJS Interop:** Enable `nodeJs` compatibility to let your sandboxed code resolve `node_modules` and execute CommonJS code inside an ESM facade.
* **Live Telemetry & Observability:** Built-in APIs to monitor CPU usage, event loop lag, operation latency, and V8 heap statistics per worker.
* **Dynamic Import Control:** Intercept and rewrite dynamic imports on the fly using custom `imports` callback policies.

---

## 📦 Installation

```bash
npm install deno-director
```

Deno Director builds a native addon during install, so the host needs a working Rust toolchain (`cargo`) in addition to Node.js/npm.

---

## ⚡ Quick Start

Create a worker and execute TypeScript in milliseconds.

```typescript
import { DenoWorker } from "deno-director";

// 1. Initialize a worker
const worker = new DenoWorker({
    permissions: {
        net: ["api.github.com"], // Only allow requests to GitHub
        read: false,             // Block file system reads
        write: false             // Block file system writes
    },
    limits: {
        maxEvalMs: 500,          // Timeout execution after 500ms
        maxMemoryBytes: 64 * 1024 * 1024 // Cap memory at 64MB
    }
});

// 2. Evaluate TypeScript directly
const result = await worker.eval(`
    const fetchRepo = async (user: string): Promise<string> => {
        return \`Fetching data for \${user}...\`;
    };
    fetchRepo("denoland");
`, { srcLoader: "ts" });

console.log(result); // "Fetching data for denoland..."

// 3. Clean up
await worker.close();
```

---

## 🧠 Core Concepts

### 1. The Director (`DenoDirector`)
The central orchestrator. It manages the lifecycle of multiple runtimes, assigns unique IDs, and allows you to query active workers via custom labels and tags.

### 2. The Worker (`DenoWorker`)
A single, isolated Deno V8 instance. It exposes APIs for evaluation (`eval`, `evalSync`, `module.eval`), messaging (`postMessage`), streaming, and environment variable injection.

### 3. Templates (`DenoWorkerTemplate`)
If you need to spin up dozens of identical isolates, create a template. Templates define baseline configurations, globals, and bootstrap scripts that are automatically applied to every worker spawned from them.

---

## 🛡️ Dynamic Import Control

When running third-party or untrusted code, you often need strict control over what dependencies that code can pull in. The `imports` property on the worker configuration object allows you to define exactly how module resolution behaves inside the sandbox.

It accepts two kinds of values: a **boolean** (`true` or `false`) or a highly flexible **callback function**.

### 1. The Simple Switch (Boolean)

If you want to outright ban or permit all module loading, you can use a simple boolean:

* **`imports: false`** (Default): Completely disables all imports (`import ...` or `await import(...)`). Any attempt to load a module will immediately throw an error.
* **`imports: true`**: Allows standard disk and remote module resolution, governed by your `permissions` (like `read`, `import`, and `net`) and `moduleLoader` scheme settings (`httpsResolve` / `httpResolve`).

For remote URL imports, enable both the scheme in `moduleLoader` and the matching permissions. For example: `moduleLoader: { httpsResolve: true }` with `permissions: { import: true, net: true }`.

### 2. The Callback (Dynamic Interception)

Passing a callback function to `imports` unlocks the ability to intercept, rewrite, or mock *every single import* requested by the Deno runtime, right from your Node.js host.

The callback receives the requested `specifier`, the `referrer` (the file asking for the import), and a boolean flag indicating if it was a dynamic `import()`.

You can return (or resolve a Promise to) several different shapes depending on what you want to do:

#### A. Blocking Specific Domains
Return `true` to allow the import or `false` to block it.

```typescript
const worker = new DenoWorker({
    moduleLoader: { httpsResolve: true },
    permissions: { import: true, net: true },
    imports: (specifier, referrer, isDynamic) => {
        // Block any imports from untrusted-cdn.com
        if (specifier.startsWith("https://untrusted-cdn.com")) {
            console.warn(`Blocked import from ${referrer}`);
            return false;
        }
        return true; // Let Deno handle the rest normally
    }
});
```

#### B. Rewriting/Redirecting Imports
You can seamlessly swap out dependencies on the fly by returning `{ resolve: string }`. This is incredibly useful for mapping bare specifiers to specific URLs or injecting secure versions of libraries.

```typescript
const worker = new DenoWorker({
    moduleLoader: { httpsResolve: true },
    permissions: { import: true, net: true },
    imports: (specifier) => {
        // Transparently reroute 'lodash' to a specific ESM CDN URL
        if (specifier === "lodash") {
            return { resolve: "https://esm.sh/lodash@4.17.21" };
        }
        return true;
    }
});
```

#### C. Injecting Virtual Modules
You don't even need the file to exist on disk or the web. You can return raw source code directly from Node.js into the Deno isolate using the `{ src: string, srcLoader?: string }` shape (or just a raw string, which defaults to `"js"`).

```typescript
const worker = new DenoWorker({
    imports: async (specifier) => {
        // Provide a synthetic config module on demand
        if (specifier === "app://config.ts") {
            // Fetch live config from a Node.js database
            const dbConfig = await fetchTenantConfigFromMongo();

            return {
                src: `export const config = ${JSON.stringify(dbConfig)};`,
                srcLoader: "ts" // Tell Deno Director to transpile this as TypeScript
            };
        }
        return true;
    }
});

// Inside Deno:
await worker.eval(`
    import { config } from "app://config.ts";
    console.log("Loaded dynamic config:", config);
`);
```

#### Why this is useful

By combining the imports callback with sourceLoaders, you can create a completely synthetic, database-backed file system for your Deno isolates. You can serve code dynamically based on the current user, enforce strict dependency pinning, or inject host-provided mocks without writing a single file to disk.


## High-Performance Binary Streams
Need to pipe large amounts of data between Node and Deno? Deno Director creates Node `Duplex` streams over native bridge IPC, complete with backpressure and credit-based flow control. Experimental shared-memory transport is available as an opt-in mode.

```typescript
// Node.js side
const duplexStream = await worker.stream.connect("my-data-lane");
fs.createReadStream("large-video.mp4").pipe(duplexStream);

// Deno side (inside the worker)
await worker.eval(`
    const reader = await hostStreams.accept("my-data-lane");
    for await (const chunk of reader) {
        // Process Uint8Array chunk
    }
`);
```

## Runtime Handles (Pointers)
Keep state inside the Deno isolate and manipulate it from Node without copying large objects back and forth. Handles act as remote pointers to V8 objects.

```typescript
// Create a complex object in Deno and get a handle to it
const myHandle = await worker.handle.eval(`
    new Map([["status", "active"], ["retries", 0]])
`);

// Manipulate the Deno object directly from Node
await myHandle.call("set", ["retries", 1]);
const status = await myHandle.get("status");

// Cleanup memory to avoid leaks in the isolate
await myHandle.dispose();
```

## Node.js & CommonJS Interop
Legacy code doesn't have to be a blocker. Deno Director can synthesize ESM facades for CommonJS code and allow module resolution of local `node_modules`.

```typescript
const worker = new DenoWorker({
    nodeJs: {
        modules: true,     // use Node.js-style module resolution for ESM imports.
        cjsInterop: true,  // enable CJS modules
        runtime: true      // enable Node runtime behavior
    }
});

const workerWithAllNodeCompat = new DenoWorker({
    // shorthand for { modules: true, runtime: true, cjsInterop: true }
    nodeJs: true
});
```

### Real-Time Telemetry & Observability
Monitor resource use, latency, and runtime health so problematic code is visible before it affects the host process.

```typescript
// Measure CPU usage over the next 1000ms
const cpuStats = await worker.stats.cpu({ measureMs: 1000 });
console.log(`CPU Usage: ${cpuStats.usagePercentage}%`);

// Check V8 Heap statistics
const memory = await worker.stats.memory();
console.log(`Heap Used: ${memory.heapStatistics.usedHeapSize} bytes`);

// Measure Event Loop Lag
const lag = await worker.stats.eventLoopLag({ measureMs: 100 });
console.log(`Event Loop Lag: ${lag.lagMs}ms`);
```

---

## 📚 API Reference

### Orchestration: `DenoDirector`
The `DenoDirector` class is the central orchestrator for spawning and tracking multiple isolated runtimes.

* **`new DenoDirector(options?: DenoDirectorOptions)`**: Initializes the director, optionally with a default template.
* **`start(options?: DenoDirectorStartOptions): Promise<DenoDirectedRuntime>`**: Spawns a new worker with an auto-generated or explicitly provided `id`, `label`, and `tags`.
* **`get(id: string): DenoDirectedRuntime | undefined`**: Looks up a runtime by its exact identifier.
* **`getByLabel(label: string): DenoDirectedRuntime[]`**: Returns an array of runtimes matching the provided label.
* **`list(filter?: DenoDirectorListOptions): DenoDirectedRuntime[]`**: Lists managed runtimes, optionally filtering by `label` and/or `tag`.
* **`setLabel(runtimeOrId: DenoDirectedRuntime | string, label?: string): boolean`**: Updates a runtime's label.
* **`setTags(runtimeOrId: DenoDirectedRuntime | string, tags: string[]): boolean`**: Replaces all tags for a specific runtime.
* **`addTag(runtimeOrId: DenoDirectedRuntime | string, tag: string): boolean`**: Adds a tag to a runtime if it is not already present.
* **`removeTag(runtimeOrId: DenoDirectedRuntime | string, tag: string): boolean`**: Removes a tag from a runtime.
* **`stop(runtimeOrId: DenoDirectedRuntime | string): Promise<boolean>`**: Gracefully closes a specific runtime and unregisters it.
* **`stopByLabel(label: string): Promise<number>`**: Stops all runtimes matching a specific label, returning the count of stopped runtimes.
* **`stopAll(): Promise<number>`**: Stops all runtimes managed by the director.

---

### Templating: `DenoWorkerTemplate`
Reusable templates capture shared runtime defaults to be applied to multiple instances.

* **`new DenoWorkerTemplate(options?: DenoWorkerTemplateOptions)`**: Initializes a template with baseline `workerOptions`, `globals`, `bootstrapScripts`, `bootstrapModules`, and a `setup` hook.
* **`create(createOptions?: DenoWorkerTemplateCreateOptions): Promise<DenoWorker>`**: Creates a new runtime instance, shallow-merging the template's options with any per-create overrides.

---

### The Runtime: `DenoWorker`
The core runtime instance.

#### Base Properties & Methods
* **`readonly id: string`**: The stable host-side worker ID.
* **`readonly inspectPort?: number`**: The actual bound inspector port (if debugging is enabled).
* **`isClosed(): boolean`**: Returns `true` if the runtime is closed or closing.
* **`close(options?: DenoWorkerCloseOptions): Promise<void>`**: Gracefully shuts down the runtime. Passing `{ force: true }` issues an immediate, best-effort native close.
* **`restart(options?: DenoWorkerRestartOptions): Promise<void>`**: Restarts the runtime in-place using original creation options, keeping event listeners attached.
* **`gc(): Promise<void>`**: Asks the native V8 isolate to perform a best-effort garbage collection cycle.

#### Evaluation
* **`eval<T = any>(src: string, options?: EvalOptions): Promise<T>`**: Evaluates script source asynchronously.
* **`evalSync<T = any>(src: string, options?: EvalOptions): T`**: Evaluates script source synchronously, blocking the Node event loop.

#### Messaging & Events
* **`postMessage(msg: any): void`**: Posts a payload to the runtime's `onmessage` listeners.
* **`postMessages(msgs: any[]): number`**: Batches multiple messages, returning the number accepted.
* **`tryPostMessage(msg: any): boolean`**: Best-effort enqueue; returns `false` instead of throwing if closed.
* **`tryPostMessages(msgs: any[]): number`**: Best-effort batch enqueue.
* **`on(event: DenoWorkerEvent, cb: Function): void`**: Subscribe to `"message"`, `"close"`, `"lifecycle"`, `"runtime"`, or `"error"` events.
* **`off(event: DenoWorkerEvent, cb?: Function): void`**: Unsubscribe from events. Omit the callback to clear all listeners for the event.

---

### Namespace: `worker.stream`
High-performance byte streaming APIs.

* **`connect(key: string, options?: DenoWorkerStreamConnectOptions): Promise<Duplex>`**: Connects a bidirectional stream pair under a key and returns a Node.js `Duplex` stream.
* **`create(key?: string): DenoWorkerStreamWriter`**: Creates a low-level writer. Returns an object with:
    * `getKey(): string`
    * `ready(minBytes?: number): Promise<void>`
    * `write(chunk: Uint8Array | ArrayBuffer): Promise<void>`
    * `writeMany(chunks: Array<Uint8Array | ArrayBuffer>): Promise<number>`
    * `close(): Promise<void>`
    * `error(message: string): Promise<void>`
    * `cancel(reason?: string): Promise<void>`
* **`accept(key: string): Promise<DenoWorkerStreamReader>`**: Accepts an incoming reader. Returns an async iterable object with:
    * `read(): Promise<IteratorResult<Uint8Array>>`
    * `cancel(reason?: string): Promise<void>`

---

### Namespace: `worker.handle`
Manage explicit lifetime pointers to V8 objects.

* **`get(path: string, options?: DenoWorkerHandleExecOptions): Promise<DenoWorkerHandle>`**: Creates a handle rooted at `globalThis[path]`.
* **`tryGet(path: string, options?): Promise<DenoWorkerHandle | undefined>`**: Best-effort variant that returns `undefined` if the path doesn't exist.
* **`eval(source: string, options?): Promise<DenoWorkerHandle>`**: Evaluates code and returns a handle to the result.

#### Interface: `DenoWorkerHandle`
Once you have a handle, you can call these methods to manipulate it:
* **`readonly id: string`** / **`readonly rootType: DenoWorkerHandleTypeInfo`** / **`readonly disposed: boolean`**.
* **`get<T>(path?: string, options?): Promise<T>`**
* **`has(path: string, options?): Promise<boolean>`**
* **`set(path: string, value: any, options?): Promise<void>`**
* **`delete(path: string, options?): Promise<boolean>`**
* **`keys(path?: string, options?): Promise<any[]>`**
* **`entries(path?: string, options?): Promise<any[]>`**
* **`getOwnPropertyDescriptor(path: string, options?): Promise<PropertyDescriptor | undefined>`**
* **`define(path: string, descriptor: PropertyDescriptor, options?): Promise<boolean>`**
* **`instanceOf(constructorPath: string, options?): Promise<boolean>`**
* **`isCallable(path?: string, options?): Promise<boolean>`**
* **`isPromise(path?: string, options?): Promise<boolean>`**
* **`call<T>(argsOrPath?: any[] | string, args?: any[], options?): Promise<T>`**: Calls the handle itself or a nested path.
* **`construct<T>(args?: any[], options?): Promise<T>`**
* **`await<T>(options?: DenoWorkerHandleAwaitOptions): Promise<T>`**: Awaits a promise-like root value.
* **`clone(options?): Promise<DenoWorkerHandle>`**: Clones the handle to a new reference ID.
* **`toJSON<T>(path?: string, options?): Promise<T>`**
* **`apply<T>(ops: DenoWorkerHandleApplyOp[], options?): Promise<T>`**: Applies a sequence of operations in a single runtime roundtrip.
* **`getType(path?: string, options?): Promise<DenoWorkerHandleTypeInfo>`**
* **`dispose(options?): Promise<void>`**: Releases the handle to prevent memory leaks.

---

### Namespace: `worker.global`
Directly manipulates properties on `globalThis`. *It mirrors the methods found on `DenoWorkerHandle` exactly, but operates on the global scope context.*

* **`set(path: string, value: any, options?): Promise<void>`**
* **`get<T>(path: string, options?): Promise<T>`**
* **`has(path: string, options?): Promise<boolean>`**
* **`delete(path: string, options?): Promise<boolean>`**
* **`keys(path?: string, options?): Promise<any[]>`**
* **`entries(path?: string, options?): Promise<any[]>`**
* **`getOwnPropertyDescriptor(path: string, options?): Promise<PropertyDescriptor | undefined>`**
* **`define(path: string, descriptor: PropertyDescriptor, options?): Promise<boolean>`**
* **`isCallable(path?: string, options?): Promise<boolean>`**
* **`isPromise(path?: string, options?): Promise<boolean>`**
* **`call<T>(path: string, args?: any[], options?): Promise<T>`**
* **`construct<T>(path: string, args?: any[], options?): Promise<T>`**
* **`await<T>(path: string, options?): Promise<T>`**
* **`clone(path: string, options?): Promise<DenoWorkerHandle>`**
* **`toJSON<T>(path?: string, options?): Promise<T>`**
* **`apply<T>(path: string, ops: DenoWorkerHandleApplyOp[], options?): Promise<T>`**
* **`getType(path?: string, options?): Promise<DenoWorkerHandleTypeInfo>`**
* **`instanceOf(path: string, constructorPath: string, options?): Promise<boolean>`**

---

### Namespace: `worker.module`
Interact with Deno's ESM module loader.

* **`import<T>(specifier: string): Promise<T>`**: Imports a module via the runtime pipeline.
* **`eval<T>(source: string, options?: DenoWorkerModuleEvalOptions): Promise<T>`**: Evaluates source as an ESM module, optionally synthesizing CJS interop, returning namespace exports.
* **`register(moduleName: string, source: string, options?): Promise<void>`**: Caches source code under a stable module name.
* **`clear(moduleName: string): Promise<boolean>`**: Evicts a registered module.

---

### Namespaces: `worker.cwd` & `worker.env`
* **`cwd.get(): Promise<string>`**: Returns current worker sandbox directory.
* **`cwd.set(path: string): Promise<string>`**: Updates the sandbox root and restarts the worker.
* **`env.get(key: string): Promise<string | undefined>`**: Reads an environment variable.
* **`env.set(key: string, value: string): Promise<void>`**: Sets an environment variable.

---

### Namespace: `worker.stats`
Lightweight observability telemetry.

* **`readonly activeOps: number`**: Tracked in-flight wrapper promises.
* **`readonly lastExecution: ExecStats`**: Snapshot from the native runtime containing `cpuTimeMs` and `evalTimeMs`.
* **`readonly stream: DenoWorkerStreamStats`**: Returns metrics like `activeStreams`, `queuedChunks`, and `creditDebtBytes`.
* **`readonly totals: DenoWorkerTotalsStats`**: Cumulative counts for `ops`, `errors`, `restarts`, `messagesOut/In`, and `bytesOut/In`.
* **`cpu(options?: DenoWorkerCpuOptions): Promise<DenoWorkerCpuStats>`**: Computes `usagePercentage` over a given `measureMs` window.
* **`rates(options?: DenoWorkerRatesOptions): Promise<DenoWorkerRatesStats>`**: Computes operations per second for evals, handles, globals, and messages.
* **`latency(options?: DenoWorkerRatesOptions): Promise<DenoWorkerLatencyStats>`**: Computes `avgMs`, `p50Ms`, `p95Ms`, `p99Ms`, and `maxMs` latency.
* **`eventLoopLag(options?: DenoWorkerEventLoopLagOptions): Promise<DenoWorkerEventLoopLagStats>`**: Measures host event loop lag.
* **`memory(): Promise<DenoWorkerMemory>`**: Fetches V8 `heapStatistics` and `heapSpaceStatistics`.
* **`reset(options?: DenoWorkerStatsResetOptions): void`**: Clears rolling samples.

---

### Configuration: `DenoWorkerOptions`

Passed during worker creation.

* **`limits`**:
    * `maxHandle`: Maximum allowed active handles (default: 128).
    * `maxEvalMs` / `maxCpuMs`: Execution and CPU-budget timeouts.
    * `maxMemoryBytes`: V8 heap size limit.
* **`bridge`**:
    * `channelSize`: Queue capacity for IPC channels (default: 512).
    * `streamWindowBytes`: Flow-control window size (default: 16MiB).
    * `streamCreditFlushBytes`: Consumed bytes before triggering a credit replenishment (default: 256KiB).
    * `streamBacklogLimit`: Unaccepted stream queue limit (default: 256).
    * `streamHighWaterMarkBytes`: Reader high-water mark limit.
    * `enableUnsafeStreamMemory`: Enable experimental shared-memory streaming (default: false).
* **`permissions`**: Sandboxing rules. Accepts a boolean or an object with boolean/string-array constraints for `read`, `write`, `net`, `env`, `run`, `ffi`, `sys`, `import`, `hrtime`, and `wasm`.
* **`imports`**: Boolean or `ImportsCallback` to govern dynamic import behavior.
* **`moduleLoader`**: Remote resolution configuration: `httpsResolve`, `httpResolve`, `jsrResolve`, `allowOutsideCwd`, `cacheDir`, `reload`, `maxPayloadBytes`.
* **`nodeJs`**: Node interoperability configuration: `modules` (resolution), `runtime` (globals), `cjsInterop` (CommonJS execution), and `cjsForcePaths` (overrides).
* **`sourceLoaders`**: Array of `DenoLoaderTransform` callbacks to transform source files before they reach the V8 parser.
* **`tsCompiler`**: Controls JSX parsing (`"react"`, `"react-jsx"`, `"react-jsxdev"`, `"preserve"`) and factory flags.
* **`console`**: Configures console routing (`false`, host `Console`, or per-method function hooks).
* **`cwd`**: Explicit sandbox directory path.
* **`env`** / **`envFile`**: Map of environment variables, or path to a `.env` file to seed.
* **`globals`**: Initial host values mapped directly to `globalThis` on startup.
* **`modules`**: Pre-registered source modules mapped to specifiers.
* **`lifecycle`**: Event hooks for `beforeStart`, `afterStart`, `beforeStop`, `afterStop`, and `onCrash`.
* **`inspect`**: Enable V8 inspector with `host`, `port`, and `break`.
