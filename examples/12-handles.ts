import { DenoWorker } from "../src/index";

async function main() {
    const dw = new DenoWorker();

    try {
        await dw.eval(`
            globalThis.repo = {
                value: 1,
                nested: { count: 2 },
                add(n) { this.value += n; return this.value; },
            };
        `);

        const repo = await dw.handle.get("globalThis.repo");
        console.log("repo rootType:", repo.rootType);
        console.log("repo type:", await repo.getType());
        console.log("repo.value:", await repo.get("value"));
        console.log("repo has nested.count:", await repo.has("nested.count"));
        console.log("repo keys:", await repo.keys());
        console.log("repo entries:", await repo.entries());

        await repo.set("nested.count", 9);
        console.log("repo.nested.count:", await repo.get("nested.count"));

        const next = await repo.call("add", [5]);
        console.log("repo.add(5):", next);
        console.log("repo toJSON:", await repo.toJSON());

        await repo.define("hidden", {
            value: 777,
            enumerable: false,
            configurable: true,
            writable: true,
        });
        console.log("repo.hidden descriptor:", await repo.getOwnPropertyDescriptor("hidden"));

        console.log("repo instanceof Object:", await repo.instanceOf("Object"));
        console.log("repo callable?", await repo.isCallable(), "repo.add callable?", await repo.isCallable("add"));
        console.log("repo promise-like?", await repo.isPromise());

        const applyOut = await repo.apply([
            { op: "call", path: "add", args: [10] },
            { op: "get", path: "value" },
            { op: "has", path: "hidden" },
            { op: "isPromise" },
            { op: "toJSON" },
        ]);
        console.log("repo apply output:", applyOut);

        const cloned = await repo.clone();
        await cloned.call("add", [1]);
        console.log("repo value after cloned.add(1):", await repo.get("value"));
        await cloned.dispose();

        console.log("repo delete hidden:", await repo.delete("hidden"));
        console.log("repo has hidden:", await repo.has("hidden"));

        const adder = await dw.handle.eval(`(a, b) => a + b`);
        console.log("adder rootType:", adder.rootType);
        console.log("adder type:", await adder.getType());
        console.log("adder(20, 22):", await adder.call([20, 22]));
        console.log("adder callable?:", await adder.isCallable());

        const promiseHandle = await dw.handle.eval(`Promise.resolve({ done: true, value: 42 })`);
        console.log("promise rootType (before await):", promiseHandle.rootType);
        console.log("promise isPromise (before await):", await promiseHandle.isPromise());
        console.log("promise await():", await promiseHandle.await());
        console.log("promise isPromise (after await):", await promiseHandle.isPromise());
        console.log("promise rootType (after await):", promiseHandle.rootType);

        const pointCtor = await dw.handle.eval(`(class Point { constructor(x, y) { this.x = x; this.y = y; } })`);
        console.log("constructed point:", await pointCtor.construct([3, 4]));

        await pointCtor.dispose();
        await promiseHandle.dispose();
        await adder.dispose();
        await repo.dispose();
    } finally {
        await dw.close({ force: true });
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
