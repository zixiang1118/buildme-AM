import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
import { realpathSync } from "node:fs";
import { confinedPath } from "../dist/core/compare-policy.js";

// Mounted only in the DSH process launched inside the comparison's OS sandbox.
export default class ConfinedShell extends LocalBashExecutor {
  static inject = ["subprocess", "sandboxPolicy"];
  constructor(ctx, config) {
    super(ctx, config);
    if (!process.env.BUILDME_COMPARE_ISOLATION_ROOT) throw new Error("对比命令执行器缺少进程隔离边界。");
  }
  get sandboxMode() { return "workspace-write"; }
  resolve(request) {
    const spec = super.resolve(request);
    if (spec.sandboxPolicy?.mode !== "workspace-write") throw new Error("对比命令不能切换沙箱权限。");
    confinedPath(realpathSync(process.env.BUILDME_COMPARE_ISOLATION_ROOT), realpathSync(spec.workdir));
    return spec;
  }
  async run(spec) {
    const result = await super.run(spec);
    return { ...result, sandbox: { mode: "workspace-write", enforcement: "full", denied: /operation not permitted|permission denied/iu.test(result.stderr.text) } };
  }
  start() { throw new Error("对比命令必须在前台执行。"); }
}
