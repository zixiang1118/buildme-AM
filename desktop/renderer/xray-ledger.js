(() => {
  const number = (value) => value === undefined ? "未提供" : value.toLocaleString("zh-CN");
  const node = (tag, className, text) => { const item = document.createElement(tag); item.className = className; if (text !== undefined) item.textContent = text; return item; };
  const USAGE = [["inputTokens", "输入（不含缓存）"], ["outputTokens", "输出"], ["cacheReadTokens", "缓存读取"], ["cacheWriteTokens", "缓存写入"]];
  function usageCard(usage) {
    const box = node("dl", "ledger-usage");
    for (const [key, label] of USAGE) box.append(node("dt", "", label), node("dd", "", number(usage[key])));
    return box;
  }
  window.XrayLedger = (host, api, { onEvent, onExperiment }) => {
    const intro = node("div", "xray-inspect-intro");
    intro.append(node("strong", "", "Token 去哪儿了"), node("p", "", "本地账单 · 查看不消耗 token。先看任务是否完成，再比较开销；少用 token 不一定效果更好。"));
    const refresh = node("button", "xray-small-action", "刷新记录"), status = node("p", "ledger-status"), content = node("div", "ledger-content");
    refresh.type = "button"; host.append(intro, refresh, status, content);
    let current, version = 0, renderedKey;
    function jump(label, turnId, eventIds) {
      const button = node("button", "xray-small-action", label); button.type = "button";
      button.onclick = () => onEvent(turnId, eventIds);
      return button;
    }
    function draw(data) {
      content.replaceChildren();
      const totals = node("section", "ledger-section");
      totals.append(node("h3", "", "本回合与已记录子 Agent"), usageCard(data.total));
      totals.append(node("p", "xray-muted", data.complete ? "父子回合去重后汇总。缺少任何一项报告时，该项合计显示未提供。" : "子任务记录不完整，无法给出整个任务的合计；下方保留已知回合。"));
      totals.append(node("p", "xray-muted", "单位为 tokens；缓存读写单列，不再加进普通输入。供应商未报告的缓存项不补 0，不推算金额。"));
      if (data.missing.length) totals.append(node("p", "xray-context-alert", `${data.missing.length} 个关联子回合已不可用。`));
      content.append(totals);
      for (const agent of data.agents) {
        const section = node("details", "ledger-agent"); section.open = agent.turnId === data.turnId;
        section.append(node("summary", "", `${agent.label} · ${agent.model.id}`));
        section.append(node("p", "xray-muted", `${agent.fidelity === "estimated" ? "估算用量" : "模型报告用量"} · ${agent.requestCount} 次已记录请求${agent.completeUsage ? "" : ` · 仅汇总已报告的 ${agent.reportedCalls} 次，另有 ${agent.missingCalls} 次尚未报告用量`}`), usageCard(agent.usage));
        if (!agent.completeUsage) section.append(node("p", "xray-context-alert", "以下是部分已知用量，不是完整总量。取消或出错的请求可能没有返回用量，不计为 0。"));
        section.append(node("h3", "", "哪些请求输入最多"), node("p", "xray-muted", "按输入量排序；含已报告的缓存读写。没有实测的请求按上下文估算排序，并单独标注。"));
        if (!agent.calls.length) section.append(node("p", "xray-empty", "没有模型请求记录。"));
        const max = Math.max(1, ...agent.calls.map((call) => call.reportedInput ?? call.estimatedInput));
        for (const call of agent.calls) {
          const row = node("details", "ledger-call"), title = node("summary", "");
          title.append(node("span", "", `第 ${call.round} 次调用`), node("strong", "", `${call.reportedInput === undefined ? "估算约 " : "实测 "}${number(call.reportedInput ?? call.estimatedInput)}`));
          const bar = node("span", "ledger-bar"); bar.style.width = `${(call.reportedInput ?? call.estimatedInput) / max * 100}%`;
          row.append(title, bar);
          if (call.usage) row.append(usageCard({ inputTokens: call.usage.input, outputTokens: call.usage.output, cacheReadTokens: call.usage.cacheRead, cacheWriteTokens: call.usage.cacheWrite }));
          const breakdown = node("dl", "ledger-usage");
          for (const [key, label] of [["systemPrompt", "系统提示词"], ["toolDefinitions", "工具定义"], ["userMessages", "用户消息"], ["assistantMessages", "助手消息"], ["toolResults", "工具结果"], ["summary", "摘要"]]) breakdown.append(node("dt", "", label), node("dd", "", `约 ${number(call.context[key])}`));
          row.append(node("p", "xray-muted", "下面按内容估算占用，不是各项实际费用。"), breakdown, jump("在 X 光里看这次调用", agent.turnId, [call.eventId])); section.append(row);
        }
        section.append(node("h3", "", "哪些工具输出占用较多"));
        if (!agent.toolOutputs.length) section.append(node("p", "xray-empty", "没有工具输出记录。"));
        for (const output of agent.toolOutputs) {
          const row = node("section", "ledger-source");
          row.append(node("strong", "", output.label));
          row.append(node("p", "", output.source === "context"
            ? `在 ${output.rounds.length} 次请求中出现，累计占用约 ${number(output.cumulative)} tokens；单次最多约 ${number(output.estTokens)}。`
            : `已保存的输出约 ${number(output.estTokens)} tokens；没有逐条入模记录，不能据此判断实际发送量。`));
          if (output.truncated) row.append(node("p", "xray-muted", "保存的工具结果已截断。"));
          if (output.eventId) row.append(jump("查看这份工具结果", agent.turnId, [output.eventId]));
          section.append(row);
        }
        section.append(node("h3", "", "哪些内容被重复带入"));
        section.append(node("p", "xray-muted", `逐条占用已覆盖 ${agent.contextCoverage} / ${agent.requestCount} 次请求。只匹配内容完全相同的消息；重复不等于浪费，命中缓存也仍占上下文。`));
        if (!agent.repeated.length) section.append(node("p", "xray-empty", agent.contextCoverage ? "已记录请求中没有发现完全相同的重复消息。" : "这段历史没有逐条占用数据；新运行会记录不含正文的占用信息。"));
        for (const item of agent.repeated) {
          const row = node("details", "ledger-source");
          row.append(node("summary", "", `${item.label} · ${item.rounds.length} 次 · 累计约 ${number(item.cumulative)}`), node("p", "", `每次约 ${number(item.estTokens)} tokens。以下是实际出现它的请求，数字不代表额外计费。`));
          const links = node("div", "ledger-links");
          item.rounds.forEach((round, index) => links.append(jump(`第 ${round} 次`, agent.turnId, [item.eventIds[index]])));
          row.append(links); section.append(row);
        }
        content.append(section);
      }
      const experiment = node("section", "ledger-experiment");
      experiment.append(node("h3", "", "换一种读法，验证一下"), node("p", "", "在当前工作区的新副本里，用同一模型比较直接读取与先搜索再读取。先检查作品和完成情况，再比较用量。"));
      const button = node("button", "secondary-button", "先搜索，再试一次…"); button.type = "button";
      button.onclick = () => onExperiment(current, data.total);
      experiment.append(button, node("p", "xray-muted", "下一步先预览任务、模型与额外用量，点击同时运行后才调用模型。")); content.append(experiment);
    }
    async function load() {
      const token = ++version; refresh.disabled = true; status.textContent = "正在读取本地用量记录…";
      try {
        const data = await api.xrayLedger(current.id);
        if (token !== version || !host.isConnected) return;
        draw(data); status.textContent = "内容占用按字符与序列化结构估算；图片等内容不等同于实际计费 token。";
      } catch (error) { if (token === version && host.isConnected) status.textContent = `读取失败：${error.message}。可点击刷新记录重试。`; }
      finally { if (token === version) refresh.disabled = false; }
    }
    refresh.onclick = () => void load();
    return { refresh(turn) {
      current = turn;
      const key = `${turn.id}:${turn.status}`;
      if (key === renderedKey) return;
      renderedKey = key;
      if (turn.status === "running") { status.textContent = "本回合正在运行，结束后自动生成账单。"; refresh.disabled = true; return; }
      void load();
    } };
  };
})();
