import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import { Context, type FiberState } from "@deepseek-ai/cordis";
import Group from "@deepseek-ai/cordis-plugin-group";
import Include from "@deepseek-ai/cordis-plugin-include";
import Loader, { type Entry, type EntryOptions, type EntryTree } from "@deepseek-ai/cordis-plugin-loader";

import type { DshEntryOptions, PiharnessPlugin, PluginDiagnostic } from "./contracts.js";
import type { LoadedProfile } from "./profile.js";
import { builtins } from "./plugins/builtins.js";

const FIBER_PENDING = 0 as FiberState.PENDING;
const FIBER_ACTIVE = 2 as FiberState.ACTIVE;
const FIBER_FAILED = 3 as FiberState.FAILED;
const EMPTY_ROOT_CONFIG_URL = new URL("../bundles/base/cordis.empty.yml", import.meta.url);

// Kept byte-for-byte aligned with DSH app-boot's global startup-critical ids.
// A surface only pays for ids present in its tree; this Desktop needs agent-loop.
const REQUIRED_STARTUP_ENTRY_IDS = new Set([
	"agent-loop",
	"webserver",
	"modules",
	"connection",
	"headless-runner",
	"acp",
	"sdk-jsonrpc-server",
]);

export interface HostedPluginEntry {
	readonly entry: DshEntryOptions;
	readonly plugin?: PiharnessPlugin;
	readonly sourceLabel: string;
	readonly state: "disabled" | "missing" | "pending" | "active" | "failed" | "other";
}

function formatError(error: unknown): string {
	const pieces: string[] = [];
	const seen = new Set<Error>();
	const visit = (value: unknown): void => {
		if (!(value instanceof Error)) {
			pieces.push(String(value));
			return;
		}
		if (seen.has(value)) return;
		seen.add(value);
		pieces.push(value.stack ?? value.message);
		if (value.cause !== undefined) visit(value.cause);
		if (value instanceof AggregateError) value.errors.forEach(visit);
	};
	visit(error);
	return pieces.join("\n");
}

/**
 * Thin app-boot equivalent: official DSH Cordis + Loader + root Include. It
 * owns no capability graph and performs no manual topological sort.
 */
export class DshAppBoot {
	readonly ctx: Context;
	readonly profile: LoadedProfile;
	readonly startupWarnings: string[] = [];
	private readonly startupEntryFailures = new Map<string, string>();
	private started = false;
	private stopped = false;
	private stopPromise: Promise<void> | undefined;

	constructor(profile: LoadedProfile, ctx = new Context()) {
		this.profile = profile;
		this.ctx = ctx;
	}

	async start(): Promise<void> {
		if (this.started) throw new Error("Plugin host is already started.");
		if (this.stopped) throw new Error("Plugin host has already stopped.");
		this.started = true;
		try {
			this.ctx.baseUrl = pathToFileURL(this.profile.baseDir).href + "/";
			// DSH app-boot observes restart promises before Loader installs its own
			// update hooks. This leaves an ordinary failed row in the settled tree so
			// the startup audit can warn, while startup-critical ids still fail loud.
			this.ctx.on("internal/update", (_config, _noSave, next: () => unknown) => {
				void Promise.resolve(next()).catch((error: unknown) => this.ctx.logger.error(error));
			}, { global: true, prepend: true });
			await this.ctx.plugin(Loader, { baseUrl: this.ctx.baseUrl });

			// This is DSH app-boot's HostResolvedRootInclude seam. Bare plugin
			// packages belong to the selected profile, while relative entries stay
			// anchored to the included YAML file. The createRequire fallback keeps
			// the same ownership rule in embedders where Node internals are absent.
			const profileBaseUrl = this.ctx.baseUrl;
			const bareModuleBaseUrl = pathToFileURL(join(this.profile.baseDir, "package.json")).href;
			const profileRequire = createRequire(bareModuleBaseUrl);
			this.ctx.loader.builtins.include = class ProfileResolvedRootInclude extends Include {
				constructor(ctx: Context, config: ConstructorParameters<typeof Include>[1]) {
					super(ctx, config);
					// The physical empty leaf is packaged elsewhere, but a profile root
					// still owns the child plugin context exactly as in DSH app-boot.
					this.ctx.baseUrl = profileBaseUrl;
				}

				override write(): void {
					// The profile layers are authoritative. The packaged empty Include is
					// a startup-only tree carrier, not a second persisted configuration.
				}

				override import(name: string, getOuterStack?: () => string[]): unknown {
					const specifier = isAbsolute(name) ? pathToFileURL(name).href : name;
					if (name.startsWith(".") || name.startsWith("cordis:")) {
						return super.import(specifier, getOuterStack);
					}
					const internal = this.ctx.loader.internal;
					if (internal !== undefined) return internal.import(specifier, bareModuleBaseUrl, {});
					try {
						return super.import(pathToFileURL(profileRequire.resolve(specifier)).href, getOuterStack);
					} catch {
						return super.import(specifier, getOuterStack);
					}
				}
			};
			this.ctx.loader.builtins.group = Group;
			for (const [name, plugin] of builtins) this.ctx.loader.builtins[name] = plugin;

			// The Include reads a packaged, read-only empty leaf. It never writes in
			// the profile directory: relative patch entries were anchored earlier,
			// while bare packages explicitly resolve from the profile package URL.
			const rootEntry = {
				id: "include",
				name: "cordis:include",
				config: {
					path: EMPTY_ROOT_CONFIG_URL.href,
				},
			};
			await this.ctx.loader.create(rootEntry);
			const include = this.ctx.loader.resolve("include");
			if (!include.subtree) throw new Error("The root Include did not expose an entry tree.");
			await this.mountRows(include.subtree, this.profile.entries);
			const loader = this.ctx.get("loader");
			if (!loader) return;
			try {
				await loader.await();
			} catch {
				// The npm 1.0.3 Loader tarball rejects here for a settled failed
				// Fiber, while the pinned DSH source drains with allSettled and lets
				// the activation audit classify optional versus required entries.
			}
			if (!this.ctx.get("loader")) return;
			await this.auditStartup();
		} catch (error) {
			let cause: unknown = error;
			const agents = this.ctx.get("agents", false);
			if (agents) {
				try {
					await agents.shutdown();
				} catch (cleanupError) {
					cause = new AggregateError([error, cleanupError], "Startup and Agent cleanup both failed.");
				}
			}
			await this.ctx.fiber.dispose();
			throw new Error(`PiHarness plugin tree failed to load: ${error instanceof Error ? error.message : String(error)}`, {
				cause,
			});
		}
	}

	stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		if (this.stopped) return Promise.resolve();
		this.stopped = true;
		if (!this.started) return Promise.resolve();
		this.stopPromise = (async () => {
			let drainError: unknown;
			try {
				// This compact port keeps sessions and models as independent rows.
				// Drain AgentFactory-owned handles while those dependencies are still
				// alive, then let Cordis tear down the entire Loader tree.
				await this.ctx.get("agents", false)?.shutdown();
			} catch (error) {
				drainError = error;
			}
			await this.ctx.fiber.dispose();
			if (drainError !== undefined) throw drainError;
		})();
		return this.stopPromise;
	}

	list(): readonly HostedPluginEntry[] {
		return this.profile.entries.map((row) => {
			const loaderEntry = this.lookup(row.id);
			const plugin = row.name.startsWith("cordis:") ? builtins.get(row.name.slice(7)) : undefined;
			return {
				entry: row,
				...(plugin === undefined ? {} : { plugin }),
				sourceLabel: this.sourceLabel(row.id),
				state: this.startupEntryFailures.has(row.id) ? "failed" : this.stateOf(loaderEntry, row),
			};
		});
	}

	diagnostics(): readonly PluginDiagnostic[] {
		return this.list().map(({ entry, state, sourceLabel }) => ({
			pluginId: entry.id,
			severity: state === "active" || state === "disabled" ? "info" : state === "pending" ? "warning" : "error",
			message: `${state} (${entry.name}; ${sourceLabel})`,
		}));
	}

	private lookup(id: string): Entry | undefined {
		const loader = this.ctx.get("loader");
		if (!loader) return undefined;
		try {
			return loader.resolve(`include:${id}`);
		} catch {
			return undefined;
		}
	}

	private stateOf(entry: Entry | undefined, row: DshEntryOptions): HostedPluginEntry["state"] {
		try {
			if (entry?.disabled || (!entry && row.disabled === true)) return "disabled";
		} catch {
			return "failed";
		}
		if (!entry?.fiber) return "missing";
		if (entry.fiber.state === FIBER_ACTIVE) return "active";
		if (entry.fiber.state === FIBER_PENDING) return "pending";
		if (entry.fiber.state === FIBER_FAILED) return "failed";
		return "other";
	}

	private sourceLabel(id: string): string {
		const labels: string[] = [];
		for (const layer of this.profile.layers) {
			if (layer.patches.some((patch) =>
				patch.id === id || patch.insert?.some((entry) => entry.id === id) === true,
			)) labels.push(layer.label);
		}
		return labels.join(" → ") || "unknown layer";
	}

	private async mountRows(tree: EntryTree, rows: readonly DshEntryOptions[], parent?: string): Promise<void> {
		for (const source of rows) {
			const row = structuredClone(source) as unknown as EntryOptions;
			const children = row.group === true ? row.config : undefined;
			if (row.group === true) row.config = [];
			try {
				const group = tree.resolveGroup(parent ?? null);
				await group.create(row);
				const mounted = tree.store[row.id];
				if (!mounted) throw new Error(`Loader did not retain entry ${row.id}.`);
				group.data.push(mounted.options);
				tree.write();
			} catch (error) {
				const diagnostic = `${row.id} (${row.name}): ${formatError(error)}`;
				this.startupEntryFailures.set(row.id, diagnostic);
				continue;
			}
			if (row.group === true) {
				if (!Array.isArray(children)) {
					const diagnostic = `${row.id} (${row.name}): group config must be an entry array`;
					this.startupEntryFailures.set(row.id, diagnostic);
					continue;
				}
				await this.mountRows(tree, children as DshEntryOptions[], row.id);
			}
		}
	}

	private async auditStartup(): Promise<void> {
		const required: string[] = [];
		const optional: string[] = [];
		for (const [id, diagnostic] of this.startupEntryFailures) {
			(REQUIRED_STARTUP_ENTRY_IDS.has(id) ? required : optional).push(diagnostic);
		}
		const include = this.ctx.loader.resolve("include");
		for (const entry of this.ctx.loader.entries()) {
			const failures = entry === include || REQUIRED_STARTUP_ENTRY_IDS.has(entry.options.id) ? required : optional;
			let disabled = false;
			try {
				disabled = entry.disabled;
			} catch (error) {
				failures.push(`${entry.options.id} (${entry.options.name}): disabled expression failed: ${formatError(error)}`);
				continue;
			}
			if (disabled) continue;
			const fiber = entry.fiber;
			if (!fiber) {
				failures.push(`${entry.options.id} (${entry.options.name}): failed to import`);
				continue;
			}
			if (fiber.state === FIBER_ACTIVE) continue;
			if (fiber.state === FIBER_FAILED) {
				try {
					await fiber.await();
				} catch (error) {
					failures.push(`${entry.options.id} (${entry.options.name}): ${formatError(error)}`);
				}
				continue;
			}
			if (fiber.state === FIBER_PENDING) {
				const missing = Object.keys(fiber.inject).filter((service) => fiber.ctx.get(service) === undefined);
				failures.push(`${entry.options.id} (${entry.options.name}): pending for ${missing.join(", ") || "unknown service"}`);
				continue;
			}
			failures.push(`${entry.options.id} (${entry.options.name}): fiber state ${String(fiber.state)}`);
		}
		if (optional.length) {
			const warning = `PiHarness: warning: ${optional.length} ${optional.length === 1 ? "entry" : "entries"} did not activate\n${optional.join("\n")}`;
			this.startupWarnings.push(warning);
			process.stderr.write(`${warning}\n`);
		}
		if (required.length) throw new Error(`required startup failure:\n${required.join("\n")}`);
	}
}

/** @deprecated Use DshAppBoot; retained for source compatibility with 0.1. */
export { DshAppBoot as PluginHost };
