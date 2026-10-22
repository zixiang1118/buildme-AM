(() => {
  const examples = {
    documents: "请用文档工具读取工作区里的一份 PDF 或 Word 文档，概括它的重点。",
    search: "搜索这个项目里和配置加载相关的代码，告诉我入口在哪里。",
    web: "读取 https://example.com ，概括页面内容并注明来源。",
    todo: "帮我列一份了解这个项目的任务清单，完成一步就更新一次。",
    plan: "先了解这个项目，然后把改进方案保存为计划，暂时不要改代码。",
    skills: "查看可用的 Skill，选一个适合当前项目的并加载说明。",
    compaction: "整理我们前面的讨论，核对哪些结论仍需要保留。",
    subagents: "派一个子 Agent 了解项目结构，再把结论汇总给我。",
    workflow: "用工作流先分析项目结构，再根据分析结果列出改进建议。",
  };
  const exclusive = [
    ["web_search", "联网搜索", "先搜索网页线索，再读取相关页面。"],
    ["schedule", "定时任务", "在指定时间触发任务，或按周期重复执行。"],
    ["goal", "长期目标", "保存目标及其进展，让多轮任务围绕同一目标推进。"],
    ["subagent_fork", "继承上下文的子 Agent", "从主对话的上下文分出子任务。"],
    ["sandbox", "沙箱", "通过执行环境限制命令可访问的资源。"],
  ];
  window.createCapabilities = (api, { onChange, onExample, onCompare }) => {
    const $ = (selector) => document.querySelector(selector);
    const dialog = $("#capabilities-dialog"), onboarding = $("#capability-onboarding");
    const cards = new Map();
    let state, saving = false;
    function sync(next) {
      state = next;
      const registry = state.capabilityRegistry;
      if (!registry) return;
      if (!cards.size) {
        for (const definition of registry) {
          const info = window.XrayKnowledge.capabilities[definition.id];
          const card = document.createElement("article");
          card.className = "capability-card";
          card.dataset.capability = definition.id;
          const label = document.createElement("label");
          const title = document.createElement("strong"); title.textContent = definition.name;
          const input = document.createElement("input"); input.type = "checkbox"; input.setAttribute("role", "switch");
          input.setAttribute("aria-label", definition.name);
          label.append(title, input); card.append(label);
          for (const [heading, text] of [["是什么", info.what], ["打开前后有什么区别", info.why], ["在 Claude Code / Codex 里", info.correspondence]]) {
            const paragraph = document.createElement("p"), caption = document.createElement("b");
            caption.textContent = heading; paragraph.append(caption, document.createTextNode(text)); card.append(paragraph);
          }
          const footer = document.createElement("footer"), count = document.createElement("small");
          footer.append(count);
          if (definition.id !== "core") {
            const example = document.createElement("button"); example.type = "button"; example.className = "secondary-button"; example.textContent = "试试看";
            example.addEventListener("click", () => { dialog.close(); onExample(examples[definition.id]); });
            footer.append(example);
          }
          card.append(footer); $("#capability-cards").append(card);
          input.addEventListener("change", () => {
            const enabled = input.checked;
            const message = definition.id === "workflow" && enabled && !state.capabilities.includes("subagents")
              ? "工作流需要子 Agent，已一并打开。"
              : definition.id === "subagents" && !enabled && state.capabilities.includes("workflow")
                ? "子 Agent 和工作流已一并关闭。" : "已保存，从下一回合生效。";
            void save(() => api.setCapability(definition.id, enabled), message);
          });
          cards.set(definition.id, { input, count });
        }
        for (const [id, name, description] of exclusive) {
          const card = document.createElement("article"); card.className = "capability-card capability-exclusive"; card.dataset.exclusive = id;
          const title = document.createElement("strong"); title.textContent = name;
          const copy = document.createElement("p"); copy.textContent = description;
          const note = document.createElement("button"); note.type = "button"; note.className = "secondary-button"; note.textContent = "进入双引擎对比"; note.onclick = () => { dialog.close(); onCompare(`请结合当前工作区，说明你的「${name}」能力能如何帮助这个项目，并演示一个适合独立副本的前台任务。不要创建定时或后台任务。`); };
          card.append(title, copy, note); $("#capability-exclusive").append(card);
        }
      }
      const enabled = state.capabilities.filter((id) => id !== "core").length;
      const missing = registry.filter(({ id }) => !state.capabilities.includes(id)).map(({ name }) => name);
      $("#capability-progress-label").textContent = `已打开 ${enabled} / 9 项能力`;
      $("#capability-progress").value = enabled;
      $("#capability-remaining").textContent = missing.length ? `还可以开启：${missing.join("、")}` : "Pi 的九项扩展能力已全部开启。";
      $("#capability-chip").textContent = `你的 Agent · ${enabled}/9 能力`;
      $("#capability-chip").hidden = state.edition === "full";
      $("#capability-engine-note").hidden = state.edition !== "full";
      for (const [id, card] of cards) {
        card.input.checked = state.capabilities.includes(id);
        card.input.disabled = id === "core" || saving;
        card.count.textContent = id === "core" ? "始终开启" : `已使用 ${state.capabilityUsage[id] ?? 0} 次`;
      }
    }
    async function save(action, message) {
      if (saving) return;
      saving = true; sync(state);
      $("#capability-status").textContent = "正在保存…";
      $("#capability-onboarding-error").textContent = "";
      try {
        const result = await action();
        onChange(result);
        $("#capability-status").textContent = message;
        onboarding.close();
      } catch (error) {
        const message = error.message || String(error);
        $("#capability-status").textContent = message;
        $("#capability-onboarding-error").textContent = message;
      } finally { saving = false; sync(state); }
    }
    function open() { dialog.showModal(); }
    function guide() {
      if (state.capabilityOnboarding && state.edition !== "full" && !onboarding.open) onboarding.showModal();
    }
    $("#my-agent").addEventListener("click", open);
    $("#capability-chip").addEventListener("click", open);
    $("#capability-close").addEventListener("click", () => dialog.close());
    onboarding.addEventListener("cancel", (event) => event.preventDefault());
    for (const choice of ["minimal", "all"]) $("#capability-choose-" + choice).addEventListener("click", () => void save(() => api.chooseCapabilities(choice), "能力已保存，可以开始对话。"));
    api.onCapabilityUsage((counts) => onChange({ capabilityUsage: counts }));
    api.onXray((notification) => {
      if (notification.type !== "event" || notification.event.type !== "context.overflow" || state.capabilities.includes("compaction")) return;
      if ($("#capability-overflow")) return;
      const notice = document.createElement("aside"); notice.id = "capability-overflow"; notice.className = "capability-overflow"; notice.setAttribute("role", "status");
      const copy = document.createElement("span"); copy.textContent = "上下文超过上限了。这就是「上下文压缩」要解决的问题，要打开它吗？";
      const button = document.createElement("button"); button.type = "button"; button.className = "secondary-button"; button.textContent = "打开压缩";
      button.addEventListener("click", async () => {
        button.disabled = true;
        try { onChange(await api.setCapability("compaction", true)); copy.textContent = "已开启上下文压缩，下次发送时生效。本回合仍保留模型的实际结果。"; button.remove(); }
        catch (error) { copy.textContent = error.message || String(error); button.disabled = false; }
      });
      notice.append(copy, button); $("#messages").append(notice);
    });
    return { sync, guide };
  };
})();
