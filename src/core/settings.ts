import { Service } from "@deepseek-ai/cordis";

import type { PiharnessSettings } from "../contracts.js";

/** Immutable settings injected by the selected profile. */
export class SettingsService extends Service<PiharnessSettings> {
	readonly value: Readonly<PiharnessSettings>;

	constructor(ctx: import("@deepseek-ai/cordis").Context, config: PiharnessSettings) {
		super(ctx, "settings");
		this.value = Object.freeze({
			...config,
			agent: Object.freeze({ ...config.agent }),
		});
	}
}
