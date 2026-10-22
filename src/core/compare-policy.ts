import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { createRequire } from "node:module";
// DSH and Pi own different Cordis service declarations; share the runtime provider without merging their host types.
type SandboxModule = {
	LocalSandboxProvider: { Config(input: object): object; new (ctx: Context, config: object): { confine(argv: readonly string[], policy: { mode: "workspace-write"; workspaceRoot: string }): { argv: string[]; enforcement: "full" | "partial" } }; };
};

export interface ComparePolicy { readonly workspaceRoot: string; readonly readOnly: boolean }
export function within(root: string, path: string): boolean {
	const part = relative(root, path); return part === "" || (part !== ".." && !part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(part));
}
export function confinedPath(root: string, input: string): string {
	if (input.startsWith("~") || input.startsWith("file:")) throw new Error("对比工作区不接受路径别名。");
	const target = resolve(root, input);
	if (!within(root, target)) throw new Error("路径超出对比副本。");
	let path = target;
	for (;;) {
		try {
			const info = lstatSync(path);
			if (info.isSymbolicLink() || !within(realpathSync(root), realpathSync(path))) throw new Error("对比副本禁止符号链接路径。");
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		if (path === root) break;
		path = dirname(path);
	}
	return target;
}
const READ = new Set(["read", "read_image", "document_read", "workspace_info", "files_search", "glob", "grep", "web_fetch", "web_search", "skill_catalog", "skill_load", "skill", "platform_catalog"]);
const WRITE = new Set(["write", "edit", "todo_manage", "plan_manage", "todo", "platform_propose", "platform_execute"]);
const DELEGATE = new Set(["delegate_task", "workflow_run", "subagent", "subagent_fork", "subagent_status", "subagent_wait", "subagent_cancel", "workflow", "run_code"]);
export function compareDenial(policy: ComparePolicy, name: string, args: unknown): string | undefined {
	const input = args as Record<string, unknown>;
	if (!READ.has(name) && !WRITE.has(name) && !DELEGATE.has(name) && name !== "bash") return "该工具尚未提供可验证的对比隔离边界。";
	if (input.run_in_background === true) return "对比回合只支持前台子任务，请设置 run_in_background: false。";
	if (["subagent", "subagent_fork"].includes(name) && input.run_in_background !== false) return "对比子任务需要显式设置 run_in_background: false，确保停止会取消整个任务。";
	if (input.sandbox_permissions !== undefined) return "对比副本不能升级沙箱权限。";
	if (policy.readOnly && (["bash", "workflow", "run_code"].includes(name) || WRITE.has(name)) && !(["todo_manage", "plan_manage"].includes(name) && input.action === "read")) return "此对比为强制只读，写入与命令执行已禁用。";
	for (const field of ["path", "file_path", "workdir", "cwd", "sourcePath"]) {
		if (typeof input[field] === "string") {
			try { confinedPath(policy.workspaceRoot, input[field]); } catch (error) { return (error as Error).message; }
		}
	}
	return undefined;
}
let sandbox: InstanceType<SandboxModule["LocalSandboxProvider"]>;
export function confineCompareCommand(argv: readonly string[], workspaceRoot: string): string[] {
	if (!sandbox) {
		const { LocalSandboxProvider } = createRequire(import.meta.url)("@deepseek-ai/dsh-sandbox-local") as SandboxModule;
		sandbox = new LocalSandboxProvider(new Context(), LocalSandboxProvider.Config({}));
	}
	const confined = sandbox.confine(argv, { mode: "workspace-write", workspaceRoot });
	if (confined.enforcement !== "full") throw new Error("当前平台沙箱不能保证完整隔离，此对比禁止命令执行。");
	if (process.platform === "darwin") {
		const root = JSON.stringify(realpathSync(workspaceRoot));
		const profile = `(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null") (subpath ${root}))`;
		return ["sandbox-exec", "-p", profile, ...argv];
	}
	if (process.platform === "linux" && confined.argv.includes("--tmpfs")) return confined.argv;
	throw new Error("当前沙箱允许共享临时目录写入，无法保证对比副本完全隔离，已拒绝命令。");
}
export function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
