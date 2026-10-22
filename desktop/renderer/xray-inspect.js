(() => {
  const SOURCES = { base: "基础提示词", capability: "能力", workspace: "工作区", persona: "角色设定", "skill-catalog": "Skill 目录", dsh: "完全体引擎", other: "其他来源" };
  const PARTS = [["systemPrompt", "系统提示词"], ["toolDefinitions", "工具定义"], ["userMessages", "你的消息"], ["assistantMessages", "Agent 消息"], ["toolResults", "工具结果"], ["summary", "压缩摘要"]];
  const number = (value) => value.toLocaleString("zh-CN");
  const node = (tag, className, text) => {
    const result = document.createElement(tag);
    result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  };
  function textDetail(title, text, className = "") {
    const result = node("details", `xray-detail ${className}`), pre = node("pre", "", text);
    pre.tabIndex = 0;
    result.append(node("summary", "", title), pre);
    return result;
  }
  function action(label, run) {
    const button = node("button", "xray-small-action", label), feedback = node("span", "xray-action-status");
    button.type = "button";
    feedback.setAttribute("role", "status");
    button.addEventListener("click", async () => {
      button.disabled = true;
      feedback.textContent = "";
      try { feedback.textContent = await run(); }
      catch (error) { feedback.textContent = `操作失败：${error.message}`; }
      finally { button.disabled = false; }
    });
    const group = node("div", "xray-action-group");
    group.append(button, feedback);
    return group;
  }
  function copy(label, text, api) {
    return action(label, async () => { await api.writeClipboardText(text()); return "已复制"; });
  }
  function unavailable(host, text) { host.append(node("p", "xray-empty", text)); }

  function prompt(host, turn, { api, previous }) {
    const container = node("div", "xray-prompt-content");
    host.append(container);
    host = container;
    if (!turn.fidelity.promptSegments) {
      unavailable(host, `${turn.engine === "dsh" ? "完全体引擎" : "当前引擎"}没有提供提示词分段`);
      return;
    }
    const segments = turn.promptSegments;
    const total = segments.reduce((sum, segment) => sum + segment.estTokens, 0);
    const intro = node("div", "xray-inspect-intro");
    intro.append(node("strong", "", `${segments.length} 段 · 约 ${number(total)} tokens`), node("p", "", "这些段落按实际发送顺序组成系统提示词。下方内容已脱敏，token 为采集时的估算值。"));
    intro.append(copy("复制已脱敏全文", () => segments.map((segment) => segment.text).join("\n\n"), api), window.XrayHelp("prompt.assembly"));
    host.append(intro);
    const bars = node("div", "xray-proportion");
    bars.setAttribute("aria-label", "提示词各段的估算 token 占比");
    const shares = segments.map((segment) => total ? segment.estTokens / total * 1000 : 0);
    const units = shares.map(Math.floor);
    if (total) {
      const ranked = shares.map((value, index) => ({ index, fraction: value - units[index] })).sort((a, b) => b.fraction - a.fraction);
      const remainder = 1000 - units.reduce((sum, value) => sum + value, 0);
      for (let index = 0; index < remainder; index++) units[ranked[index].index] += 1;
    }
    const cards = new Map();
    const compare = node("p", "xray-diff-status", turn.turnIndex === 1 ? "这是第一回合，没有上一回合可对比。" : "正在读取上一回合…");
    host.append(bars, compare);
    if (!segments.length) unavailable(host, "本回合没有系统提示词段落。" );
    segments.forEach((segment, index) => {
      const part = node("span", `xray-swatch xray-color-${index % 6}`);
      part.style.width = `${units[index] / 10}%`;
      part.title = `${segment.name} · ${units[index] / 10}%`;
      part.setAttribute("aria-label", part.title);
      bars.append(part);
      const card = node("details", `xray-segment xray-color-${index % 6}`);
      card.dataset.segmentName = segment.name;
      card.dataset.segmentIndex = String(index);
      const heading = node("summary", "");
      const name = node("strong", "", segment.name), badge = node("span", "xray-diff-badge");
      const meta = node("span", "xray-segment-meta", `${SOURCES[segment.source]}${segment.capabilityId ? ` · ${segment.capabilityId}` : ""} · 约 ${number(segment.estTokens)} tokens · ${units[index] / 10}%`);
      heading.append(name, badge, meta);
      const body = node("div", "xray-segment-body"), text = node("pre", "xray-segment-text", segment.text);
      text.tabIndex = 0;
      body.append(window.XrayHelp("prompt.segment", segment.capabilityId), text);
      if (segment.sourcePath) {
        const path = node("p", "xray-source-path", segment.sourcePath);
        const sourceState = node("p", "xray-muted", "正在读取来源信息…");
        body.append(path, copy("复制来源路径", () => path.textContent, api), sourceState);
        void api.xrayPromptSource(turn.id, index, false).then((info) => {
          path.textContent = info.path;
          sourceState.textContent = info.readOnly ? "随应用内置的文件，只提供路径复制。" : "打开当前源文件；历史提示词快照不会随文件修改而改变。";
          if (!info.readOnly) body.append(action("打开源文件", async () => { await api.xrayPromptSource(turn.id, index, true); return "已交给系统默认编辑器"; }));
        }, (error) => { sourceState.textContent = `无法打开来源：${error.message}`; });
      } else body.append(node("p", "xray-muted", "此段没有记录来源文件路径。"));
      card.append(heading, body);
      host.append(card);
      cards.set(segment.name, { card, badge, body, segment });
    });
    if (turn.turnIndex > 1) void previous().then((before) => {
      if (!before) { compare.textContent = "上一回合记录缺失，未做差异判断。"; return; }
      if (!before.fidelity.promptSegments) { compare.textContent = "上一回合未提供提示词分段，未做差异判断。"; return; }
      const old = new Map(before.promptSegments.map((segment) => [segment.name, segment]));
      let added = 0, changed = 0, removed = 0;
      for (const [name, entry] of cards) {
        const prior = old.get(name);
        if (!prior) {
          entry.badge.textContent = "本轮新增"; entry.card.dataset.change = "added"; added += 1;
        } else if (["text", "source", "capabilityId", "sourcePath"].some((key) => prior[key] !== entry.segment[key])) {
          entry.badge.textContent = "本轮修改"; entry.card.dataset.change = "changed"; changed += 1;
          entry.body.append(textDetail("上一回合的文本", prior.text));
        }
        old.delete(name);
      }
      for (const segment of old.values()) {
        const card = textDetail(`${segment.name} · 本轮移除`, segment.text, "xray-removed");
        card.dataset.turnId = before.id;
        card.dataset.segmentIndex = String(before.promptSegments.indexOf(segment));
        card.append(window.XrayHelp("prompt.segment", segment.capabilityId));
        card.dataset.change = "removed";
        host.append(card); removed += 1;
      }
      compare.textContent = `对比第 ${before.turnIndex} 回合：新增 ${added} · 修改 ${changed} · 移除 ${removed}。移除的段落不计入本轮占比。`;
    }, (error) => { compare.textContent = `上一回合读取失败：${error.message}`; });
  }

  function context(host) {
    host.append(node("p", "xray-inspect-intro", "每次调用模型，都要提供本次所需的上下文。输入变长通常会增加开销，缓存也会影响实际费用和速度。图中用量是估算值，上限已扣除回复预留。"));
    const legend = node("div", "xray-legend");
    PARTS.forEach(([, label], index) => legend.append(node("span", `xray-color-${index}`, label)));
    const content = node("div", "xray-context-calls");
    host.append(legend, content);
    const seen = new Set();
    let empty;
    return { refresh(turn) {
      for (const event of turn.events) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        if (event.type === "llm.request") {
          const data = event.context, limitKnown = data.limit > 0;
          const ratio = limitKnown ? data.total / data.limit : 0;
          const card = node("section", `xray-context-call${ratio > .8 ? " xray-context-warning" : ""}`);
          card.dataset.eventId = event.id;
          const title = node("div", "xray-event-heading");
          title.append(node("strong", "", `第 ${event.round} 次模型调用`), node("span", "", limitKnown ? `${(ratio * 100).toFixed(1)}%` : "上限未知"));
          card.append(title, node("p", "xray-context-total", `约 ${number(data.total)} / ${limitKnown ? number(data.limit) : "未提供"} tokens`));
          const chart = node("div", "xray-context-bar");
          chart.setAttribute("role", "img");
          chart.setAttribute("aria-label", PARTS.map(([key, label]) => `${label} ${data[key]}`).join("，") + `；上限 ${limitKnown ? data.limit : "未知"}`);
          const denominator = Math.max(data.total, limitKnown ? data.limit : 0);
          PARTS.forEach(([key, label], index) => {
            const part = node("span", `xray-swatch xray-color-${index}`);
            part.style.width = `${denominator ? data[key] / denominator * 100 : 0}%`;
            part.title = `${label} · 约 ${number(data[key])} tokens`;
            chart.append(part);
          });
          card.append(chart);
          if (ratio > .8) card.append(node("p", "xray-context-alert", ratio > 1 ? "估算内容已超过可用上下文上限。" : "上下文已超过 80%，后续可能需要压缩。"));
          const counts = node("dl", "xray-context-counts");
          for (const [key, label] of PARTS) counts.append(node("dt", "", label), node("dd", "", number(data[key])));
          const details = node("details", "xray-detail");
          details.append(node("summary", "", "查看各部分用量"), counts);
          card.append(details, window.XrayHelp("context.usage")); content.append(card);
        } else if (event.type === "context.compacted") {
          const marker = node("section", "xray-context-compaction");
          marker.append(node("strong", "", `上下文压缩 · ${event.coveredMessages} 条消息`), node("p", "", `${number(event.tokensBefore)} → ${event.tokensAfter === undefined ? "压缩后用量未提供" : `${number(event.tokensAfter)} tokens`}`), textDetail("压缩摘要", event.summaryPreview));
          marker.append(window.XrayHelp("context.compacted"));
          content.append(marker);
        }
      }
      const requests = turn.events.some((event) => event.type === "llm.request");
      if (!requests && !empty) { empty = node("p", "xray-empty", "尚无模型请求记录。" ); content.append(empty); }
      if (requests && empty) { empty.remove(); empty = undefined; }
    } };
  }

  function jsonTree(label, value) {
    if (value === null || typeof value !== "object") {
      const leaf = node("div", "xray-json-leaf");
      leaf.append(node("span", "xray-json-key", `${label}: `));
      const text = JSON.stringify(value);
      if (typeof value === "string" && value.length > 240) leaf.append(textDetail(`字符串 · ${number(value.length)} 字符`, text));
      else leaf.append(node("span", `xray-json-${typeof value}`, text));
      return leaf;
    }
    const tree = node("details", "xray-json-node");
    const keys = Object.keys(value);
    tree.append(node("summary", "", `${label} ${Array.isArray(value) ? `[${keys.length}]` : `{${keys.length}}`}`));
    let loaded = false;
    tree.addEventListener("toggle", () => {
      if (!tree.open || loaded) return;
      loaded = true;
      const children = node("div", "xray-json-children");
      let cursor = 0;
      const more = node("button", "xray-small-action", "继续展开后 100 项");
      more.type = "button";
      children.append(more);
      const append = () => {
        const end = Math.min(cursor + 100, keys.length);
        while (cursor < end) { const key = keys[cursor++]; children.insertBefore(jsonTree(key, value[key]), more); }
        if (cursor === keys.length) {
          const focused = document.activeElement === more;
          more.remove();
          if (focused) tree.querySelector("summary").focus();
        }
      };
      more.addEventListener("click", append);
      append(); tree.append(children);
    });
    return tree;
  }

  function raw(host, api) {
    host.append(node("p", "xray-inspect-intro", "API Key 等敏感信息已隐藏。这里显示模型适配器收到的请求快照（Pi context / DSH GenerateOptions），不等同于最终 HTTP 报文。"));
    const label = node("label", "xray-raw-label", "选择模型调用");
    const select = node("select", "xray-raw-select");
    label.append(select);
    const content = node("div", "xray-raw-content");
    const usage = node("div", "xray-raw-usage");
    host.append(label, usage, content);
    let currentTurn, selectedId, requestList = "", renderedRequest, renderedJSON, renderedKey;
    function draw() {
      const turn = currentTurn;
      const request = turn.events.find((event) => event.id === selectedId);
      const response = request && turn.events.find((event) => event.type === "llm.response" && event.round === request.round);
      usage.textContent = !request ? "" : response?.usage ? `输入 ${number(response.usage.input)} · 输出 ${number(response.usage.output)} · 缓存读取 ${response.usage.cacheRead === undefined ? "未提供" : number(response.usage.cacheRead)} tokens` : response ? "模型未提供本次调用的用量。" : turn.status === "running" ? "正在等待响应，用量尚未返回。" : "没有响应或用量记录。";
      const json = request === renderedRequest ? renderedJSON : request?.raw === undefined ? undefined : JSON.stringify(request.raw, null, 2);
      const key = `${selectedId}:${request?.rawTruncated}:${turn.fidelity.rawRequest}`;
      if (key === renderedKey && json === renderedJSON) return;
      renderedKey = key; renderedRequest = request; renderedJSON = json;
      content.replaceChildren();
      if (!turn.fidelity.rawRequest) {
        unavailable(content, turn.engine === "dsh" ? "完全体引擎没有提供这项数据" : "本回合未开启原始请求记录。开启后仅对新回合生效。");
        return;
      }
      if (!request) { unavailable(content, "尚无模型请求记录。" ); return; }
      if (request.raw === undefined) {
        unavailable(content, request.rawTruncated ? "本次请求因记录容量限制已省略。" : "本次请求正文未保留，可能已超过历史保留范围。" );
        return;
      }
      if (request.rawTruncated) content.append(node("p", "xray-context-alert", "这份记录已截断；显示和复制的均为已保存部分。"));
      content.append(copy("复制请求 JSON", () => json, api));
      const tree = jsonTree("请求", request.raw);
      content.append(tree); tree.open = true;
    }
    select.addEventListener("change", () => { selectedId = select.value; draw(); });
    return { refresh(turn) {
      currentTurn = turn;
      const requests = turn.events.filter((event) => event.type === "llm.request");
      const ids = requests.map((event) => event.id).join("|");
      if (ids !== requestList) {
        requestList = ids;
        select.replaceChildren(...requests.map((event) => { const option = node("option", "", `第 ${event.round} 次模型调用`); option.value = event.id; return option; }));
        if (!requests.some((event) => event.id === selectedId)) selectedId = requests[0]?.id;
        if (selectedId) select.value = selectedId;
      }
      select.disabled = !requests.length || !turn.fidelity.rawRequest;
      draw();
    } };
  }
  window.XrayInspect = { prompt, context, raw };
})();
