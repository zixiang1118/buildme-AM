(() => {
  const STATUS = { running: "进行中", done: "已完成", error: "出错了", aborted: "已取消" };
  const APPROVAL = { "auto-allow": "自动放行", "user-allow": "你允许了", "user-deny": "你拒绝了", "policy-deny": "策略拒绝", cancelled: "已取消", timeout: "审批超时" };
  const PERMISSION = { ask: "每次询问", "workspace-write": "工作区内自动执行", bypass: "完全访问" };
  const number = (value) => value.toLocaleString("zh-CN");
  const seconds = (value) => `${(value / 1000).toFixed(1)} 秒`;
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function detail(label, text, className = "") {
    const node = element("details", `xray-detail ${className}`);
    node.append(element("summary", "", label), element("pre", "", text));
    return node;
  }
  function tokens(turn) {
    if (turn.fidelity.usage === "none") return "tokens 未提供";
    if (turn.usage.inputTokens === undefined || turn.usage.outputTokens === undefined) return "tokens 未提供";
    const total = number(turn.usage.inputTokens + turn.usage.outputTokens + (turn.usage.cacheReadTokens ?? 0) + (turn.usage.cacheWriteTokens ?? 0));
    if (turn.fidelity.usage === "partial") return `已记录 ${total} tokens（${turn.usage.reportedCalls}/${turn.usage.reportedCalls + turn.usage.missingCalls} 次，部分用量）`;
    return `${turn.fidelity.usage === "estimated" ? "约 " : ""}${total} tokens`;
  }
  function stats(turn) {
    return `${turn.usage.modelCalls} 次模型调用 · ${turn.usage.toolCalls} 个工具 · ${tokens(turn)} · ${seconds(turn.usage.durationMs)}`;
  }

  window.createXray = (api, { onExperiment } = {}) => {
    const $ = (selector) => document.querySelector(selector);
    const panel = $("#xray-panel"), timeline = $("#xray-timeline"), overview = $("#xray-overview");
    const toggle = $("#xray-toggle"), select = $("#xray-turn"), followButton = $("#xray-follow");
    const narrow = window.matchMedia("(max-width: 899px)");
    const summaries = new Map(), turns = new Map();
    let sessionId, edition = "standard", selectedId, pendingAnswer, entries = [], generation = 0;
    let follow = true, open = false, frame, view, viewId, loadError = "", returnFocus;
    let advanced = localStorage.getItem("buildme.xray.mode") === "advanced";
    let width = Number(localStorage.getItem("buildme.xray.width") || 420);
    let selectionVersion = 0;
    let activeTab = "timeline", inspectViews = {};
    let focusTarget;
    let showMoments = localStorage.getItem("buildme.xray.moments") !== "false";
    const tabButtons = [...$("#xray-tabs").querySelectorAll("[data-xray-tab]")];
    const tabNames = { timeline: "执行时间线", prompt: "系统提示词", context: "上下文用量", ledger: "Token 用量账单", raw: "原始请求" };

    async function focusEvents(turnId, eventIds) {
      follow = false;
      if (!turns.has(turnId)) {
        const scope = generation;
        const turn = await api.xrayTurn(turnId);
        if (scope !== generation) return;
        if (!turn) { loadError = "这条记录已被清理。"; setOpen(true); schedule(); return; }
        turns.set(turn.id, turn);
      }
      focusTarget = { turnId, eventIds };
      await choose(turnId); updateSelect(); setTab("timeline"); setOpen(true);
    }

    function setTab(name) {
      if (name === "prompt" || name === "raw") window.recordLearningEvent?.("xray-tab", { tab: name, turnId: selectedId });
      activeTab = name;
      for (const button of tabButtons) {
        const selected = button.dataset.xrayTab === name;
        button.setAttribute("aria-selected", String(selected));
        button.tabIndex = selected ? 0 : -1;
        $(`#${button.getAttribute("aria-controls")}`).hidden = !selected;
      }
      $("#xray-view-title").textContent = tabNames[name];
      schedule();
    }

    function syncOverlay() {
      const modal = open && narrow.matches;
      panel.setAttribute("role", modal ? "dialog" : "complementary");
      if (modal) panel.setAttribute("aria-modal", "true"); else panel.removeAttribute("aria-modal");
      $(".workspace").inert = modal;
      $(".sidebar").inert = modal;
      $("#xray-backdrop").hidden = !modal;
    }
    function setOpen(value, focus = true) {
      if (value && !open) {
        returnFocus = document.activeElement;
        if (focus) window.recordLearningEvent?.("xray-opened", { turnId: selectedId });
      }
      open = value;
      panel.hidden = !open;
      document.body.classList.toggle("xray-open", open);
      toggle.setAttribute("aria-expanded", String(open));
      localStorage.setItem("buildme.xray.open", String(open));
      syncOverlay();
      if (open) {
        schedule();
        if (focus) $("#xray-close").focus();
      } else if (focus) (returnFocus?.isConnected ? returnFocus : toggle).focus();
    }
    function setWidth(value) {
      width = Math.max(320, Math.min(720, value));
      document.body.style.setProperty("--xray-width", `${width}px`);
      $("#xray-resize").setAttribute("aria-valuenow", String(width));
      localStorage.setItem("buildme.xray.width", String(width));
    }
    function setMode(value) {
      advanced = value;
      panel.dataset.mode = advanced ? "advanced" : "beginner";
      $("#xray-beginner").setAttribute("aria-pressed", String(!advanced));
      $("#xray-advanced").setAttribute("aria-pressed", String(advanced));
      localStorage.setItem("buildme.xray.mode", advanced ? "advanced" : "beginner");
      $("#xray-tab-raw").hidden = !advanced;
      if (!advanced && activeTab === "raw") setTab("timeline");
    }
    function ordered() { return [...summaries.values()].sort((a, b) => a.turnIndex - b.turnIndex); }
    function updateSelect() {
      const items = ordered();
      const options = items.map((turn) => {
        const option = element("option", "", `第 ${turn.turnIndex} 回合 · ${STATUS[turn.status]}`);
        option.value = turn.id;
        return option;
      });
      const child = turns.get(selectedId);
      if (child?.parentTurnId && !summaries.has(child.id)) { const option = element("option", "", `子 Agent · ${child.model.id}`); option.value = child.id; options.push(option); }
      if (!options.length) options.push(element("option", "", "暂无回合记录"));
      select.replaceChildren(...options);
      select.disabled = !items.length;
      if (follow && selectedId !== items.at(-1)?.id) {
        selectedId = items.at(-1)?.id;
        selectionVersion += 1;
        loadError = "";
      }
      if (selectedId) select.value = selectedId;
      followButton.setAttribute("aria-pressed", String(follow));
    }
    async function choose(id) {
      selectedId = id;
      const version = ++selectionVersion, scope = generation;
      loadError = "";
      schedule();
      if (!id || turns.has(id)) return;
      try {
        const turn = await api.xrayTurn(id);
        if (scope !== generation || version !== selectionVersion) return;
        if (!turn) loadError = "这条记录已不可用，可能已被存储清理。";
        else if (!turns.has(id)) turns.set(id, structuredClone(turn));
      } catch (error) {
        if (scope === generation && version === selectionVersion) loadError = `读取记录失败：${error.message}`;
      }
      schedule();
    }
    function bind(entry, turn) {
      if (!entry.bar) {
        entry.bar = element("button", "xray-stats");
        entry.bar.type = "button";
        entry.node.after(entry.bar);
        entry.bar.addEventListener("click", () => {
          follow = false;
          void choose(entry.turnId);
          updateSelect();
          setOpen(true);
          $(".xray-hint")?.remove();
        });
        if (!localStorage.getItem("buildme.xray.hint")) {
          const hint = element("p", "xray-hint", "点这里，看看 agent 刚才在背后做了什么");
          entry.bar.after(hint);
          localStorage.setItem("buildme.xray.hint", "seen");
        }
      }
      entry.turnId = turn.id;
      entry.bar.dataset.turnId = turn.id;
      entry.bar.textContent = `◎ ${stats(turn)}${turn.status === "done" ? "" : ` · ${STATUS[turn.status]}`}  ›`;
      entry.bar.setAttribute("aria-label", `查看第 ${turn.turnIndex} 回合 X 光：${stats(turn)}`);
      if (!entry.insights) {
        entry.insights = element("div", "xray-answer-insights");
        const ledger = element("button", "xray-ledger-link", "Token 去哪儿了？"); ledger.type = "button";
        ledger.onclick = () => { follow = false; void choose(entry.turnId); updateSelect(); setTab("ledger"); setOpen(true); };
        entry.insights.append(ledger); entry.bar.after(entry.insights);
      }
      entry.insights.hidden = turn.status === "running";
      if (entry.moment && (!showMoments || localStorage.getItem(`buildme.xray.dismissed.${turn.id}`) === "true")) { entry.moment.remove(); entry.moment = undefined; }
      if (!entry.moment && showMoments && turn.moment && localStorage.getItem(`buildme.xray.dismissed.${turn.id}`) !== "true") {
        const card = element("section", "xray-moment");
        card.append(element("span", "xray-moment-label", "本轮值得看的一幕"));
        const dismiss = element("button", "xray-moment-dismiss", "收起"); dismiss.type = "button"; dismiss.setAttribute("aria-label", "收起本回合的发现卡");
        dismiss.onclick = () => { localStorage.setItem(`buildme.xray.dismissed.${turn.id}`, "true"); card.remove(); entry.moment = undefined; };
        const inspect = element("button", "xray-moment-open", turn.moment.title); inspect.type = "button";
        inspect.onclick = () => { void focusEvents(turn.id, turn.moment.eventIds).catch((error) => { inspect.textContent = `读取失败：${error.message}`; }); };
        card.append(dismiss, inspect, element("p", "", turn.moment.description));
        entry.insights.append(card); entry.moment = card;
      }
    }
    function updateBars() {
      const byIndex = new Map(ordered().map((turn) => [turn.turnIndex, turn]));
      for (const entry of entries) {
        const turn = entry.turnId ? summaries.get(entry.turnId) : byIndex.get(entry.turnIndex);
        if (turn) bind(entry, turn);
      }
    }
    function schedule() {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        updateBars();
        if (open) render();
      });
    }

    function makeTimeline(host, initialTurn) {
      const rows = new Map(), groups = new Map(), children = new Map();
      const input = element("div", "xray-input");
      input.append(element("span", "xray-eyebrow", "你的输入"), element("p", "", initialTurn.userPrompt));
      const prompt = element("div", "xray-prompt-note", initialTurn.fidelity.promptSegments
        ? `◈ 拼装了 ${initialTurn.promptSegments.length} 段系统提示词`
        : "当前引擎未提供提示词分段");
      prompt.append(window.XrayHelp("prompt.assembly"));
      host.append(input, prompt);
      function row(event, title, explanation, kind = "normal") {
        const node = element("section", `xray-event xray-${kind}`);
        node.dataset.eventId = event.id;
        const heading = element("div", "xray-event-heading");
        const name = element("strong", "", title);
        const time = element("time", "", `+${seconds(new Date(event.at) - new Date(initialTurn.startedAt))}`);
        heading.append(name, time);
        const note = element("p", "xray-explanation", explanation);
        const state = element("p", "xray-event-state");
        node.append(heading, note, state, window.XrayHelp(event.type, event.capabilityId));
        const record = { node, name, state };
        rows.set(event.id, record);
        let parent = host;
        if (event.type === "tool.call" && event.parallelGroup) {
          if (!groups.has(event.parallelGroup)) {
            const group = element("section", "xray-parallel");
            group.append(element("h3", "", "⇉ 并行执行"), window.XrayHelp("parallel"));
            host.append(group);
            groups.set(event.parallelGroup, group);
          }
          parent = groups.get(event.parallelGroup);
        }
        parent.append(node);
        return record;
      }
      function refresh(turn) {
        host.dataset.turnId = turn.id;
        const responses = new Map(), approvals = new Map(), results = new Map(), childEnds = new Map();
        for (const event of turn.events) {
          if (event.type === "llm.response") responses.set(event.round, event);
          if (event.type === "tool.approval") approvals.set(event.toolCallId, event);
          if (event.type === "tool.result") results.set(event.toolCallId, event);
          if (event.type === "subagent.end") childEnds.set(event.childTurnId, event);
        }
        for (const event of turn.events) {
          if (["llm.response", "tool.approval", "tool.result", "subagent.end"].includes(event.type)) continue;
          let record = rows.get(event.id);
          if (event.type === "tool.call") {
            if (!record) {
              record = row(event, `⌘ ${event.name}`, "Agent 选择了一个工具来完成这一步。", "tool");
              record.node.append(detail("调用参数 · JSON", JSON.stringify(event.args, null, 2)));
            }
            const approval = approvals.get(event.toolCallId), result = results.get(event.toolCallId);
            if (approval && !record.approvalHelp) {
              record.approvalHelp = window.XrayHelp("tool.approval", undefined, "审批是什么");
              record.node.append(record.approvalHelp);
            }
            record.state.textContent = `${approval ? `${APPROVAL[approval.decision]} · ${PERMISSION[approval.permissionMode]}` : turn.fidelity.approvals ? "尚无审批记录" : "引擎未提供审批记录"} · ${result ? `${result.isError ? "执行失败" : "已返回"} · ${seconds(result.durationMs)}` : turn.status === "running" ? "等待结果" : "没有结果记录"}`;
            record.node.classList.toggle("xray-error", Boolean(result?.isError));
            if (approval?.reason && !record.reason) {
              record.reason = detail("审批原因", approval.reason);
              record.node.append(record.reason);
            }
            if (result && !record.result) {
              record.result = element("div", "xray-result");
              record.result.append(element("pre", "xray-preview", result.resultPreview));
              if (result.result !== undefined) record.result.append(detail(result.truncated ? "查看已保存的结果（原结果已截断）" : "查看完整结果", result.result));
              else if (result.truncated) record.result.append(element("p", "xray-muted", "这里只保存了截断预览。"));
              record.result.append(element("small", "xray-muted", `原结果 ${number(result.resultBytes)} 字节`), window.XrayHelp("tool.result", undefined, "结果是什么"));
              record.node.append(record.result);
            }
          } else if (event.type === "llm.request") {
            if (!record) record = row(event, `◎ 第 ${event.round} 次模型调用`, `发送 ${event.messageCount} 条消息和 ${event.toolNames.length} 个可用工具，等待模型决定下一步。`, "model");
            const response = responses.get(event.round);
            record.state.textContent = response ? `${seconds(response.durationMs)} · ${response.usage ? `输入 ${number(response.usage.input)} / 输出 ${number(response.usage.output)} tokens` : "未提供 token 用量"}` : turn.status === "running" ? "正在等待模型" : "没有响应记录";
            if (response && !record.response) {
              record.response = detail("模型回复预览", response.textPreview || (response.toolCalls.length ? "模型选择了工具调用。" : "没有文本内容。"));
              record.node.append(record.response);
            }
            if (response?.reasoning && !record.reasoning) {
              record.reasoning = detail(response.reasoningTruncated ? "思考过程 · 模型返回（已截断）" : "思考过程 · 模型返回", response.reasoning);
              record.node.append(record.reasoning);
            }
          } else if (event.type === "subagent.start") {
            if (!record) {
              record = row(event, "◇ 子 Agent", "把一个独立任务交给另一个 Agent；展开查看它自己的执行过程。", "child");
              record.node.append(element("p", "xray-task", event.task));
              const tree = element("details", "xray-child-tree"), body = element("div", "xray-child-body");
              tree.append(element("summary", "", "展开子任务时间线"), body);
              record.node.append(tree);
              const child = { tree, body, view: undefined, loading: false };
              children.set(event.childTurnId, child);
              tree.addEventListener("toggle", () => { if (tree.open) void loadChild(event.childTurnId, child); });
            }
            const end = childEnds.get(event.childTurnId);
            record.state.textContent = end ? `${end.isError ? "执行失败" : "已完成"} · ${seconds(end.durationMs)}` : turn.status === "running" ? "正在执行" : "没有结束记录";
            record.node.classList.toggle("xray-error", Boolean(end?.isError));
          } else if (!record) {
            if (event.type === "context.compacted") {
              record = row(event, "⚠ 压缩上下文", `将前 ${event.coveredMessages} 条消息浓缩成摘要，为后续对话腾出空间。`, "compact");
              record.state.textContent = `${number(event.tokensBefore)} → ${event.tokensAfter === undefined ? "压缩后用量未提供" : `${number(event.tokensAfter)} tokens`}`;
              record.node.append(detail("查看压缩摘要", event.summaryPreview));
            } else if (event.type === "context.clipped") {
              record = row(event, "✂ 裁剪工具结果", "缩短发送给模型的工具结果，原始会话记录仍保留。", "compact");
              record.state.textContent = `${number(event.charsBefore)} → ${number(event.charsAfter)} 字符`;
            } else if (event.type === "context.overflow") {
              record = row(event, "⚠ 上下文超限", "当前内容超过这次模型请求可用的上下文容量。", "error");
              record.state.textContent = `估算 ${number(event.estTokens)} / 上限 ${number(event.limit)} tokens`;
            } else if (event.type === "skill.catalog") {
              record = row(event, `▤ 发现 ${event.skills.length} 个 Skill`, "读取可用的操作指南目录，尚不代表已加载它们。", "skill");
              record.node.append(detail("查看 Skill 目录", event.skills.map((skill) => `${skill.name} — ${skill.description}`).join("\n")));
            } else if (event.type === "skill.load") {
              record = row(event, `▤ 加载 Skill · ${event.name}`, "读取这份操作指南，供 Agent 执行任务时使用。", "skill");
              record.state.textContent = `${number(event.chars)} 字符 · ${event.builtin ? "内置" : "工作区 / 用户目录"}`;
              if (event.path) record.node.append(detail("来源路径", event.path));
            } else if (event.type === "workflow.step") {
              record = row(event, `▸ 工作流第 ${event.stepIndex} 步 · ${{ start: "开始", end: "完成", error: "失败" }[event.status]}`, event.title, event.status === "error" ? "error" : "workflow");
            } else if (event.type === "error") {
              record = row(event, "! 执行出错", "这一步发生了错误，下面保留实际错误信息。", "error");
              record.state.textContent = event.message;
            }
          }
        }
        for (const [id, child] of children) {
          if (child.tree.open && turns.has(id) && child.view) {
            child.view.refresh(turns.get(id));
            child.stats.textContent = stats(turns.get(id));
          }
        }
      }
      async function loadChild(id, child) {
        if (child.loading) return;
        const scope = generation;
        child.loading = true;
        try {
          if (!turns.has(id)) {
            child.body.textContent = "正在读取子任务…";
            const turn = await api.xrayTurn(id);
            if (scope !== generation) return;
            if (!turn) { child.body.textContent = "子任务记录已不可用。"; return; }
            if (!turns.has(id)) turns.set(id, structuredClone(turn));
          }
          const turn = turns.get(id);
          if (!child.view) {
            child.body.replaceChildren();
            child.stats = element("p", "xray-child-stats", stats(turn));
            child.body.append(child.stats);
            child.view = makeTimeline(child.body, turn);
          }
          child.view.refresh(turn);
        } catch (error) { child.body.textContent = `读取子任务失败：${error.message}。重新展开可重试。`; }
        finally { child.loading = false; }
      }
      return { refresh };
    }

    function render() {
      const turn = turns.get(selectedId);
      if (turn) panel.dataset.turnId = turn.id; else delete panel.dataset.turnId;
      if (viewId !== selectedId) {
        timeline.replaceChildren();
        timeline.scrollTop = 0;
        view = undefined;
        inspectViews = {};
        for (const name of ["prompt", "context", "ledger", "raw"]) { $(`#xray-${name}`).replaceChildren(); $(`#xray-${name}`).scrollTop = 0; }
        viewId = selectedId;
      }
      overview.replaceChildren();
      if (!turn || loadError) {
        const message = loadError || (selectedId ? "正在读取执行记录…" : edition === "full" ? "完全体引擎尚未接入 X 光记录" : sessionId ? "这段会话暂无 X 光记录" : "从一次对话开始，看见 Agent 如何工作");
        $(`#xray-${activeTab}`).replaceChildren(element("div", "xray-empty", message));
        $("#xray-event-count").textContent = "";
        return;
      }
      const badge = element("span", `xray-status xray-status-${turn.status}`, STATUS[turn.status]);
      const model = element("span", "xray-model-name", `${turn.model.provider} / ${turn.model.id}`);
      const values = element("div", "xray-metrics");
      for (const [value, label] of [[turn.usage.modelCalls, "模型调用"], [turn.usage.toolCalls, "工具调用"], [tokens(turn), "用量（含已报告缓存）"], [seconds(turn.usage.durationMs), "回合耗时"]]) {
        const metric = element("div", "");
        metric.append(element("strong", "", String(value)), element("span", "", label));
        values.append(metric);
      }
      overview.append(badge, model, values);
      $("#xray-event-count").textContent = `${turn.events.length} 个事件`;
      if (activeTab !== "timeline") {
        const host = $(`#xray-${activeTab}`);
        if (!inspectViews[activeTab]) {
          host.replaceChildren();
          if (activeTab === "prompt") {
            const previous = ordered().find((item) => item.turnIndex === turn.turnIndex - 1);
            window.XrayInspect.prompt(host, turn, { api, previous: async () => previous ? turns.get(previous.id) || await api.xrayTurn(previous.id) : undefined });
            inspectViews.prompt = true;
          } else if (activeTab === "ledger") inspectViews.ledger = window.XrayLedger(host, api, {
            onEvent: (id, eventIds) => { void focusEvents(id, eventIds).catch((error) => { loadError = error.message; schedule(); }); },
            onExperiment: (source, usage) => { setOpen(false); onExperiment(source, usage); },
          });
          else inspectViews[activeTab] = window.XrayInspect[activeTab](host, api);
        }
        if (activeTab !== "prompt") inspectViews[activeTab].refresh(turn);
        return;
      }
      if (!view) { timeline.replaceChildren(); view = makeTimeline(timeline, turn); }
      const atBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 60;
      view.refresh(turn);
      if (atBottom && turn.status === "running") timeline.scrollTop = timeline.scrollHeight;
      if (focusTarget?.turnId === turn.id) {
        for (const row of timeline.querySelectorAll(".xray-event")) row.classList.toggle("xray-event-focused", focusTarget.eventIds.includes(row.dataset.eventId));
        const target = [...timeline.querySelectorAll(".xray-event")].find((row) => row.dataset.eventId === focusTarget.eventIds[0]);
        if (target) { target.tabIndex = -1; target.focus({ preventScroll: true }); target.scrollIntoView({ block: "center" }); }
        focusTarget = undefined;
      }
    }

    api.onXray((notification) => {
      if (notification.type === "event") {
        const turn = turns.get(notification.turnId);
        if (!turn) return;
        turn.events.push(notification.event);
        const event = notification.event;
        if (event.type === "llm.request") turn.usage.modelCalls += 1;
        if (event.type === "tool.call") turn.usage.toolCalls += 1;
        if (event.type === "llm.response" && event.usage) {
          turn.usage.inputTokens = (turn.usage.inputTokens ?? 0) + event.usage.input;
          turn.usage.outputTokens = (turn.usage.outputTokens ?? 0) + event.usage.output;
          if (event.usage.cacheRead !== undefined) turn.usage.cacheReadTokens = (turn.usage.cacheReadTokens ?? 0) + event.usage.cacheRead;
          if (event.usage.cacheWrite !== undefined) turn.usage.cacheWriteTokens = (turn.usage.cacheWriteTokens ?? 0) + event.usage.cacheWrite;
        }
        if (event.type === "llm.request" || event.type === "llm.response") {
          const requests = new Set(turn.events.filter(e => e.type === "llm.request").map(e => e.round));
          const reported = new Set(turn.events.filter(e => e.type === "llm.response" && e.usage && requests.has(e.round)).map(e => e.round));
          turn.usage.reportedCalls = reported.size; turn.usage.missingCalls = requests.size - reported.size;
          turn.fidelity.usage = reported.size === 0 ? "none" : reported.size < requests.size ? "partial" : "exact";
        }
        turn.usage.durationMs = Math.max(0, new Date(event.at) - new Date(turn.startedAt));
      } else {
        const turn = structuredClone(notification.turn);
        if (turn.parentTurnId) {
          if (!turns.has(turn.parentTurnId)) return;
          turns.set(turn.id, turn);
        } else {
          if (turn.engine !== (edition === "full" ? "dsh" : "pi")) return;
          if (pendingAnswer && !sessionId) sessionId = turn.sessionId;
          if (turn.sessionId !== sessionId) return;
          summaries.set(turn.id, turn);
          turns.set(turn.id, turn);
          if (pendingAnswer && notification.type === "turn-start") {
            pendingAnswer.turnId = turn.id;
            entries.push(pendingAnswer);
            pendingAnswer = undefined;
          }
          updateSelect();
        }
      }
      schedule();
    });

    async function setSession(id, nextEdition) {
      sessionId = id;
      edition = nextEdition;
      const scope = ++generation;
      selectionVersion += 1;
      summaries.clear(); turns.clear(); entries = []; pendingAnswer = undefined;
      selectedId = undefined; viewId = undefined; view = undefined; inspectViews = {}; follow = true; loadError = ""; focusTarget = undefined;
      timeline.replaceChildren();
      for (const name of ["prompt", "context", "ledger", "raw"]) $(`#xray-${name}`).replaceChildren();
      updateSelect(); schedule();
      if (!id) return;
      try {
        const items = await api.xrayTurns(id, edition === "full" ? "dsh" : "pi");
        if (scope !== generation) return;
        for (const turn of items) if (!turn.parentTurnId && !summaries.has(turn.id)) summaries.set(turn.id, turn);
        updateSelect();
        await choose(selectedId);
      } catch (error) {
        if (scope === generation) { loadError = `读取回合失败：${error.message}`; schedule(); }
      }
    }
    toggle.addEventListener("click", () => setOpen(!open));
    $("#show-xray-moments").checked = showMoments;
    $("#show-xray-moments").addEventListener("change", (event) => { showMoments = event.target.checked; localStorage.setItem("buildme.xray.moments", String(showMoments)); schedule(); });
    $("#xray-close").addEventListener("click", () => setOpen(false));
    $("#xray-backdrop").addEventListener("click", () => setOpen(false));
    $("#xray-beginner").addEventListener("click", () => setMode(false));
    $("#xray-advanced").addEventListener("click", () => setMode(true));
    for (const button of tabButtons) button.addEventListener("click", () => setTab(button.dataset.xrayTab));
    $("#xray-tabs").addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const available = tabButtons.filter((button) => !button.hidden);
      const index = available.findIndex((button) => button.dataset.xrayTab === activeTab);
      const next = event.key === "Home" ? 0 : event.key === "End" ? available.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + available.length) % available.length;
      setTab(available[next].dataset.xrayTab);
      available[next].focus();
    });
    select.addEventListener("change", () => { follow = false; void choose(select.value); updateSelect(); });
    followButton.addEventListener("click", () => { follow = true; updateSelect(); void choose(selectedId); });
    narrow.addEventListener("change", () => { syncOverlay(); if (open && narrow.matches) $("#xray-close").focus(); });
    const resize = $("#xray-resize");
    resize.addEventListener("pointerdown", (event) => { resize.setPointerCapture(event.pointerId); event.preventDefault(); });
    resize.addEventListener("pointermove", (event) => { if (resize.hasPointerCapture(event.pointerId)) setWidth(window.innerWidth - event.clientX); });
    resize.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      setWidth(event.key === "Home" ? 320 : event.key === "End" ? 720 : width + (event.key === "ArrowLeft" ? 20 : -20));
    });
    document.addEventListener("keydown", (event) => {
      if (document.querySelector("dialog[open]")) return;
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "x") { event.preventDefault(); setOpen(!open); }
      if (event.key === "Escape" && open) { event.preventDefault(); setOpen(false); }
      if (event.key === "Tab" && open && narrow.matches) {
        const nodes = [...panel.querySelectorAll("button, select, summary, [tabindex='0']")].filter((node) => !node.disabled && node.tabIndex !== -1 && node.getClientRects().length);
        const first = nodes[0], last = nodes.at(-1);
        if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    });
    setWidth(width); setMode(advanced); updateSelect();
    setOpen(localStorage.getItem("buildme.xray.open") === "true", false);
    return {
      setSession,
      async openTurn(turn, tab = "timeline") {
        await setSession(turn.sessionId, turn.engine === "dsh" ? "full" : "standard");
        summaries.set(turn.id, turn); turns.set(turn.id, turn); follow = false;
        await choose(turn.id); updateSelect(); setTab(tab); setOpen(true);
      },
      bindHistory(items) {
        entries = [...new Map(items.filter((item) => item.role === "assistant").map((item) => [item.turnId ?? item.turnIndex, item])).values()];
        schedule();
      },
      beginRun(node) { pendingAnswer = { node }; },
      endRun() { pendingAnswer = undefined; },
    };
  };
})();
