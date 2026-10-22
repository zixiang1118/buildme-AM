const promptFocus = (ctx) =>
  ctx.systemPrompt.register({
    name: "persona:focus",
    order: 20,
    text: "优先完成当前目标；不要扩大范围。遇到缺失事实时明确标注假设。",
  });

promptFocus.inject = ["systemPrompt"];

export default promptFocus;
