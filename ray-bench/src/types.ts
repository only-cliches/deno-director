export type WorkerCount = 1 | 4 | 8 | 12 | 16 | 32;

export type ScenarioKey =
    | "node+node-fn"
    | "node+node-async-fn"
    | "node+node-postmessage"
    | "node+node-http"
    | "node+deno-postmessage"
    | "node+deno-streams"
    | "node+deno-streams-reused"
    | "node+deno-eval"
    | "node+deno-evalsync"
    | "node+deno-handle"
    | "node+deno-postmessage-batched"
    | "node+deno-handle-apply"
    | "node+deno-eval-binary"
    | "deno+deno-fn"
    | "deno+deno-async-fn"
    | "deno+deno-postmessage"
    | "deno+deno-http"
    | "bun+bun-fn"
    | "bun+bun-async-fn"
    | "bun+bun-postmessage"
    | "bun+bun-http";

export type BenchConfig = {
    width: number;
    height: number;
    tileHeight: number;
    workerCounts: WorkerCount[];
    iterations: number;
    warmup: number;
    scenarios: ScenarioKey[];
    format: "plain" | "markdown";
};

export type RenderTask = {
    id: number;
    x0: number;
    y0: number;
    width: number;
    height: number;
    imageWidth: number;
    imageHeight: number;
};

export type RenderResult = {
    id: number;
    checksum: number;
    pixels: number;
};

export type ScenarioDef = {
    key: ScenarioKey;
    label: string;
    main: "Node" | "Deno" | "Bun";
    ipc: string;
    worker: "Node" | "Node Worker" | "Deno" | "Bun";
    requires?: ("node" | "deno" | "bun")[];
    setup?: (workerCount: number) => Promise<any>;
    run: (tasks: RenderTask[], workerCount: number, context?: any) => Promise<number>;
    teardown?: (context: any) => Promise<void>;
};

export const scenarioOrder: ScenarioKey[] = [
    "node+node-fn",
    "node+node-async-fn",
    "node+node-postmessage",
    "node+node-http",
    "node+deno-postmessage",
    "node+deno-streams",
    "node+deno-streams-reused",
    "node+deno-eval",
    "node+deno-evalsync",
    "node+deno-handle",
    "node+deno-postmessage-batched",
    "node+deno-handle-apply",
    "node+deno-eval-binary",
    "deno+deno-fn",
    "deno+deno-async-fn",
    "deno+deno-postmessage",
    "deno+deno-http",
    "bun+bun-fn",
    "bun+bun-async-fn",
    "bun+bun-postmessage",
    "bun+bun-http",
];
