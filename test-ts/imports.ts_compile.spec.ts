import { DenoWorker } from "../src/index";

describe("imports callback ts/tsx/jsx + dynamic flag", () => {
  test("imports callback receives isDynamicImport for static and dynamic loads", async () => {
    const seen: Array<{ specifier: string; isDynamicImport?: boolean }> = [];

    const dw = new DenoWorker({
      moduleLoader: { transpileTs: true },
      permissions: { import: true },
      imports: (specifier: string, _referrer?: string, isDynamicImport?: boolean) => {
        seen.push({ specifier, isDynamicImport });

        if (specifier === "virtual:static") {
          return { js: "export default 1;" };
        }
        if (specifier === "virtual:dynamic") {
          return { js: "export default 2;" };
        }

        return false;
      },
    } as any);

    try {
      const out = await dw.evalModule(`
        import s from "virtual:static";
        const d = await import("virtual:dynamic");
        export const result = [s, d.default];
      `);

      const first = (out as any)?.result?.[0];
      const second = (out as any)?.result?.[1];
      expect([first, second]).toEqual([1, 2]);

      const staticCall = seen.find((x) => x.specifier === "virtual:static");
      const dynamicCall = seen.find((x) => x.specifier === "virtual:dynamic");

      expect(staticCall).toBeTruthy();
      expect(staticCall?.isDynamicImport).toBe(false);
      expect(dynamicCall).toBeTruthy();
      expect(dynamicCall?.isDynamicImport).toBe(true);
    } finally {
      await dw.close();
    }
  });

  test("imports callback can return { ts }", async () => {
    const dw = new DenoWorker({
      moduleLoader: { transpileTs: true },
      permissions: { import: true },
      imports: (specifier: string) => {
        if (specifier !== "virtual:typed-ts") return false;
        return {
          ts: `
            const n: number = 41;
            export default n + 1;
          `,
        };
      },
    } as any);

    try {
      await expect(
        dw.evalModule(`
          import v from "virtual:typed-ts";
          export const out = v;
        `),
      ).resolves.toMatchObject({ out: 42 });
    } finally {
      await dw.close();
    }
  });

  test("imports callback { ts } rejects with guidance when transpileTs is disabled", async () => {
    const dw = new DenoWorker({
      moduleLoader: { transpileTs: false },
      permissions: { import: true },
      imports: (specifier: string) => {
        if (specifier !== "virtual:typed-ts-disabled") return false;
        return {
          ts: `
            const n: number = 1;
            export default n;
          `,
        };
      },
    } as any);

    try {
      await expect(
        dw.evalModule(`
          import v from "virtual:typed-ts-disabled";
          export const out = v;
        `),
      ).rejects.toThrow(/moduleLoader:\s*\{\s*transpileTs:\s*true\s*\}/i);
    } finally {
      await dw.close();
    }
  });

  test("imports callback can return { tsx } with tsCompiler jsxFactory settings", async () => {
    const dw = new DenoWorker({
      moduleLoader: {
        transpileTs: true,
        tsCompiler: {
          jsx: "react",
          jsxFactory: "h",
          jsxFragmentFactory: "Fragment",
        },
      },
      permissions: { import: true },
      imports: (specifier: string) => {
        if (specifier !== "virtual:typed-tsx") return false;
        return {
          tsx: `
            declare global {
              namespace JSX {
                interface IntrinsicElements {
                  div: { value: string };
                }
              }
            }

            function h(tag: string, props: { value: string }) {
              return tag + ":" + props.value;
            }

            const out = <div value="ok" />;
            export default out;
          `,
        };
      },
    } as any);

    try {
      await expect(
        dw.evalModule(`
          import v from "virtual:typed-tsx";
          export const out = v;
        `),
      ).resolves.toMatchObject({ out: "div:ok" });
    } finally {
      await dw.close();
    }
  });

  test("imports callback can return { jsx } with tsCompiler jsxFactory settings", async () => {
    const dw = new DenoWorker({
      moduleLoader: {
        transpileTs: true,
        tsCompiler: {
          jsx: "react",
          jsxFactory: "h",
          jsxFragmentFactory: "Fragment",
        },
      },
      permissions: { import: true },
      imports: (specifier: string) => {
        if (specifier !== "virtual:typed-jsx") return false;
        return {
          jsx: `
            function h(tag, props) {
              return tag + ":" + props.value;
            }

            const out = <div value="ok-jsx" />;
            export default out;
          `,
        };
      },
    } as any);

    try {
      await expect(
        dw.evalModule(`
          import v from "virtual:typed-jsx";
          export const out = v;
        `),
      ).resolves.toMatchObject({ out: "div:ok-jsx" });
    } finally {
      await dw.close();
    }
  });
});
