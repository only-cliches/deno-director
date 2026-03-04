import type { ScenarioDef } from "../types";
import { bunBunScenarios } from "./bun-bun";
import { denoDenoScenarios } from "./deno-deno";
import { nodeDenoScenarios } from "./node-deno";
import { nodeNodeScenarios } from "./node-node";

export const scenarioCategories: Record<"node+node" | "node+deno" | "bun+bun" | "deno+deno", ScenarioDef[]> = {
    "node+node": nodeNodeScenarios,
    "node+deno": nodeDenoScenarios,
    "bun+bun": bunBunScenarios,
    "deno+deno": denoDenoScenarios,
};

export const allScenarios: ScenarioDef[] = [
    ...scenarioCategories["node+node"],
    ...scenarioCategories["node+deno"],
    ...scenarioCategories["bun+bun"],
    ...scenarioCategories["deno+deno"],
];
