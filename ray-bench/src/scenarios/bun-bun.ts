import type { ScenarioDef } from "../types";
import { nodeNodeScenarios } from "./node-node";

const keyMap = new Map<ScenarioDef["key"], ScenarioDef["key"]>([
    ["node+node-fn", "bun+bun-fn"],
    ["node+node-async-fn", "bun+bun-async-fn"],
    ["node+node-postmessage", "bun+bun-postmessage"],
    ["node+node-http", "bun+bun-http"],
]);

export const bunBunScenarios: ScenarioDef[] = nodeNodeScenarios.map((scenario) => {
    const mapped = keyMap.get(scenario.key);
    if (!mapped) throw new Error(`Missing key mapping for scenario ${scenario.key}`);
    return {
        ...scenario,
        key: mapped,
        label: scenario.label
            .replace(/^Node/, "Bun")
            .replace(/\| Node Worker$/, "| Bun")
            .replace(/\| Node$/, "| Bun"),
        main: "Bun",
        worker: "Bun",
    };
});
