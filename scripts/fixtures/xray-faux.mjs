import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";

const plugin = (ctx) => {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage(Array.from({ length: 66 }, (_, index) => fauxToolCall("echo", { value: `tool ${index}` })), { stopReason: "toolUse" }),
    fauxAssistantMessage("local smoke complete"),
    fauxAssistantMessage("second turn complete"),
  ]);
  ctx.llm.register(faux.provider, "smoke");
  const disposers = [
    ctx.systemPrompt.register({ name: "smoke:base", order: 0, source: "base", text: ctx.settings.value.agent.systemPrompt }),
    ctx.systemPrompt.register({ name: "smoke:workspace", order: 1, source: "workspace", text: "验收环境：隔离的数据目录；所有响应由本地假模型生成。" }),
  ];
  disposers.push(ctx.tools.register({
    name: "echo", label: "Echo", description: "Local test", parameters: Type.Object({ value: Type.String() }),
    execute: async (_id, args) => {
      if (args.value === "tool 0") disposers.push(ctx.systemPrompt.register({ name: "smoke:next-turn", order: 2, source: "other", text: "这段提示词在第一回合执行工具后注册，从下一回合开始发送。" }));
      await new Promise((resolve) => setTimeout(resolve, 120));
      return { content: [{ type: "text", text: args.value }], details: {} };
    },
  }));
  return () => { for (const dispose of disposers) dispose(); };
};
plugin.inject = ["llm", "tools", "systemPrompt", "settings"];
export default plugin;
