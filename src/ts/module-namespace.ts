/* eslint-disable @typescript-eslint/no-explicit-any */

import type { EvalOptions } from "./types";
import { hydrateFromWire } from "./wire";

type ModuleWrapperHost = {
	evalSync(src: string, options?: EvalOptions): any;
};

function getModuleFnTag(x: any): { spec: string; name: string } | null {
	if (!x || typeof x !== "object") return null;
	const specRaw = (x as any).spec;
	const nameRaw = (x as any).name;
	const tag = (x as any).__denojs_worker_type;
	if (specRaw == null || nameRaw == null) return null;

	const spec = String(specRaw);
	const name = String(nameRaw);
	if (!spec.startsWith("denojs+")) return null;

	if (tag === "module_fn") return { spec, name };
	const keys = Object.keys(x);
	if (keys.length <= 3 && keys.every((k) => k === "__denojs_worker_type" || k === "spec" || k === "name")) {
		return { spec, name };
	}
	return null;
}

export function wrapModuleNamespace<T extends Record<string, any>>(dw: ModuleWrapperHost, ns: any): T {
	if (!ns || typeof ns !== "object") return ns as T;

	const proto = Object.getPrototypeOf(ns);
	const out: any = proto === null ? Object.create(null) : {};
	const moduleSpec = typeof (ns as any).__denojs_worker_module_spec === "string" ? (ns as any).__denojs_worker_module_spec : undefined;
	const moduleFnKeys = new Set(
		Array.isArray((ns as any).__denojs_worker_module_fns)
			? (ns as any).__denojs_worker_module_fns.filter((x: any) => typeof x === "string")
			: [],
	);

	for (const [k, v] of Object.entries(ns)) {
		if (k === "__denojs_worker_module_spec" || k === "__denojs_worker_module_fns") continue;
		const modFn = getModuleFnTag(v);
		const shouldWrap = !!modFn || moduleFnKeys.has(k);
		if (shouldWrap) {
			const spec = modFn?.spec ?? moduleSpec;
			const name = modFn?.name ?? k;
			if (typeof spec !== "string") {
				out[k] = hydrateFromWire(v);
				continue;
			}

			const specJson = JSON.stringify(spec);
			const nameJson = JSON.stringify(name);

			out[k] = (...args: any[]) => {
				return dw.evalSync(`(...args) => import(${specJson}).then(m => m[${nameJson}](...args))`, { args });
			};
		} else {
			out[k] = hydrateFromWire(v);
		}
	}

	return out as T;
}
