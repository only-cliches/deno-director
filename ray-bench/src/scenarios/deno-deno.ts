import type { ScenarioDef } from "../types";
import { nodeNodeScenarios } from "./node-node";

const keyMap = new Map<ScenarioDef["key"], ScenarioDef["key"]>([
    ["node+node-fn", "deno+deno-fn"],
    ["node+node-async-fn", "deno+deno-async-fn"],
    ["node+node-postmessage", "deno+deno-postmessage"],
    ["node+node-http", "deno+deno-http"],
]);

export const denoDenoScenarios: ScenarioDef[] = nodeNodeScenarios.map((scenario) => {
    const mapped = keyMap.get(scenario.key);
    if (!mapped) throw new Error(`Missing key mapping for scenario ${scenario.key}`);
    return {
        ...scenario,
        key: mapped,
        label: scenario.label
            .replace(/^Node/, "Deno")
            .replace(/\| Node Worker$/, "| Deno")
            .replace(/\| Node$/, "| Deno"),
        main: "Deno",
        worker: "Deno",
    };
});
