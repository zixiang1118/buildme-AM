#!/usr/bin/env node

import { access, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createApp } from "./bootstrap.js";
import { applyProxyFromEnv } from "./core/network-proxy.js";
import type { HostedPluginEntry } from "./plugin-host.js";
import { initProfile, loadProfile, PROFILE_PATCH_FILENAME } from "./profile.js";

const DEFAULT_PROFILE = ".piharness";

applyProxyFromEnv();

type OptionKind = "flag" | "value";
type OptionSpec = Readonly<Record<string, OptionKind>>;

interface ParsedArguments {
	readonly positionals: readonly string[];
	readonly options: ReadonlyMap<string, string | true>;
}

function usage(): string {
	return `
PiHarness — Pi Agent Core + Cordis plugin-first personal harness

用法：
  piharness init [--home <目录>] [--force]
  piharness run [--profile <profile目录>] [--patch <覆盖层>] [--session <会话ID>] [--] <提示词>
  piharness plugins list|graph|doctor [--profile <profile目录>] [--patch <覆盖层>]
  piharness plugins explain <条目ID> [--profile <profile目录>] [--patch <覆盖层>]
  piharness sessions list|show|inspect|unlock [--profile <profile目录>]
  piharness profile show [--profile <profile目录>] [--patch <覆盖层>]
`;
}

function parseArguments(args: readonly string[], spec: OptionSpec): ParsedArguments {
	const positionals: string[] = [];
	const options = new Map<string, string | true>();
	let rawPositionals = false;
	for (let index = 0; index < args.length; index += 1) {
		const current = args[index];
		if (!current) continue;
		if (rawPositionals) {
			positionals.push(current);
			continue;
		}
		if (current === "--") {
			rawPositionals = true;
			continue;
		}
		if (!current.startsWith("--")) {
			positionals.push(current);
			continue;
		}
		const equals = current.indexOf("=");
		const name = equals < 0 ? current : current.slice(0, equals);
		const inlineValue = equals < 0 ? undefined : current.slice(equals + 1);
		const kind = spec[name];
		if (!kind) throw new Error(`未知选项：${name}`);
		if (options.has(name)) throw new Error(`选项 ${name} 只能出现一次。`);
		if (kind === "flag") {
			if (inlineValue !== undefined) throw new Error(`选项 ${name} 不接受值。`);
			options.set(name, true);
			continue;
		}
		const value = inlineValue ?? args[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`${name} 需要一个值。`);
		if (inlineValue === undefined) index += 1;
		options.set(name, value);
	}
	return { positionals, options };
}

function option(args: ParsedArguments, name: string): string | undefined {
	const value = args.options.get(name);
	return typeof value === "string" ? value : undefined;
}

function flag(args: ParsedArguments, name: string): boolean {
	return args.options.get(name) === true;
}

function expectPositionals(args: ParsedArguments, minimum: number, maximum = minimum): readonly string[] {
	if (args.positionals.length < minimum || args.positionals.length > maximum) {
		throw new Error(`此命令需要 ${minimum === maximum ? minimum : `${minimum}-${maximum}`} 个位置参数。`);
	}
	return args.positionals;
}

function profilePath(args: ParsedArguments): string {
	return resolve(option(args, "--profile") ?? process.env.PIHARNESS_PROFILE ?? DEFAULT_PROFILE);
}

async function profileApp(args: ParsedArguments) {
	const overlay = option(args, "--patch");
	const profile = await loadProfile(profilePath(args), overlay ? { overlays: [overlay] } : {});
	return createApp(profile);
}

async function commandInit(rawArgs: readonly string[]): Promise<void> {
	const args = parseArguments(rawArgs, { "--home": "value", "--force": "flag" });
	expectPositionals(args, 0);
	const home = resolve(option(args, "--home") ?? ".piharness");
	const path = resolve(home, "package.json");
	try {
		await access(path);
		if (!flag(args, "--force")) throw new Error(`${path} 已存在；使用 --force 覆盖。`);
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await mkdir(home, { recursive: true });
	if (flag(args, "--force")) {
		await Promise.all([rm(path, { force: true }), rm(join(home, PROFILE_PATCH_FILENAME), { force: true })]);
	}
	await initProfile(home);
	console.log(`已创建 DSH profile：${home}`);
	console.log(
		"请在 Desktop 中添加模型连接，或设置所选服务商的 API Key 环境变量后运行：piharness run \"你好\"",
	);
}

async function commandRun(rawArgs: readonly string[]): Promise<void> {
	const args = parseArguments(rawArgs, { "--profile": "value", "--patch": "value", "--session": "value" });
	const prompt = args.positionals.join(" ");
	if (!prompt) throw new Error("run 需要一个提示词。用 -- 可保留以 -- 开头的原始提示词。");
	const app = await profileApp(args);
	let sawText = false;
	const off = app.ctx.on("piharness/agent-event", (_sessionId, event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			sawText = true;
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});
	try {
		const sessionId = option(args, "--session");
		const result = await app.ctx.agents.run(prompt, sessionId === undefined ? undefined : { sessionId });
		if (!sawText && result.text) process.stdout.write(result.text);
		process.stdout.write(`\n\n会话：${result.sessionId}\n`);
	} finally {
		off();
		await app.stop();
	}
}

function printPluginExplanation(entry: HostedPluginEntry): void {
	const manifest = entry.plugin?.manifest;
	console.log(
		JSON.stringify(
			{
				id: entry.entry.id,
				name: entry.entry.name,
				state: entry.state,
				kind: manifest?.kind ?? null,
				version: manifest?.version ?? null,
				description: manifest?.description ?? null,
				source: entry.sourceLabel,
				inject: entry.entry.inject ?? manifest?.inject ?? [],
				provides: manifest?.provides ?? [],
				disabled: Boolean(entry.entry.disabled),
				config: entry.entry.config ?? null,
			},
			null,
			2,
		),
	);
}

function printPluginGraph(entries: readonly HostedPluginEntry[]): void {
	const nodeByPlugin = new Map(entries.map((entry, index) => [entry.entry.id, `p${index}`]));
	const providerByService = new Map<string, string>();
	for (const entry of entries) {
		for (const service of entry.plugin?.manifest.provides ?? []) {
			if (!service.includes(":")) providerByService.set(service, entry.entry.id);
		}
	}
	console.log("graph TD");
	for (const entry of entries) {
		const node = nodeByPlugin.get(entry.entry.id)!;
		console.log(`  ${node}["${entry.entry.id}"]`);
	}
	for (const entry of entries) {
		const consumer = nodeByPlugin.get(entry.entry.id)!;
		const inject = Array.isArray(entry.entry.inject) ? entry.entry.inject : entry.plugin?.manifest.inject ?? [];
		for (const requirement of inject) {
			if (typeof requirement !== "string") continue;
			const provider = providerByService.get(requirement);
			const providerNode = provider ? nodeByPlugin.get(provider) : undefined;
			if (providerNode) console.log(`  ${providerNode} -->|${requirement}| ${consumer}`);
		}
	}
}

async function commandPlugins(rawArgs: readonly string[]): Promise<void> {
	const args = parseArguments(rawArgs, { "--profile": "value", "--patch": "value" });
	const [action = "list", requestedId] = args.positionals;
	if (args.positionals.length > (action === "explain" ? 2 : 1)) throw new Error("plugins 收到多余的位置参数。");
	const app = await profileApp(args);
	try {
		if (action === "list") {
			for (const entry of app.host.list()) {
				const manifest = entry.plugin?.manifest;
				console.log(`${entry.entry.id}\t${entry.state}\t${manifest?.kind ?? "plugin"}\t${entry.entry.name}`);
			}
			return;
		}
		if (action === "explain") {
			if (!requestedId) throw new Error("plugins explain 需要插件 ID。");
			const entry = app.host.list().find((candidate) => candidate.entry.id === requestedId);
			if (!entry) throw new Error(`当前 profile 未启用插件：${requestedId}`);
			printPluginExplanation(entry);
			return;
		}
		if (action === "graph") {
			printPluginGraph(app.host.list());
			return;
		}
		if (action === "doctor") {
			for (const diagnostic of app.host.diagnostics()) {
				console.log(`[${diagnostic.severity}] ${diagnostic.pluginId}: ${diagnostic.message}`);
			}
			try {
				const agent = app.ctx.settings.value.agent;
				const model = app.ctx.llm.resolve(agent.provider, agent.model);
				console.log(`[info] model: ${model.provider}/${model.id}`);
				console.log(`[info] credentials: ${await app.ctx.llm.authSummary(agent.provider)}`);
			} catch (error) {
				console.log(`[error] model: ${error instanceof Error ? error.message : String(error)}`);
			}
			await mkdir(app.ctx.sessions.root, { recursive: true });
			console.log(`[info] session root: ${app.ctx.sessions.root}`);
			return;
		}
		throw new Error(`未知 plugins 操作：${action}`);
	} finally {
		await app.stop();
	}
}

function printSessionSummary(session: Awaited<ReturnType<Awaited<ReturnType<typeof profileApp>>["ctx"]["sessions"]["list"]>>[number]): void {
	const lock = session.lock ? `\tlocked pid=${session.lock.pid}` : "";
	const error = session.error ? `\t${session.error}` : "";
	console.log(`${session.id}\t${session.health}\t${session.eventCount} events\t${session.updatedAt}${lock}${error}`);
}

async function commandSessions(rawArgs: readonly string[]): Promise<void> {
	const args = parseArguments(rawArgs, { "--profile": "value", "--patch": "value", "--force": "flag" });
	const [action = "list", sessionId] = args.positionals;
	if (args.positionals.length > (action === "list" ? 1 : 2)) throw new Error("sessions 收到多余的位置参数。");
	if (flag(args, "--force") && action !== "unlock") throw new Error("--force 只用于 sessions unlock。");
	const app = await profileApp(args);
	try {
		if (action === "list") {
			const sessions = await app.ctx.sessions.list();
			if (sessions.length === 0) console.log("暂无会话。");
			for (const session of sessions) printSessionSummary(session);
			return;
		}
		if (!sessionId) throw new Error(`sessions ${action} 需要会话 ID。`);
		if (action === "show") {
			for (const event of await app.ctx.sessions.read(sessionId)) {
				console.log(JSON.stringify(event));
			}
			return;
		}
		if (action === "inspect") {
			console.log(JSON.stringify(await app.ctx.sessions.inspect(sessionId), null, 2));
			return;
		}
		if (action === "unlock") {
			if (!flag(args, "--force")) throw new Error("sessions unlock 要求显式传入 --force。");
			const removed = await app.ctx.sessions.forceUnlock(sessionId);
			console.log(removed ? `已移除会话锁：${sessionId}` : `会话没有锁：${sessionId}`);
			return;
		}
		throw new Error(`未知 sessions 操作：${action}`);
	} finally {
		await app.stop();
	}
}

async function commandProfile(rawArgs: readonly string[]): Promise<void> {
	const args = parseArguments(rawArgs, { "--profile": "value", "--patch": "value" });
	const [action = "show"] = expectPositionals(args, 0, 1);
	if (action !== "show") throw new Error(`未知 profile 操作：${action}`);
	const overlay = option(args, "--patch");
	const profile = await loadProfile(profilePath(args), overlay ? { overlays: [overlay] } : {});
	console.log(JSON.stringify({
		name: profile.name,
		manifest: profile.manifest,
		legacy: profile.legacy,
		layers: profile.layers.map((layer) => ({ label: layer.label, path: layer.path })),
		settings: profile.profile.settings,
		entries: profile.entries,
		warnings: profile.warnings,
	}, null, 2));
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const [command, ...rest] = args;
	if (!command || command === "help" || command === "--help" || command === "-h") {
		console.log(usage());
		return;
	}
	switch (command) {
		case "init":
			await commandInit(rest);
			return;
		case "run":
			await commandRun(rest);
			return;
		case "plugins":
			await commandPlugins(rest);
			return;
		case "sessions":
			await commandSessions(rest);
			return;
		case "profile":
			await commandProfile(rest);
			return;
		default:
			throw new Error(`未知命令：${command}`);
	}
}

main().catch((error: unknown) => {
	console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
