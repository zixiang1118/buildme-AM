import { Context } from "@deepseek-ai/cordis";

import { DshAppBoot } from "./plugin-host.js";
import type { LoadedProfile } from "./profile.js";

export interface PiharnessApp {
	readonly ctx: Context;
	readonly boot: DshAppBoot;
	/** Compatibility alias for the 0.1 API. */
	readonly host: DshAppBoot;
	readonly profile: LoadedProfile;
	stop(): Promise<void>;
}

/** Boot one standalone Pi Agent + Cordis composition from a profile. */
export async function createApp(profile: LoadedProfile): Promise<PiharnessApp> {
	const ctx = new Context();
	const boot = new DshAppBoot(profile, ctx);
	await boot.start();
	return {
		ctx,
		boot,
		host: boot,
		profile,
		stop: () => boot.stop(),
	};
}
