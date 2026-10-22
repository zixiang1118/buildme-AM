import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { applyEntryPatches, entryListSchema, type PatchOptions } from "@deepseek-ai/cordis-plugin-include";
import * as yaml from "js-yaml";
import { z } from "zod";

import type {
	DshEntryOptions,
	DshPatchOptions,
	DshProfileManifest,
	PiharnessProfile,
	PiharnessSettings,
	PluginProfileEntry,
} from "./contracts.js";

export const PROFILE_PATCH_FILENAME = "cordis.patch.yml";
export const PERSONAL_BASE_BUNDLE = "@my-agent/base";

const internalBaseDir = fileURLToPath(new URL("../bundles/base/", import.meta.url));

/**
 * BuildMe's default agent prompt is vendored with the base bundle so the
 * default agent works offline and has a versioned, reviewable source.
 */
const AGENT_PROMPT_PRESET = "@buildme/agent";

/**
 * Older profiles may reference a removed preset (`@buildme/academic`, or the
 * pre-0.5 Claude Code preset) or contain the Claude Code preset's full text
 * (older `init` wrote the text itself). All resolve to the default agent
 * prompt so existing profiles keep working.
 */
const LEGACY_PROMPT_PRESETS = new Set(["@buildme/academic", "@buildme/claude-code-opus-5"]);
const LEGACY_PROMPT_SHA256 = "0a92514c8382284653acda857bb3a7299f538a8b43ac40fd30505f04ce1a2b0a";

const AGENT_PROMPT = readFileSync(join(internalBaseDir, "prompts", "buildme-agent.md"), "utf8");

function resolveSystemPrompt(value: string): string {
	if (value === AGENT_PROMPT_PRESET || LEGACY_PROMPT_PRESETS.has(value)) return AGENT_PROMPT;
	if (createHash("sha256").update(value).digest("hex") === LEGACY_PROMPT_SHA256) return AGENT_PROMPT;
	return value;
}

const pluginId = z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/);
const jsonValue: z.ZodType<unknown> = z.lazy(() =>
	z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue)]),
);
const endpointUrl = z.string().url().refine((value) => {
	const parsed = new URL(value);
	return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
}, "must be an HTTP(S) URL without embedded credentials");

const settingsSchema = z.object({
	name: z.string().min(1),
	home: z.string().min(1),
	agent: z.object({
		provider: z.string().min(1),
		model: z.string().min(1),
		baseUrl: endpointUrl.optional(),
		apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
		systemPrompt: z.string(),
		thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
		toolExecution: z.enum(["parallel", "sequential"]).optional(),
	}).strict(),
});

const legacyProfileSchema = z.object({
	schemaVersion: z.literal(1),
	settings: settingsSchema,
	plugins: z
		.array(
			z.object({
				id: pluginId,
				enabled: z.boolean().optional(),
				source: z.string().min(1).optional(),
				exportName: z.string().min(1).optional(),
				config: jsonValue.optional(),
			}),
		)
		.min(1),
});

const profilePackageSchema = z.object({
	name: z.string().min(1).optional(),
	dsh: z.object({
		profile: z.object({
			bundles: z.array(z.string().min(1)),
			patchReload: z.enum(["live", "startup"]).optional(),
		}),
	}),
});

const bundlePackageSchema = z.object({
	name: z.string().min(1).optional(),
	dsh: z.object({
		bundle: z.object({ patch: z.string().min(1) }),
	}),
});

export interface ProfileLayer {
	readonly label: string;
	readonly path: string;
	readonly patches: readonly DshPatchOptions[];
}

export interface LoadedProfile {
	readonly path: string;
	readonly baseDir: string;
	readonly name: string;
	readonly manifest: DshProfileManifest;
	readonly layers: readonly ProfileLayer[];
	readonly patches: readonly DshPatchOptions[];
	readonly entries: readonly DshEntryOptions[];
	readonly warnings: readonly string[];
	readonly legacy: boolean;
	/** Compatibility projection used by the existing Desktop state response. */
	readonly profile: PiharnessProfile;
}

export interface LoadProfileOptions {
	readonly homePatch?: string | false;
	readonly overlays?: readonly string[];
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function readJson(path: string): Promise<unknown> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		throw new Error(`Cannot read ${path}: ${message(error)}`);
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`${path} is not valid JSON: ${message(error)}`);
	}
}

function anchorRows(rows: unknown, patchPath: string): void {
	if (!Array.isArray(rows)) return;
	for (const row of rows) {
		if (!row || typeof row !== "object" || Array.isArray(row)) continue;
		const entry = row as { name?: unknown; group?: unknown; config?: unknown };
		if (typeof entry.name === "string" && entry.name.startsWith(".")) {
			entry.name = pathToFileURL(resolve(dirname(patchPath), entry.name)).href;
		}
		if (entry.group === true) anchorRows(entry.config, patchPath);
	}
}

async function loadPatchList(path: string, optional = false): Promise<DshPatchOptions[]> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw new Error(`Cannot read patch layer ${path}: ${message(error)}`);
	}
	let parsed: unknown;
	try {
		parsed = yaml.load(content, { schema: entryListSchema });
	} catch (error) {
		throw new Error(`Cannot parse patch layer ${path}: ${message(error)}`);
	}
	if (!Array.isArray(parsed)) throw new Error(`Patch layer ${path} must be a top-level array.`);
	for (const [index, patch] of parsed.entries()) {
		if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
			throw new Error(`Patch ${index + 1} in ${path} must be a mapping.`);
		}
		anchorRows((patch as { insert?: unknown }).insert, path);
	}
	return parsed as DshPatchOptions[];
}

async function resolveBundleDir(specifier: string, profileDir: string): Promise<string> {
	if (specifier === PERSONAL_BASE_BUNDLE) return internalBaseDir;
	if (isAbsolute(specifier)) return specifier;
	if (specifier.startsWith(".")) return resolve(profileDir, specifier);
	const require = createRequire(join(profileDir, "package.json"));
	for (const modulesDir of require.resolve.paths(specifier) ?? []) {
		const manifestPath = join(modulesDir, specifier, "package.json");
		try {
			await access(manifestPath);
			return dirname(manifestPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	try {
		return dirname(require.resolve(`${specifier}/package.json`));
	} catch (error) {
		throw new Error(`Cannot resolve bundle ${specifier} from ${profileDir}: ${message(error)}`);
	}
}

async function loadBundle(specifier: string, profileDir: string): Promise<ProfileLayer> {
	const bundleDir = await resolveBundleDir(specifier, profileDir);
	const manifestPath = join(bundleDir, "package.json");
	const result = bundlePackageSchema.safeParse(await readJson(manifestPath));
	if (!result.success) {
		throw new Error(`Bundle ${specifier} has no valid dsh.bundle.patch manifest: ${result.error.message}`);
	}
	const patchPath = resolve(bundleDir, result.data.dsh.bundle.patch);
	return { label: specifier, path: patchPath, patches: await loadPatchList(patchPath) };
}

function normalizeSettings(config: unknown, profileDir: string): PiharnessSettings {
	const result = settingsSchema.safeParse(config);
	if (!result.success) throw new Error(`The effective settings row is invalid: ${result.error.message}`);
	const { agent } = result.data;
	return {
		name: result.data.name,
		home: resolve(profileDir, result.data.home),
		agent: {
			provider: agent.provider,
			model: agent.model,
			...(agent.baseUrl === undefined ? {} : { baseUrl: agent.baseUrl }),
			...(agent.apiKeyEnv === undefined ? {} : { apiKeyEnv: agent.apiKeyEnv }),
			systemPrompt: resolveSystemPrompt(agent.systemPrompt),
			...(agent.thinkingLevel === undefined ? {} : { thinkingLevel: agent.thinkingLevel }),
			...(agent.toolExecution === undefined ? {} : { toolExecution: agent.toolExecution }),
		},
	};
}

function compose(layers: readonly ProfileLayer[]): { entries: DshEntryOptions[]; warnings: string[] } {
	const warnings: string[] = [];
	const patches = structuredClone(layers.flatMap((layer) => layer.patches)) as unknown as PatchOptions[];
	const entries = applyEntryPatches([], patches, (format, ...args) => {
		let index = 0;
		warnings.push(format.replace(/%C/g, () => JSON.stringify(args[index++])));
	}) as DshEntryOptions[];
	const ids = new Set<string>();
	for (const [index, entry] of entries.entries()) {
		if (!entry || typeof entry.id !== "string" || typeof entry.name !== "string") {
			throw new Error(`Effective Cordis row ${index + 1} needs string id and name fields.`);
		}
		if (ids.has(entry.id)) throw new Error(`Effective Cordis row id appears more than once: ${entry.id}`);
		ids.add(entry.id);
	}
	return { entries, warnings };
}

const legacyBuiltinRows: Readonly<Record<string, { readonly id: string; readonly name: string }>> = {
	"core.settings": { id: "settings", name: "cordis:piharness-settings" },
	"core.sessions": { id: "session", name: "cordis:piharness-session" },
	"core.prompts": { id: "system-prompt", name: "cordis:piharness-system-prompt" },
	"core.tools": { id: "tools", name: "cordis:piharness-tools" },
	"core.models": { id: "llm", name: "cordis:piharness-llm" },
	"model.pi-ai-builtins": { id: "llm-pi-ai-builtins", name: "cordis:piharness-llm-pi-ai-builtins" },
	"model.pi-ai-deepseek": { id: "llm-pi-ai-deepseek", name: "cordis:piharness-llm-pi-ai-deepseek" },
	"prompt.personal": { id: "persona", name: "cordis:piharness-persona" },
	"tool.workspace-info": { id: "workspace-info", name: "cordis:piharness-workspace-info" },
	"tool.workspace-tools-pi": { id: "workspace-tools", name: "cordis:piharness-workspace-tools-pi" },
	"tool.document-tools": { id: "document-tools", name: "cordis:piharness-document-tools" },
	"tool.full-edition-tools": { id: "full-edition-tools", name: "cordis:piharness-full-edition-tools" },
	"policy.permission-mode": { id: "permission-mode", name: "cordis:piharness-permission-mode" },
	"policy.allow-list": { id: "allow-list", name: "cordis:piharness-allow-list" },
	"runtime.pi": { id: "agent-loop", name: "cordis:piharness-agent-loop-pi" },
};

function legacyEntry(entry: PluginProfileEntry, baseDir: string): DshEntryOptions {
	if (entry.source) {
		if (entry.exportName && entry.exportName !== "default") {
			throw new Error(`Legacy plugin ${entry.id} uses exportName; migrate it to a default Cordis export.`);
		}
		const name = entry.source.startsWith("file:") || (!entry.source.startsWith(".") && !isAbsolute(entry.source))
			? entry.source
			: pathToFileURL(resolve(baseDir, entry.source)).href;
		return { id: entry.id, name, ...(entry.config === undefined ? {} : { config: entry.config }) };
	}
	const row = legacyBuiltinRows[entry.id];
	if (!row) throw new Error(`Unknown legacy built-in plugin: ${entry.id}`);
	return { ...row, ...(entry.config === undefined ? {} : { config: entry.config }) };
}

async function loadLegacy(path: string, parsed: unknown, options: LoadProfileOptions): Promise<LoadedProfile> {
	const result = legacyProfileSchema.safeParse(parsed);
	if (!result.success) throw new Error(`Invalid legacy profile ${path}: ${result.error.message}`);
	const baseDir = dirname(path);
	const rows = result.data.plugins.filter((entry) => entry.enabled !== false).map((entry) => legacyEntry({
		id: entry.id,
		...(entry.enabled === undefined ? {} : { enabled: entry.enabled }),
		...(entry.source === undefined ? {} : { source: entry.source }),
		...(entry.exportName === undefined ? {} : { exportName: entry.exportName }),
		...(entry.config === undefined ? {} : { config: entry.config as never }),
	}, baseDir));
	if (rows.some((row) => row.id === "agent-loop") && !rows.some((row) => row.id === "agent")) {
		rows.splice(rows.findIndex((row) => row.id === "agent-loop"), 0, {
			id: "agent",
			name: "cordis:piharness-agent",
		});
	}
	const settings = normalizeSettings(result.data.settings, baseDir);
	const layer: ProfileLayer = {
		label: "legacy-profile.json",
		path,
		patches: [{ insert: [{ id: "settings", name: "cordis:piharness-settings", config: settings }, ...rows.filter((row) => row.id !== "settings")] }],
	};
	return finalize(path, baseDir, result.data.settings.name, { bundles: [] }, [layer], true, options);
}

async function optionalExtraLayers(profileDir: string, options: LoadProfileOptions): Promise<ProfileLayer[]> {
	const layers: ProfileLayer[] = [];
	const homePatch = options.homePatch === false
		? undefined
		: resolve(options.homePatch ?? process.env.PIHARNESS_HOME ?? join(profileDir, ".home"), PROFILE_PATCH_FILENAME);
	if (homePatch && resolve(homePatch) !== resolve(profileDir, PROFILE_PATCH_FILENAME)) {
		const patches = await loadPatchList(homePatch, true);
		if (patches.length) layers.push({ label: "home patch", path: homePatch, patches });
	}
	for (const overlay of options.overlays ?? []) {
		const path = resolve(overlay);
		layers.push({ label: `overlay:${path}`, path, patches: await loadPatchList(path) });
	}
	return layers;
}

async function finalize(
	path: string,
	baseDir: string,
	name: string,
	manifest: DshProfileManifest,
	layers: ProfileLayer[],
	legacy: boolean,
	options: LoadProfileOptions,
): Promise<LoadedProfile> {
	layers.push(...(await optionalExtraLayers(baseDir, options)));
	let composed = compose(layers);
	const settingsRow = composed.entries.find((entry) => entry.id === "settings" && !entry.disabled);
	if (!settingsRow) throw new Error("The effective profile has no active settings row.");
	const settings = normalizeSettings(settingsRow.config, baseDir);
	const normalizedLayer: ProfileLayer = {
		label: "runtime path normalization",
		path,
		patches: [{ id: "settings", config: settings }],
	};
	layers.push(normalizedLayer);
	composed = compose(layers);
	const entries = composed.entries;
	return {
		path,
		baseDir,
		name,
		manifest,
		layers,
		patches: layers.flatMap((layer) => layer.patches),
		entries,
		warnings: composed.warnings,
		legacy,
		profile: {
			schemaVersion: 1,
			settings,
			plugins: entries.map((entry) => ({
				id: entry.id,
				enabled: !entry.disabled,
				...(entry.name.startsWith("cordis:") ? {} : { source: entry.name }),
				...(entry.config === undefined ? {} : { config: entry.config as never }),
			})),
		},
	};
}

/** Load a DSH-shaped profile directory, with read compatibility for the former profile.json. */
export async function loadProfile(inputPath: string, options: LoadProfileOptions = {}): Promise<LoadedProfile> {
	const absolute = resolve(inputPath);
	let info;
	try {
		info = await stat(absolute);
	} catch (error) {
		throw new Error(`Cannot access profile ${absolute}: ${message(error)}`);
	}
	if (info.isFile()) return loadLegacy(absolute, await readJson(absolute), options);
	if (!info.isDirectory()) throw new Error(`Profile path is not a file or directory: ${absolute}`);

	const manifestPath = join(absolute, "package.json");
	try {
		await access(manifestPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			const legacyPath = join(absolute, "profile.json");
			return loadLegacy(legacyPath, await readJson(legacyPath), options);
		}
		throw error;
	}
	const result = profilePackageSchema.safeParse(await readJson(manifestPath));
	if (!result.success) throw new Error(`Invalid DSH profile manifest ${manifestPath}: ${result.error.message}`);
	const rawManifest = result.data.dsh.profile;
	const manifest: DshProfileManifest = {
		bundles: rawManifest.bundles,
		...(rawManifest.patchReload === undefined ? {} : { patchReload: rawManifest.patchReload }),
	};
	const layers = await Promise.all(manifest.bundles.map((bundle) => loadBundle(bundle, absolute)));
	const profilePatch = join(absolute, PROFILE_PATCH_FILENAME);
	layers.push({ label: "profile patch", path: profilePatch, patches: await loadPatchList(profilePatch, true) });
	return finalize(manifestPath, absolute, result.data.name ?? "BuildMe", manifest, layers, false, options);
}

const DEFAULT_PROMPT = AGENT_PROMPT_PRESET;

/** Initialize the same package.json + cordis.patch.yml profile shape used by DSH. */
export async function initProfile(dir: string, name = "BuildMe"): Promise<string> {
	const absolute = resolve(dir);
	await mkdir(absolute, { recursive: true });
	const manifestPath = join(absolute, "package.json");
	const patchPath = join(absolute, PROFILE_PATCH_FILENAME);
	try {
		await access(manifestPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await writeFile(
			manifestPath,
			`${JSON.stringify({ name: "my-agent-profile", private: true, dependencies: {}, dsh: { profile: { bundles: [PERSONAL_BASE_BUNDLE], patchReload: "startup" } } }, null, 2)}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
	}
	try {
		await access(patchPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const patches: PatchOptions[] = [{
			id: "settings",
			config: {
				name,
				home: ".",
				agent: {
					provider: "deepseek",
					model: "deepseek-v4-flash",
					thinkingLevel: "off",
					toolExecution: "parallel",
					systemPrompt: DEFAULT_PROMPT,
				},
			},
		}];
		await writeFile(patchPath, yaml.dump(patches, { schema: entryListSchema, noRefs: true }), { encoding: "utf8", mode: 0o600 });
	}
	return absolute;
}

/** Legacy object creator retained only for callers upgrading from schemaVersion 1. */
export function createDefaultProfile(name = "BuildMe"): PiharnessProfile {
	return {
		schemaVersion: 1,
		settings: {
			name,
			home: ".",
			agent: {
				provider: "deepseek",
				model: "deepseek-v4-flash",
				thinkingLevel: "off",
				toolExecution: "parallel",
				systemPrompt: DEFAULT_PROMPT,
			},
		},
		plugins: [
			{ id: "core.settings" },
			{ id: "core.sessions" },
			{ id: "core.prompts" },
			{ id: "core.tools" },
			{ id: "core.models" },
			{ id: "model.pi-ai-builtins" },
			{ id: "prompt.personal" },
			{ id: "tool.workspace-info" },
			{ id: "tool.workspace-tools-pi" },
			{ id: "tool.document-tools" },
			{ id: "tool.full-edition-tools" },
			{ id: "policy.permission-mode" },
			{ id: "runtime.pi" },
		],
	};
}
