# deno-director
Run Deno Core runtimes inside Node.js, with first-class bridging in both directions.

## Why this exists
### Problem it solves
Modern Node apps often need to execute dynamic code (plugins, rules, tenant code, generated code) without turning the host process into a giant unsafe shared runtime. `deno-director` gives you a way to run that code with stronger boundaries while keeping your existing Node architecture.

### What this solves technically
`deno-director` runs Deno runtimes inside Node with a direct API for:

- isolated execution contexts
- controlled imports (including virtual modules)
- bidirectional function bridging (Node <-> Deno)
- runtime lifecycle management (`restart`, `force close`, hooks)
- multi-runtime orchestration (`DenoWorkerTemplate`, `DenoDirector`)

### Where it fits vs `vm` / `worker_threads`
- vs `vm`: gives you Deno runtime semantics and import/permission controls, not just JavaScript context separation.
- vs raw `worker_threads`: gives you a higher-level execution model and bridge protocol out of the box.
- vs hand-rolled RPC bridges: built-in host-function hydration and module/function invocation patterns reduce custom glue code.

### Real production use cases
- plugin platforms running third-party or team-owned extensions
- policy/rules engines evaluating customer-defined logic
- multi-tenant execution where tenant state must stay isolated
- AI/tool systems executing generated scripts with explicit runtime controls
- gradual adoption paths where Node remains host and Deno handles isolated execution workloads

## Quick Start
Super high-level flow: install, create a worker, run code, and bridge both directions.

```bash
npm install deno-director
```

### 1) Create a worker and run code
```ts
import { DenoWorker } from "deno-director";

const dw = new DenoWorker();

console.log(await dw.eval("1 + 1")); // 2
console.log(dw.evalSync("6 * 7")); // 42

await dw.close();
```

### 2) Node -> Deno: call exported module functions
```ts
import { DenoWorker } from "deno-director";

const dw = new DenoWorker();

const math = await dw.evalModule(`
  export const version = "1.0.0";
  export function add(a, b) { return a + b; }
  export async function addAsync(a, b) { return a + b; }
`);

console.log(math.version); // "1.0.0"
console.log(math.add(2, 3)); // 5
console.log(await math.addAsync(20, 22)); // 42

await dw.close();
```

### 3) Deno -> Node: inject host functions
```ts
import { DenoWorker } from "deno-director";

const dw = new DenoWorker();

await dw.setGlobal("triple", (n: number) => n * 3);
await dw.setGlobal("loadUser", async (id: string) => ({ id, name: "Ada" }));

const out = await dw.eval(`
  (async () => {
    const n = triple(14);
    const user = await loadUser("u_1");
    return { n, user };
  })()
`);

console.log(out); // { n: 42, user: { id: "u_1", name: "Ada" } }

await dw.close();
```

### 4) Virtual module quick example
```ts
import { DenoWorker } from "deno-director";

const dw = new DenoWorker({
  permissions: { import: true },
  imports: (specifier) => {
    // provide source code
    if (specifier === "virtual:config") {
      return { js: `export const appName = "director";` };
    }
    // block all other modules from loading
    return false;
  },
});

const mod = await dw.evalModule(`
  import { appName } from "virtual:config";
  export const out = appName;
`);

console.log(mod.out); // "director"
await dw.close();
```

### 5) Constructor globals (values, functions, nested objects, modules)
```ts
import * as fs from "node:fs";
import { DenoWorker } from "deno-director";

const dw = new DenoWorker({
  globals: {
    value: 22,
    nested: { key: true },
    someFn: (x: number) => x + 1,
    anotherFn: async (x: number) => x + 2,
    fs, // module object injection works too
  },
});

console.log(await dw.eval("value")); // 22
console.log(await dw.eval("nested.key")); // true
console.log(await dw.eval("someFn(41)")); // 42
console.log(await dw.eval("(async () => await anotherFn(40))()")); // 42
console.log(await dw.eval(`fs.readFileSync("/etc/hosts", "utf8").length > 0`)); // true

await dw.close();
```

### 6) Console routing + runtime env configuration
```ts
import { DenoWorker } from "deno-director";

const dw = new DenoWorker({
  // Route worker console output into Node handlers.
  console: {
    log: (...args) => console.log("[worker:log]", ...args),
    error: (...args) => console.error("[worker:error]", ...args),
    debug: false, // disable console.debug in the worker
  },

  // Runtime env map (inside Deno runtime).
  env: {
    APP_ENV: "dev",
    API_URL: "https://example.com",
  },
});

await dw.eval(`console.log("hello");`);
console.log(await dw.eval("Deno.env.get('APP_ENV')")); // "dev"

await dw.close();
```

Note: async console handlers are fire-and-forget. For real-time streaming output during long evals/benchmarks, prefer synchronous handlers (or call your sink before the first `await`).

## Major Features

### 1) Virtual Modules (`imports` callback)
<details>
<summary>How it works + usage</summary>

Use the `imports` callback to intercept import requests and return in-memory module source.

```ts
import { DenoWorker } from "deno-director";

const dw = new DenoWorker({
  permissions: { import: true },
  imports: (specifier) => {
    if (specifier === "virtual:config") {
      return {
        js: `export const env = "dev"; export const retries = 3;`,
      };
    }
    return false; // block anything else (or return true to allow default disk resolution)
  },
});

const result = await dw.evalModule(`
  import { env, retries } from "virtual:config";
  export const out = \`\${env}:\${retries}\`;
`);

console.log(result.out); // "dev:3"
await dw.close();
```

What to know about the `imports` callback:

- Return `false` to block an import.
- Return `true` to allow default resolution on disk.
- Return `{ js | ts | tsx | jsx }` to provide source in memory.
- Return `{ resolve: "..." }` to rewrite to another module name.

</details>

### 2) Call Deno Module Functions from Node
<details>
<summary>How it works + usage</summary>

`evalModule(...)` returns a namespace object. Exported functions can be called directly from Node.

```ts
import { DenoWorker } from "deno-director";

const dw = new DenoWorker();

const mod = await dw.evalModule(`
  export const version = "1.0.0";
  export function sum(a, b) { return a + b; }
  export async function slowDouble(n) {
    await Promise.resolve();
    return n * 2;
  }
`);

console.log(mod.version); // "1.0.0"
console.log(mod.sum(20, 22)); // 42
console.log(await mod.slowDouble(21)); // 42

await dw.close();
```

You can also use default exports:

```ts
const mod = await dw.evalModule(`
  export default function multiply(a, b) { return a * b; }
`);

console.log(mod.default(6, 7)); // 42
```

</details>

### 3) Create Node Functions Callable from Deno
<details>
<summary>How it works + usage</summary>

Inject host functions with `setGlobal`, then call/await them inside Deno.

```ts
import { DenoWorker } from "deno-director";

const dw = new DenoWorker();

await dw.setGlobal("double", (n: number) => n * 2);
await dw.setGlobal("fetchUser", async (id: string) => {
  return { id, name: "Ada" };
});

const out = await dw.eval(`
  (async () => {
    const n = double(21);
    const user = await fetchUser("u_123");
    return { n, user };
  })()
`);

console.log(out); // { n: 42, user: { id: "u_123", name: "Ada" } }
await dw.close();
```

If a Node function throws, the error is propagated back through `eval(...)`.  The same is true the other way.
```ts
import { DenoWorker } from "deno-director";

const dw = new DenoWorker({
    console: false // ignore all console.* calls
    console: console
});


```
</details>

### 4) Runtime Templates and Orchestration
<details>
<summary>How it works + usage</summary>

Use `DenoWorkerTemplate` for reusable runtime defaults and `DenoDirector` to manage multiple runtimes with ids/labels/tags.

```ts
import { DenoDirector } from "deno-director";

const director = new DenoDirector({
  template: {
    workerOptions: {
      permissions: { env: true },
    },
    globals: { APP_NAME: "director-demo" },
  },
});

const a = await director.start({ label: "tenant-a", tags: ["billing"] });
const b = await director.start({ label: "tenant-b", tags: ["analytics"] });

console.log(await a.eval("APP_NAME")); // "director-demo"
console.log(director.list({ tag: "billing" }).length); // 1

await director.stopAll();
```

</details>

## API Reference

### `DenoWorker`
Create and control a single Deno runtime.

Constructor:

```ts
const dw = new DenoWorker(options?);
```

Common options:

- `imports`: `boolean | (specifier, referrer?, isDynamicImport?) => result`
- `permissions`: Deno-style permissions (`read`, `write`, `net`, `env`, `run`, `ffi`, `sys`, `import`, `hrtime`)
- `cwd`: runtime working directory
- `maxEvalMs`, `maxMemoryBytes`, `maxStackSizeBytes`, `channelSize`
- `nodeResolve`, `nodeCompat`
- `console`
- `console`: `false`, `Console`, or per-method handlers (`log/info/warn/error/debug/trace`)
- `env`: runtime env config (`string dotenv path` or `Record<string,string>`)
- `envFile`: `true` (search `.env` upward from `cwd`) or explicit dotenv path
- `inspect`
- `moduleLoader` (`denoRemote`, `transpileTs`, `tsCompiler`, `cacheDir`, `reload`)
- `globals` (inject startup globals/functions into `globalThis`)
- `lifecycle` hooks (`beforeStart`, `afterStart`, `beforeStop`, `afterStop`, `onCrash`)

Methods:

- `await dw.eval(source, options?)`: async evaluate script/module source.
- `dw.evalSync(source, options?)`: sync (blocking) evaluate source.
- `await dw.evalModule(source, options?)`: evaluate ES module source, return namespace object.
- `await dw.setGlobal(name, value)`: set `globalThis[name]` inside runtime.
- `dw.postMessage(msg)`: enqueue message to runtime.
- `dw.tryPostMessage(msg)`: same as `postMessage`, but returns `false` on enqueue failure.
- `dw.on(event, handler)`: subscribe to `"message" | "close" | "lifecycle"`.
- `dw.off(event, handler?)`: unsubscribe one handler or all handlers for event.
- `dw.isClosed()`: runtime closed/closing status.
- `await dw.memory()`: runtime V8 heap stats.
- `dw.lastExecutionStats`: `{ cpuTimeMs?, evalTimeMs? }`: Execution cost of the last eval/evalSync
- `await dw.restart(options?)`: restart runtime in-place.
- `await dw.close(options?)`: close runtime.

Startup note:

- Constructor `globals` are applied asynchronously during startup.
- Async APIs (`eval`, `evalModule`, `setGlobal`, `memory`) wait for startup globals automatically.
- `evalSync` throws if called before constructor globals finish initializing.

Console and env notes:

- `console` lets you disable methods or route them to host handlers.
- `console: false` disables runtime `console.*` methods.
- `console: console` forwards runtime logs directly to the host console object.
- `env` config applies to the runtime’s `Deno.env`.
- `env` overrides `envFile` when both are provided.

```ts
const off = new DenoWorker({ console: false });
const passthrough = new DenoWorker({ console: console });
```

Env permission note:

- To read runtime env from evaluated code (`Deno.env.get`, `Deno.env.toObject`), enable env permission.
- Use `permissions: { env: true }` to allow all env keys, or `permissions: { env: ["APP_ENV", "TOKEN"] }` for an allow-list.
- Without env permission, env API access is denied even if `env`/`envFile` is configured.

Minimal example:

```ts
const dw = new DenoWorker({ maxEvalMs: 500 });
await dw.setGlobal("double", (n: number) => n * 2);
console.log(await dw.eval("double(21)")); // 42
await dw.close();
```

### `DenoWorkerTemplate`
Reusable runtime blueprint (shared options, globals, bootstraps, setup).

Constructor:

```ts
const template = new DenoWorkerTemplate({
  workerOptions: { permissions: { env: true } },
  globals: { APP_NAME: "director" },
  bootstrapScripts: "globalThis.VERSION = 1;",
});
```

Methods:

- `await template.create(createOptions?)`: create a new `DenoWorker` from template defaults + per-runtime overrides.

Example:

```ts
const runtime = await template.create({
  globals: { TENANT: "a" },
});
console.log(await runtime.eval("`${APP_NAME}:${TENANT}`")); // "director:a"
await runtime.close();
```

### `DenoDirector`
Orchestrate multiple runtimes with metadata (`id`, `label`, `tags`).

Constructor:

```ts
const director = new DenoDirector({
  template: {
    workerOptions: { permissions: { env: true } },
  },
});
```

Methods:

- `await director.start(options?)`: start managed runtime, returns `runtime` with `runtime.meta`.
- `director.get(id)`: get runtime by id.
- `director.getByLabel(label)`: get runtimes by label.
- `director.list(filter?)`: list runtimes, optionally by `label` and/or `tag`.
- `director.setLabel(runtimeOrId, label?)`
- `director.setTags(runtimeOrId, tags)`
- `director.addTag(runtimeOrId, tag)`
- `director.removeTag(runtimeOrId, tag)`
- `await director.stop(runtimeOrId)`
- `await director.stopByLabel(label)`
- `await director.stopAll()`

Example:

```ts
const a = await director.start({ id: "rt-a", label: "tenant-a", tags: ["billing"] });
const b = await director.start({ label: "tenant-b", tags: ["analytics"] });

console.log(a.meta.id); // "rt-a"
console.log(director.list({ tag: "billing" }).length); // 1

await director.stopAll();
```

### `Eval` options
Used by `eval`, `evalSync`, and `evalModule`.

- `filename`: virtual filename in stack traces
- `type`: `"script"` or `"module"`
- `args`: positional args (if source evaluates to a function, runtime will call it with these args)
- `maxEvalMs`: per-call timeout override

Example:

```ts
const out = await dw.eval("(a, b) => a + b", { args: [20, 22], maxEvalMs: 1000 });
console.log(out); // 42
```

## Recipes

### 1) Per-call timeout for untrusted code
```ts
const dw = new DenoWorker({ maxEvalMs: 250 });

// Global maxEvalMs is 250, but this call gets 2s.
const result = await dw.eval("while (Date.now() < Date.now() + 10) {}", {
  maxEvalMs: 2000,
});
```

### 2) Force-close when work is stuck
```ts
const dw = new DenoWorker();

const pending = dw.eval(`
  (async () => {
    await new Promise(() => {}); // never resolves
  })()
`);

await dw.close({ force: true });
await pending.catch((err) => console.error("rejected:", err.message));
```

### 3) Restart a runtime in place
```ts
const dw = new DenoWorker();

await dw.eval("globalThis.counter = 10");
await dw.restart();

console.log(await dw.eval("typeof globalThis.counter")); // "undefined"
```

### 4) Constructor globals pattern
```ts
const dw = new DenoWorker({
  globals: {
    apiBase: "https://example.com",
    add: (a: number, b: number) => a + b,
  },
});

console.log(await dw.eval("apiBase")); // "https://example.com"
console.log(await dw.eval("add(20, 22)")); // 42
```

### 5) Console routing pattern
```ts
const dw = new DenoWorker({
  console: {
    log: (...args) => hostLogger.info(args),
    warn: (...args) => hostLogger.warn(args),
    error: (...args) => hostLogger.error(args),
    debug: false,
  },
});
```

```ts
const disabled = new DenoWorker({ console: false });
const forwarded = new DenoWorker({ console: console });
```

Use synchronous console handlers when you need immediate output. Async handlers are not awaited by worker `console.*` calls.

### 6) Runtime env pattern (`env` + `envFile`)
```ts
const dwA = new DenoWorker({
  permissions: { env: true },
  env: { APP_ENV: "test", TOKEN: "abc123" },
});

const dwB = new DenoWorker({
  cwd: "/srv/app",
  permissions: { env: ["APP_ENV", "TOKEN"] },
  envFile: true, // find .env upward from cwd
});

const dwC = new DenoWorker({
  envFile: "/srv/app/.env",
  env: { APP_ENV: "override" }, // env wins over envFile
});
```

### 7) Strict virtual import allow-list
```ts
const dw = new DenoWorker({
  permissions: { import: true },
  imports: (specifier) => {
    if (specifier === "virtual:math") {
      return { js: "export const add = (a,b) => a + b;" };
    }
    return false; // block everything else
  },
});
```

### 8) Multi-tenant runtime grouping with `DenoDirector`
```ts
const director = new DenoDirector();

const a1 = await director.start({ label: "tenant-a", tags: ["billing"] });
const a2 = await director.start({ label: "tenant-a", tags: ["analytics"] });
const b1 = await director.start({ label: "tenant-b", tags: ["billing"] });

console.log(director.getByLabel("tenant-a").length); // 2
console.log(director.list({ tag: "billing" }).length); // 2

await director.stopByLabel("tenant-a"); // stops a1 + a2
await director.stop(b1);
```

### 9) Worker <-> Node message bus
```ts
const dw = new DenoWorker();

dw.on("message", (msg) => {
  console.log("from worker:", msg);
});

await dw.eval(`
  on("message", (msg) => {
    postMessage({ echo: msg });
  });
`);

dw.postMessage({ hello: "world" }); // => from worker: { echo: { hello: "world" } }
```

## Local Development

```bash
npm install
npm test
```

Build scripts:

- `npm run build-debug`
- `npm run build-release`

## Notes

- This package builds a native addon during install (`cargo` + Rust toolchain required).
- For module imports, configure `imports` and related permissions/options based on your use case.
