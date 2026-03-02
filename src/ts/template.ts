/* eslint-disable @typescript-eslint/no-explicit-any */

import { asStringArray, mergeWorkerOptions } from "./options";
import { DenoWorker } from "./worker";
import type { DenoWorkerTemplateCreateOptions, DenoWorkerTemplateOptions } from "./types";

/**
 * Reusable runtime template.
 *
 * A template captures common worker options, globals, bootstrap scripts/modules,
 * and setup hooks, then applies them each time you call {@link create}.
 */
export class DenoWorkerTemplate {
	private readonly options: DenoWorkerTemplateOptions;

	/**
	 * @example
	 * ```ts
	 * const template = new DenoWorkerTemplate({
	 *   workerOptions: { permissions: { env: true } },
	 *   globals: { APP: "director" },
	 *   bootstrapScripts: "globalThis.VERSION = 1;",
	 * });
	 * ```
	 */
	constructor(options?: DenoWorkerTemplateOptions) {
		this.options = options ?? {};
	}

	/**
	 * Create a new runtime instance from this template.
	 *
	 * `createOptions` are merged on top of template defaults.
	 *
	 * @example
	 * ```ts
	 * const runtime = await template.create({
	 *   globals: { TENANT: "a" },
	 *   bootstrapScripts: "globalThis.TENANT_READY = true;",
	 * });
	 * ```
	 */
	async create(createOptions?: DenoWorkerTemplateCreateOptions): Promise<DenoWorker> {
		const workerOptions = mergeWorkerOptions(this.options.workerOptions, createOptions?.workerOptions);
		const worker = new DenoWorker(workerOptions);
		let ready = false;

		try {
			const globals = {
				...(this.options.globals ?? {}),
				...(createOptions?.globals ?? {}),
			};
			for (const [k, v] of Object.entries(globals)) {
				await worker.setGlobal(k, v);
			}

			for (const script of [...asStringArray(this.options.bootstrapScripts), ...asStringArray(createOptions?.bootstrapScripts)]) {
				await worker.eval(script);
			}

			for (const mod of [...asStringArray(this.options.bootstrapModules), ...asStringArray(createOptions?.bootstrapModules)]) {
				await worker.evalModule(mod);
			}

			if (typeof this.options.setup === "function") {
				await this.options.setup(worker);
			}
			if (typeof createOptions?.setup === "function") {
				await createOptions.setup(worker);
			}

			ready = true;
			return worker;
		} finally {
			if (!ready && !worker.isClosed()) {
				await worker.close().catch(() => {
					// ignore
				});
			}
		}
	}
}
