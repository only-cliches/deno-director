import { DenoDirector } from "../src/index";

describe("DenoDirector runtime labels and metadata", () => {
  test("start attaches metadata and runtime stays directly usable", async () => {
    const dd = new DenoDirector({
      template: {
        globals: { BASE: 40 },
      },
    });

    const rt = await dd.start({ label: "alpha", tags: ["tenant:a", "batch"] });
    try {
      expect(rt.meta.id).toBeTruthy();
      expect(rt.meta.label).toBe("alpha");
      expect(rt.meta.tags).toEqual(["tenant:a", "batch"]);
      await expect(rt.eval("BASE + 2")).resolves.toBe(42);

      const got = dd.get(rt.meta.id);
      expect(got).toBe(rt);
      expect(dd.getByLabel("alpha")).toContain(rt);
      expect(dd.list({ tag: "batch" })).toContain(rt);
    } finally {
      await dd.stopAll();
    }
  });

  test("labels/tags can be updated and queried", async () => {
    const dd = new DenoDirector();
    const rt = await dd.start({ label: "before", tags: ["x"] });

    try {
      expect(dd.setLabel(rt, "after")).toBe(true);
      expect(dd.getByLabel("before")).toEqual([]);
      expect(dd.getByLabel("after")).toContain(rt);

      expect(dd.addTag(rt, "y")).toBe(true);
      expect(dd.list({ tag: "y" })).toContain(rt);

      expect(dd.removeTag(rt, "x")).toBe(true);
      expect(dd.list({ tag: "x" })).not.toContain(rt);

      expect(dd.setTags(rt, ["k1", "k2", "k2"])) .toBe(true);
      expect(rt.meta.tags).toEqual(["k1", "k2"]);
    } finally {
      await dd.stopAll();
    }
  });

  test("stop/stopByLabel/auto-close cleanup remove records", async () => {
    const dd = new DenoDirector();
    const a1 = await dd.start({ label: "g1" });
    const a2 = await dd.start({ label: "g1" });
    const b1 = await dd.start({ label: "g2" });

    expect(dd.list().length).toBe(3);

    await expect(dd.stop(a1)).resolves.toBe(true);
    expect(dd.get(a1.meta.id)).toBeUndefined();

    await expect(dd.stopByLabel("g1")).resolves.toBe(1);
    expect(dd.get(a2.meta.id)).toBeUndefined();
    expect(dd.get(b1.meta.id)).toBe(b1);

    await b1.close();
    expect(dd.get(b1.meta.id)).toBeUndefined();
  });

  test("director metadata/index remain stable across restart and cleanup still unregisters once", async () => {
    const dd = new DenoDirector();
    const rt = await dd.start({ label: "restarts", tags: ["a", "b"] });
    const id = rt.meta.id;

    expect(dd.get(id)).toBe(rt);
    await rt.restart();

    expect(dd.get(id)).toBe(rt);
    expect(rt.meta.id).toBe(id);
    expect(rt.meta.label).toBe("restarts");
    expect(rt.meta.tags).toEqual(["a", "b"]);

    await rt.close();
    expect(dd.get(id)).toBeUndefined();
    await expect(dd.stop(id)).resolves.toBe(false);
  });
});
