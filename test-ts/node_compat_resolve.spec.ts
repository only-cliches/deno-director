// test-ts/node_compat_resolve.spec.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createTestWorker } from "./helpers.worker-harness";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

async function mkTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFile(p: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, text, "utf8");
}

describe("DenoWorker nodeJs modules/runtime interop", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkTempDir("denojs-worker-node-resolve-");
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });

    await writeFile(path.join(dir, "local.js"), `export const x = 123;\n`);

    await writeFile(
      path.join(dir, "node_modules", "my_pkg", "package.json"),
      JSON.stringify({ name: "my_pkg", version: "1.0.0", main: "main.js" }, null, 2)
    );

    await writeFile(
      path.join(dir, "node_modules", "my_pkg", "main.js"),
      `export const y = 456;\n`
    );
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("does not resolve bare specifier when nodeResolve is disabled", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      nodeJs: { modules: false },
    });

    try {
      const code = `
        import { y } from "my_pkg";
        export const out = y;
      `;
      await expect(dw.module.eval(code)).rejects.toBeTruthy();
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  it("resolves bare specifier from node_modules when nodeResolve enabled", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      nodeJs: { modules: true },
    });

    try {
      const code = `
        import { y } from "my_pkg";
        export const out = y;
      `;
      await expect(dw.module.eval(code)).resolves.toMatchObject({ out: 456 });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  it("nodeJs.modules resolves bare packages without runtime mode", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      nodeJs: { modules: true },
    });

    try {
      const code = `
        import { y } from "my_pkg";
        export const out = y;
      `;
      await expect(dw.module.eval(code)).resolves.toMatchObject({ out: 456 });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  it("resolves relative specifier from cwd when nodeResolve enabled", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      nodeJs: { modules: true },
    });

    try {
      const code = `
        import { x } from "./local.js";
        export const out = x;
      `;
      await expect(dw.module.eval(code)).resolves.toMatchObject({ out: 123 });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("nodeResolve: prefers .js over .ts when both exist for extensionless import", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      nodeJs: { modules: true },
    });

    try {
      writeFile(path.join(dir, "dep.js"), `export const v = "from-js";\n`);
      writeFile(path.join(dir, "dep.ts"), `export const v = "from-ts";\n`);

      const code = `
        import { v } from "./dep";
        export const out = v;
      `;

      await expect(dw.module.eval(code)).resolves.toMatchObject({ out: "from-js" });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("nodeResolve: package.json module field is preferred over main", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      nodeJs: { modules: true },
    });

    try {
      writeFile(
        path.join(dir, "node_modules", "pkgm", "package.json"),
        JSON.stringify(
          { name: "pkgm", version: "1.0.0", module: "module.js", main: "main.js" },
          null,
          2
        )
      );
      writeFile(
        path.join(dir, "node_modules", "pkgm", "module.js"),
        `export const which = "module";\n`
      );
      writeFile(
        path.join(dir, "node_modules", "pkgm", "main.js"),
        `export const which = "main";\n`
      );

      const code = `
        import { which } from "pkgm";
        export const out = which;
      `;

      await expect(dw.module.eval(code)).resolves.toMatchObject({ out: "module" });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test(
    "nodeResolve: supports package.json main without extension (falls back to .mjs/.js/.cjs)",
    async () => {
      const dw = createTestWorker({
        cwd: dir,
        imports: true,
        nodeJs: { modules: true },
      });

      try {
        writeFile(
          path.join(dir, "node_modules", "pkgx", "package.json"),
          JSON.stringify({ name: "pkgx", version: "1.0.0", main: "index" }, null, 2)
        );
        writeFile(
          path.join(dir, "node_modules", "pkgx", "index.mjs"),
          `export const v = "index-mjs";\n`
        );

        const code = `
        import { v } from "pkgx";
        export const out = v;
      `;

        await expect(dw.module.eval(code)).resolves.toMatchObject({ out: "index-mjs" });
      } finally {
        if (!dw.isClosed()) await dw.close();
      }
    }
  );

  test("nodeResolve: resolves scoped packages from node_modules", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      nodeJs: { modules: true },
    });

    try {
      writeFile(
        path.join(dir, "node_modules", "@scope", "pkg", "package.json"),
        JSON.stringify({ name: "@scope/pkg", version: "1.0.0", main: "main.js" }, null, 2)
      );
      writeFile(
        path.join(dir, "node_modules", "@scope", "pkg", "main.js"),
        `export const scoped = "ok";\n`
      );

      const code = `
        import { scoped } from "@scope/pkg";
        export const out = scoped;
      `;

      await expect(dw.module.eval(code)).resolves.toMatchObject({ out: "ok" });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("nodeResolve: resolves bare package subpath with extension fallback", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      nodeJs: { modules: true },
    });

    try {
      writeFile(
        path.join(dir, "node_modules", "pkgs", "package.json"),
        JSON.stringify({ name: "pkgs", version: "1.0.0", main: "main.js" }, null, 2)
      );
      writeFile(path.join(dir, "node_modules", "pkgs", "main.js"), `export const base = "base";\n`);
      writeFile(path.join(dir, "node_modules", "pkgs", "sub.ts"), `export default "sub-ts";\n`);

      const code = `
        import sub from "pkgs/sub";
        export const out = sub;
      `;

      await expect(dw.module.eval(code)).resolves.toMatchObject({ out: "sub-ts" });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test(
    "nodeResolve: extensionless directory imports resolve to index.*",
    async () => {
      const dw = createTestWorker({
        cwd: dir,
        imports: true,
        nodeJs: { modules: true },
      });

      try {
        await writeFile(path.join(dir, "dir", "index.js"), `export const v = "index";\n`);

        const code = `
        import { v } from "./dir";
        export const out = v;
      `;

        await expect(dw.module.eval(code)).resolves.toMatchObject({ out: "index" });
      } finally {
        if (!dw.isClosed()) await dw.close();
      }
    }
  );

  test(
    "nodeResolve: bare package directory subpath imports resolve to package entry or index.*",
    async () => {
      const dw = createTestWorker({
        cwd: dir,
        imports: true,
        nodeJs: { modules: true },
      });

      try {
        await writeFile(
          path.join(dir, "node_modules", "pkgdir", "package.json"),
          JSON.stringify({ name: "pkgdir", version: "1.0.0", main: "main.js" }, null, 2)
        );
        await writeFile(path.join(dir, "node_modules", "pkgdir", "main.js"), `export const ok = true;\n`);
        await writeFile(
          path.join(dir, "node_modules", "pkgdir", "dir", "package.json"),
          JSON.stringify({ main: "entry.js" }, null, 2)
        );
        await writeFile(
          path.join(dir, "node_modules", "pkgdir", "dir", "entry.js"),
          `export const z = "dir-entry";\n`
        );
        await writeFile(
          path.join(dir, "node_modules", "pkgdir", "dir", "index.js"),
          `export const z = "dir-index";\n`
        );

        const code = `
        import { z } from "pkgdir/dir";
        export const out = z;
      `;

        await expect(dw.module.eval(code)).resolves.toMatchObject({ out: "dir-entry" });
      } finally {
        if (!dw.isClosed()) await dw.close();
      }
    }
  );

  test("nodeResolve: CJS package named exports fail by default (no interop)", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      
      nodeJs: { modules: true },
    });

    try {
      await writeFile(
        path.join(dir, "node_modules", "cjspkg", "package.json"),
        JSON.stringify({ name: "cjspkg", version: "1.0.0", main: "index.js" }, null, 2)
      );
      await writeFile(
        path.join(dir, "node_modules", "cjspkg", "index.js"),
        `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Provider = exports.Storage = void 0;
const Provider = "provider";
exports.Provider = Provider;
class Storage {}
exports.Storage = Storage;
`
      );

      const code = `
        import { Provider, Storage } from "cjspkg";
        export const out = [Provider, typeof Storage === "function"];
      `;

      await expect(dw.module.eval(code)).rejects.toThrow(/does not provide an export named 'Provider'/i);
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("nodeResolve: cjsInterop wraps CJS package for named ESM imports", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      
      nodeJs: { modules: true, runtime: true, cjsInterop: true },
    });

    try {
      await writeFile(
        path.join(dir, "node_modules", "cjspkg", "package.json"),
        JSON.stringify({ name: "cjspkg", version: "1.0.0", main: "index.js" }, null, 2)
      );
      await writeFile(
        path.join(dir, "node_modules", "cjspkg", "index.js"),
        `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Provider = exports.Storage = void 0;
const Provider = "provider";
exports.Provider = Provider;
class Storage {}
exports.Storage = Storage;
`
      );

      const code = `
        import { Provider, Storage } from "cjspkg";
        export const out = [Provider, typeof Storage === "function"];
      `;

      await expect(dw.module.eval(code)).resolves.toMatchObject({ out: ["provider", true] });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("nodeResolve: cjsInterop ignores string mode values", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      
      nodeJs: { modules: true, runtime: true, cjsInterop: "node" as any },
    });

    try {
      await writeFile(
        path.join(dir, "node_modules", "cjspkg", "package.json"),
        JSON.stringify({ name: "cjspkg", version: "1.0.0", main: "index.js" }, null, 2)
      );
      await writeFile(
        path.join(dir, "node_modules", "cjspkg", "index.js"),
        `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Provider = void 0;
const Provider = "provider";
exports.Provider = Provider;
`
      );

      const code = `
        import { Provider } from "cjspkg";
        export const out = Provider;
      `;

      await expect(dw.module.eval(code)).rejects.toThrow(/does not provide an export named 'Provider'/i);
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("nodeResolve: cjsInterop handles multiline object-literal exports", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      
      nodeJs: { modules: true, runtime: true, cjsInterop: true },
    });

    try {
      await writeFile(
        path.join(dir, "node_modules", "cjsobj", "package.json"),
        JSON.stringify({ name: "cjsobj", version: "1.0.0", main: "index.js" }, null, 2)
      );
      await writeFile(
        path.join(dir, "node_modules", "cjsobj", "index.js"),
        `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adapterFunctions = exports.adapterClasses = void 0;
exports.getAvailableAdapters = getAvailableAdapters;
exports.adapterClasses = {
  s3: ["AdapterS3", "mod-s3"],
  aws: ["AdapterAws", "mod-aws"],
};
exports.adapterFunctions = {
  b2f: ["AdapterB2F", "mod-b2f"],
};
function getAvailableAdapters() {
  return Object.keys(exports.adapterClasses);
}
`
      );

      const code = `
        import { adapterClasses, adapterFunctions, getAvailableAdapters } from "cjsobj";
        export const out = [
          adapterClasses.s3[0],
          adapterFunctions.b2f[0],
          getAvailableAdapters().includes("s3")
        ];
      `;

      await expect(dw.module.eval(code)).resolves.toMatchObject({ out: ["AdapterS3", "AdapterB2F", true] });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("nodeResolve: cjsInterop handles __importDefault(require(...)) top-level bindings", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      
      nodeJs: { modules: true, runtime: true, cjsInterop: true },
    });

    try {
      await writeFile(
        path.join(dir, "node_modules", "cjswrap", "package.json"),
        JSON.stringify({ name: "cjswrap", version: "1.0.0", main: "index.js" }, null, 2)
      );
      await writeFile(
        path.join(dir, "node_modules", "cjswrap", "index.js"),
        `"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
  return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.base = void 0;
const path_1 = __importDefault(require("path"));
exports.base = path_1.default.basename("/tmp/hello.txt");
`
      );

      const code = `
        import { base } from "cjswrap";
        export const out = base;
      `;

      await expect(dw.module.eval(code)).resolves.toMatchObject({ out: "hello.txt" });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("nodeResolve: cjsInterop handles Babel re-export chains consumed via require bindings", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      
      nodeJs: { modules: true, runtime: true, cjsInterop: true },
    });

    try {
      await writeFile(
        path.join(dir, "node_modules", "cjsbabel", "package.json"),
        JSON.stringify({ name: "cjsbabel", version: "1.0.0", main: "lib/index.js" }, null, 2)
      );
      await writeFile(
        path.join(dir, "node_modules", "cjsbabel", "lib", "builders", "generated", "lowercase.js"),
        `"use strict";
Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.unaryExpression = unaryExpression;
exports.numericLiteral = numericLiteral;
function unaryExpression(op, arg, prefix) {
  return { op, arg, prefix };
}
function numericLiteral(n) {
  return n;
}
`
      );
      await writeFile(
        path.join(dir, "node_modules", "cjsbabel", "lib", "builders", "generated", "index.js"),
        `"use strict";
Object.defineProperty(exports, "__esModule", {
  value: true
});
var _lowercase = require("./lowercase.js");
Object.keys(_lowercase).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (key in exports && exports[key] === _lowercase[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _lowercase[key];
    }
  });
});
`
      );
      await writeFile(
        path.join(dir, "node_modules", "cjsbabel", "lib", "builders", "productions.js"),
        `"use strict";
Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.buildUndefinedNode = buildUndefinedNode;
var _index = require("./generated/index.js");
function buildUndefinedNode() {
  return (0, _index.unaryExpression)("void", (0, _index.numericLiteral)(0), true);
}
`
      );

      const code = `
        import { buildUndefinedNode } from "cjsbabel/lib/builders/productions.js";
        export const out = buildUndefinedNode();
      `;

      await expect(dw.module.eval(code)).resolves.toMatchObject({
        out: { op: "void", arg: 0, prefix: true },
      });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("module.eval: cjsInterop supports default+named imports from CJS", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      
      nodeJs: { modules: true, runtime: true, cjsInterop: true },
    });

    try {
      await writeFile(
        path.join(dir, "node_modules", "cjsrisk", "package.json"),
        JSON.stringify({ name: "cjsrisk", version: "1.0.0", main: "index.js" }, null, 2)
      );
      await writeFile(
        path.join(dir, "node_modules", "cjsrisk", "index.js"),
        `"use strict";
var __createBinding = (this && this.__createBinding) || function() {};
Object.defineProperty(exports, "__esModule", { value: true });
exports.named = named;
exports.default = void 0;
function named() { return "named"; }
function main() { return "default"; }
exports.default = main;
`
      );

      const code = `
        import defValue, { named as namedFn } from "cjsrisk";
        export const out = [typeof defValue, defValue.default(), namedFn()];
      `;

      await expect(dw.module.eval(code)).resolves.toMatchObject({ out: ["object", "default", "named"] });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("module.eval: cjsInterop supports namespace imports from CJS", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      
      nodeJs: { modules: true, runtime: true, cjsInterop: true },
    });

    try {
      await writeFile(
        path.join(dir, "node_modules", "cjsrisk", "package.json"),
        JSON.stringify({ name: "cjsrisk", version: "1.0.0", main: "index.js" }, null, 2)
      );
      await writeFile(
        path.join(dir, "node_modules", "cjsrisk", "index.js"),
        `"use strict";
var __createBinding = (this && this.__createBinding) || function() {};
Object.defineProperty(exports, "__esModule", { value: true });
exports.named = named;
exports.default = void 0;
function named() { return "named"; }
function main() { return "default"; }
exports.default = main;
`
      );

      const code = `
        import * as ns from "cjsrisk";
        export const out = [typeof ns.default, typeof ns.default.default, ns.default.default(), ns.named()];
      `;

      await expect(dw.module.eval(code)).resolves.toMatchObject({ out: ["object", "function", "default", "named"] });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("nodeResolve: cjsInterop supports function module.exports with attached named members", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      
      nodeJs: { modules: true, runtime: true, cjsInterop: true },
    });

    try {
      await writeFile(
        path.join(dir, "node_modules", "cjsfn", "package.json"),
        JSON.stringify({ name: "cjsfn", version: "1.0.0", main: "index.js" }, null, 2)
      );
      await writeFile(
        path.join(dir, "node_modules", "cjsfn", "index.js"),
        `"use strict";
function main() { return "main"; }
module.exports = main;
module.exports.extra = function extra() { return "extra"; };
`
      );

      const code = `
        import defValue, { extra } from "cjsfn";
        export const out = [typeof defValue, defValue(), extra()];
      `;

      await expect(dw.module.eval(code)).resolves.toMatchObject({ out: ["function", "main", "extra"] });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("nodeResolve: cjsInterop supports CJS require() chains across local files", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      
      nodeJs: { modules: true, runtime: true, cjsInterop: true },
    });

    try {
      await writeFile(
        path.join(dir, "node_modules", "cjschain", "package.json"),
        JSON.stringify({ name: "cjschain", version: "1.0.0", main: "index.js" }, null, 2)
      );
      await writeFile(
        path.join(dir, "node_modules", "cjschain", "dep.js"),
        `"use strict";
exports.n = 7;
`
      );
      await writeFile(
        path.join(dir, "node_modules", "cjschain", "index.js"),
        `"use strict";
const dep = require("./dep.js");
exports.value = dep.n + 1;
`
      );

      const code = `
        import { value } from "cjschain";
        export const out = value;
      `;

      await expect(dw.module.eval(code)).resolves.toMatchObject({ out: 8 });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("nodeResolve: cjsInterop supports require('path') builtins in CJS modules", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      
      nodeJs: { modules: true, runtime: true, cjsInterop: true },
    });

    try {
      await writeFile(
        path.join(dir, "node_modules", "cjsbuiltin", "package.json"),
        JSON.stringify({ name: "cjsbuiltin", version: "1.0.0", main: "index.js" }, null, 2)
      );
      await writeFile(
        path.join(dir, "node_modules", "cjsbuiltin", "index.js"),
        `"use strict";
const path = require("path");
exports.base = path.basename("/tmp/a.txt");
`
      );

      const code = `
        import { base } from "cjsbuiltin";
        export const out = base;
      `;

      await expect(dw.module.eval(code)).resolves.toMatchObject({ out: "a.txt" });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });
});
