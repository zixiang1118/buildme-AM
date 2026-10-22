import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
const plugin = (ctx) => {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "caps", contextWindow: 200000, maxTokens: 1000 }] });
  const respond = (context) => {
    const lastUser = context.messages.findLastIndex((message) => message.role === "user");
    if (!context.messages.slice(lastUser).some((message) => message.role === "toolResult")) return fauxAssistantMessage(fauxToolCall("workspace_info", {}), { stopReason: "toolUse" });
    return fauxAssistantMessage("本地假模型完成，未调用外部 API。");
  };
  faux.setResponses(Array.from({ length: 20 }, () => respond));
  return ctx.llm.register(faux.provider, "capabilities-smoke");
};
plugin.inject = ["llm"];
export default plugin;
