import { DenoWorker } from "../src/index";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Create a tiny CommonJS package inside a temp `node_modules` tree.
// This keeps the example self-contained and avoids relying on external dependencies.
async function setupCjsPackage(root: string) {
    // Mimic real package layout: <cwd>/node_modules/<pkg-name>/...
    const pkgDir = path.join(root, "node_modules", "cjs-demo");
    await fs.mkdir(pkgDir, { recursive: true });

    // A minimal package.json with CJS main entry.
    // No `"type": "module"` here, so Node-style rules treat `index.js` as CJS.
    await fs.writeFile(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ name: "cjs-demo", version: "1.0.0", main: "index.js" }, null, 2),
        "utf8",
    );

    // CJS entry:
    // - `module.exports = main` exports a callable function as the default value.
    // - `module.exports.named = ...` adds a named property on that function object.
    //
    // Under `nodeJs.cjsInterop: true`, ESM imports can consume this like:
    //   import cjsDefault, { named } from "cjs-demo";
    await fs.writeFile(
        path.join(pkgDir, "index.js"),
        `"use strict";
function main() { return "main"; }
module.exports = main;
module.exports.named = () => "named";
`,
        "utf8",
    );
}

async function main() {
    // Build an isolated workspace in OS temp dir so the example is deterministic
    // and does not touch your project files.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "deno-director-nodejs-cjs-"));

    // Populate fake package before worker start.
    await setupCjsPackage(tmp);

    // Create worker with centralized Node.js compatibility settings:
    // - `modules: true` => enable Node-style package/module resolution
    // - `runtime: true` => enable Node runtime compatibility helpers
    // - `cjsInterop: true` => execute CJS and expose ESM facade exports
    //
    // `cwd` is set to temp workspace so `node_modules/cjs-demo` resolves.
    const worker = new DenoWorker({
        cwd: tmp,
        imports: true,
        nodeJs: { modules: true, runtime: true, cjsInterop: true },
    });

    try {
        // Evaluate an ESM module inside the runtime that imports our CJS package.
        //
        // Expected interop result:
        // - `cjsDefault` is the function assigned to `module.exports`
        // - `named` resolves to `module.exports.named`
        const mod = await worker.module.eval(`
            import cjsDefault, { named } from "cjs-demo";
            export const out = [typeof cjsDefault, cjsDefault(), named()];
        `);

        // Should print: [ 'function', 'main', 'named' ]
        console.log("cjs interop out:", mod.out);
    } finally {
        // Always close worker and remove temp files, even on failure.
        await worker.close();
        await fs.rm(tmp, { recursive: true, force: true });
    }
}

// Standard top-level runner with explicit non-zero exit on failure.
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
