(() => {
  const $ = (s) => document.querySelector(s);
  const node = (tag, text, cls = "") => { const el = document.createElement(tag); el.className = cls; if (text !== undefined) el.textContent = text; return el; };
  const statuses = { running: "正在回答", done: "已完成", error: "失败", aborted: "已停止", interrupted: "应用中断" };
  window.createComparisons = (api, { onTurn, onShow, onClose, onState }) => {
    const panel = $("#compare-dialog"), history = $("#compare-history"), content = $("#compare-content"), prompt = $("#compare-prompt");
    let selected, data, state, pending = false, generation = 0, renderedGroup, renderedRound, summaryKey;
    let readingReference, readingGroup;
    const outputs = {}, scrollers = {}, drafts = new Map(), dirtySides = new Set();
    const streamUpdates = window.createStreamBatcher(renderStreamUpdates, {
      size: () => Math.max(...Object.values(data?.group.rounds.at(-1)?.runs || {}).map(run => run.text.length + (run.reasoning?.length || 0)), 0),
    });
    function renderStreamUpdates() {
      const round = data?.group.rounds.at(-1);
      for (const side of dirtySides) {
        const output = outputs[side], run = round?.runs[side];
        if (!output || !run || output.roundId !== round.id) continue;
        window.renderMarkdown(output.text, run.text);
        window.renderStreamText(output.reasoning, run.reasoning || "");
        output.thought.hidden = !run.reasoning;
        output.scroller.follow();
      }
      dirtySides.clear();
    }
    function cancelStreamUpdates() {
      streamUpdates.cancel(); dirtySides.clear();
      for (const scroller of Object.values(scrollers)) scroller.reset();
    }
    const status = (text) => { $("#compare-status").textContent = text; };
    const running = () => Object.values(data?.group.rounds.at(-1)?.runs ?? {}).some(run => run.status === "running");
    function togglePanel(name, value) {
      const id = name === "settings" ? "compare-settings-panel" : "compare-analysis";
      $(`#${id}`).hidden = !value; $(`#compare-${name === "settings" ? "settings" : "results"}-toggle`).setAttribute("aria-expanded", String(value));
    }
    function sizePrompt() { prompt.style.height = "auto"; prompt.style.height = `${Math.min(prompt.scrollHeight, 180)}px`; }
    function stashDraft() { drafts.set(selected || "new", prompt.value); }
    function show() {
      onShow?.(); panel.hidden = false; $(".workspace").dataset.mode = "compare";
      $("#comparisons").setAttribute("aria-current", "page");
    }
    function close() {
      stashDraft(); panel.hidden = true; delete $(".workspace").dataset.mode;
      $("#comparisons").removeAttribute("aria-current"); onClose?.();
    }
    function syncComposer() {
      $("#compare-send").disabled = pending || running() || Boolean(data?.group.workspace.expired);
      $("#compare-stop").hidden = !running(); $("#compare-stop").disabled = pending;
      prompt.disabled = Boolean(data?.group.workspace.expired);
      prompt.placeholder = data?.group.workspace.expired ? "副本已过期，请新建双路会话" : running() ? "可以先写好下一条，等两侧回答后继续…" : data?.group.rounds.length ? "继续追问，两个 Agent 会分别记住上下文…" : "同时问两个 Agent…";
      const path = data?.group.workspace.source || state?.workspace?.path;
      $("#compare-workspace-chip").textContent = path ? `${data ? "独立副本 · " : ""}${path.split(/[\\/]/).at(-1)}` : "选择工作空间";
      $("#compare-workspace-chip").title = path || "两侧将在所选文件夹的独立副本里工作";
      $("#compare-results-toggle").disabled = !data;
    }
    function readingNote() {
      const box = $("#compare-reading-note"), reading = data ? data.group.kind === "reading" : $("#compare-kind").value === "reading";
      box.hidden = !reading; box.replaceChildren();
      if (!reading) return;
      box.append(node("strong", "同一个模型 · 相同 Pi 能力 · 两种读取策略"));
      box.append(node("p", "从当前工作区创建两个独立副本，不恢复原回合开始时的文件或聊天历史。两侧临时开启工作区搜索，日常配置不变。"));
      box.append(node("p", `左侧：${data?.strategies?.left || "先直接读取相关文件，再完成任务。"}`), node("p", `右侧：${data?.strategies?.right || "先搜索，再读取相关片段，按需扩大范围。"}`));
      box.append(node("p", ((!data || selected === readingGroup) && readingReference) || "额外消耗两侧运行的实际 tokens，暂无可靠用量预估；这不是费用上限。"));
      box.append(node("p", "先比较回答、改动和检查证据，再比较用量。指令不保证模型遵循策略，请用 X 光核对。创建会话不调用模型，发送消息才开始。"));
    }
    function chooseKind() {
      $("#compare-right-choice").hidden = $("#compare-kind").value !== "model";
      readingNote(); if (!data) renderConversations();
    }
    function busy(value) {
      pending = value; panel.dataset.busy = String(value);
      $("#compare-create").disabled = value; $("#compare-new").disabled = value;
      syncComposer();
    }
    async function action(fn) { if (pending) return; busy(true); try { await fn(); } catch (error) { status(error.message); } finally { busy(false); } }
    async function list() {
      const groups = await api.compareList(); history.replaceChildren();
      for (const group of groups) {
        const button = node("button", group.title, "compare-history-item"); button.type = "button";
        button.setAttribute("aria-current", String(group.id === selected));
        button.onclick = () => void action(async () => { await select(group.id); $(".compare-history-menu").open = false; }); history.append(button);
      }
      if (!groups.length) history.append(node("p", "还没有双路会话"));
      return groups;
    }
    async function select(id) {
      const switched = selected !== id;
      if (switched) { cancelStreamUpdates(); stashDraft(); prompt.value = drafts.get(id) || ""; sizePrompt(); }
      selected = id; const version = ++generation; const result = await api.compareGet(id);
      if (version !== generation) return;
      const previous = data?.group.id === id && data.group.rounds.at(-1), current = result.group.rounds.at(-1);
      if (previous && previous.id === current?.id) for (const side of ["left", "right"]) {
        const oldRun = previous.runs[side], run = current.runs[side];
        if (run.status === "running" && oldRun.text.startsWith(run.text)) run.text = oldRun.text;
        if (run.status === "running" && oldRun.reasoning?.startsWith(run.reasoning || "")) run.reasoning = oldRun.reasoning;
      }
      data = result; render(); await list();
    }
    function sideConfig(side) {
      if (data) return data.group.sides[side];
      const kind = $("#compare-kind").value, key = side === "right" && kind === "model" ? "right" : "left";
      return { engine: side === "right" && kind === "harness" ? "dsh" : "pi", connection: state?.connections.find(c => c.id === $(`#compare-${key}-connection`).value) };
    }
    function renderConversations() {
      streamUpdates.flush();
      const roundId = data?.group.rounds.at(-1)?.id;
      const same = renderedGroup === selected && renderedRound === roundId, positions = {};
      for (const lane of content.querySelectorAll(".compare-messages")) positions[lane.dataset.side] = { top: lane.scrollTop, bottom: scrollers[lane.dataset.side]?.isFollowing() ?? lane.scrollHeight - lane.scrollTop - lane.clientHeight < 64 };
      cancelStreamUpdates();
      for (const [side, scroller] of Object.entries(scrollers)) { scroller.dispose(); delete scrollers[side]; }
      content.replaceChildren(); delete outputs.left; delete outputs.right; renderedGroup = selected; renderedRound = roundId;
      const kind = data?.group.kind || $("#compare-kind").value;
      for (const side of ["left", "right"]) {
        const config = sideConfig(side), lane = node("section", undefined, `compare-lane compare-lane-${side}`); lane.dataset.side = side;
        const heading = node("header", undefined, "compare-lane-header"), badge = node("span", side === "left" ? "A" : "B", "compare-agent-badge"), title = node("div");
        const name = kind === "reading" ? side === "left" ? "直接读取" : "先搜索再读" : config.engine === "dsh" ? "DSH · 完全体" : "Pi · 你的 Agent";
        title.append(node("h3", name), node("span", config.connection?.model || "在设置中选择模型", "compare-model-name"));
        const last = data?.group.rounds.at(-1)?.runs[side];
        heading.append(badge, title, node("span", last ? statuses[last.status] : "准备就绪", `compare-side-state ${last?.status || "idle"}`)); lane.append(heading);
        const messages = node("div", undefined, "compare-messages"); messages.dataset.side = side; messages.setAttribute("role", "log"); messages.setAttribute("aria-label", `${side === "left" ? "左侧" : "右侧"} Agent 对话`); messages.tabIndex = 0;
        if (!data?.group.rounds.length) {
          const empty = node("div", undefined, "compare-empty"); empty.append(node("span", side === "left" ? "A" : "B", "compare-empty-mark"), node("h3", "从同一个问题开始"), node("p", "在下方发送消息，之后可以一直追问。\n这一侧会保留自己的对话上下文。")); messages.append(empty);
        }
        for (const [index, round] of (data?.group.rounds || []).entries()) {
          const question = node("article", undefined, "compare-question"); question.dataset.roundId = round.id;
          question.append(node("small", `你 · 第 ${index + 1} 轮`), node("div", round.prompt)); messages.append(question);
          const run = round.runs[side], card = node("article", undefined, "compare-answer"); card.dataset.roundId = round.id;
          card.append(node("span", statuses[run.status], `compare-run-status ${run.status}`));
          const thought = node("details", undefined, "message-reasoning"); thought.hidden = !run.reasoning; thought.open = run.status === "running";
          const reasoning = node("div", run.reasoning || "", "reasoning-content");
          thought.append(node("summary", "思考过程 · 模型返回"), reasoning); card.append(thought);
          const text = node("div", undefined, `compare-answer-text${run.status === "running" ? " streaming" : ""}`);
          window.renderMarkdown(text, run.text || (run.status === "running" ? "正在思考…" : "没有回答内容")); card.append(text);
          if (round === data.group.rounds.at(-1)) outputs[side] = { text, thought, reasoning, messages, roundId: round.id };
          if (run.error) card.append(node("p", run.error, "compare-error"));
          if (run.turnIds[0]) {
            const actions = node("div", undefined, "compare-answer-actions");
            for (const [label, tab] of [["查看此回合 X 光", "timeline"], ["Token 账单", "ledger"]]) {
              if (tab === "ledger" && run.status === "running") continue;
              const button = node("button", label, "secondary-button"); button.type = "button";
              button.onclick = () => void action(async () => { const turn = await api.xrayTurn(run.turnIds[0]); if (!turn) throw new Error("该回合的 X 光历史已被清理。"); await onTurn(turn, tab); }); actions.append(button);
            }
            card.append(actions);
          }
          messages.append(card);
        }
        lane.append(messages); content.append(lane);
        const position = same && positions[side];
        const scroller = window.createChatScroller(messages);
        scrollers[side] = scroller;
        if (outputs[side]) outputs[side].scroller = scroller;
        if (!position || position.bottom) scroller.pin();
        else scroller.restore(position.top, false);
      }
    }
    function render() {
      const { group, metrics, differences } = data;
      renderConversations(); readingNote();
      $("#compare-title").textContent = group.rounds.length ? group.title : "双路聊天";
      $("#compare-subtitle").textContent = `${group.rounds.length} 轮对话 · 两侧独立上下文`;
      $("#compare-new-form").hidden = true; $("#compare-fixed-settings").hidden = false;
      $("#compare-delete").hidden = false; $("#compare-inspect").hidden = !group.rounds.length;
      status(group.workspace.expired ? "副本已过期，历史仍可查看。" : group.workspace.readOnly ? "自动执行（免工具审批） · 两侧强制只读" : "自动执行（免工具审批） · 两侧使用独立副本，采用改动需确认");
      const workspace = $("#compare-workspace-details"); workspace.replaceChildren(node("p", group.workspace.source, "compare-meta"));
      const exclusion = node("details"); exclusion.append(node("summary", `复制时排除 ${group.workspace.excluded.length} 项`), node("p", "不复制 Git 与依赖目录、应用安装包、符号链接及超过 50 MB 的文件。", "compare-meta"), node("pre", group.workspace.excluded.join("\n") || "无")); workspace.append(exclusion);
      const statistics = $("#compare-statistics"); statistics.replaceChildren();
      if (group.rounds.length) {
        statistics.append(node("h4", `第 ${group.rounds.length} 轮统计（含已记录子回合）`));
        const table = node("table", undefined, "compare-metrics"), head = node("tr"); for (const label of ["统计", "左侧", "右侧", "右 − 左"]) head.append(node("th", label)); table.append(head);
        for (const [key, label] of Object.entries({ modelCalls: "模型调用", toolCalls: "工具调用", subagents: "子任务", compactions: "压缩 / 裁剪", tokens: "Tokens", durationMs: "耗时（秒）", files: "文件变化" })) {
          const row = node("tr"), fmt = v => v === undefined ? "不可用" : key === "durationMs" ? (v / 1000).toFixed(2) : v.toLocaleString("zh-CN"), difference = differences[key];
          row.append(node("th", label), node("td", fmt(metrics.left[key])), node("td", fmt(metrics.right[key])), node("td", difference.delta === undefined ? "—" : `${fmt(difference.delta)}${difference.percent === undefined ? "" : ` (${difference.percent > 0 ? "+" : ""}${difference.percent.toFixed(1)}%)`}`)); table.append(row);
        }
        statistics.append(table);
        for (const side of ["left", "right"]) {
          const unique = metrics[side].tools.filter(name => !metrics[side === "left" ? "right" : "left"].tools.includes(name));
          statistics.append(node("p", `${side === "left" ? "左" : "右"}侧独有：${unique.join("、") || "无"}；全部工具：${metrics[side].tools.join("、") || "无已记录调用"} · 用量${{ exact: "精确", estimated: "估算", none: "不可用" }[metrics[side].usage]}`, "compare-meta"));
          const files = node("button", `查看${side === "left" ? "左" : "右"}侧文件变化`, "secondary-button"); files.onclick = () => showChanges(side); statistics.append(files);
        }
      } else statistics.append(node("p", "发送第一条消息后，在这里查看两侧的执行差异。"));
      const key = `${group.id}:${group.rounds.at(-1)?.id}:${running()}`;
      if (summaryKey !== key) {
        summaryKey = key; $("#compare-summary").replaceChildren(); $("#compare-changes").hidden = true; $("#compare-timeline").hidden = true;
        if (group.rounds.length && !running()) window.addDeepExplanation?.($("#compare-summary"), { kind: "comparison", compareGroupId: group.id }, "让 BuildMe 总结两边的差别");
        if (group.kind === "harness" && group.rounds.length && Object.values(group.rounds.at(-1).runs).every(run => run.status === "done")) {
          const share = node("button", "分享到社区", "secondary-button"); share.type = "button"; share.disabled = !window.communityAvailable(); share.onclick = () => void window.shareToCommunity("compare", group.id); $("#compare-summary").append(share);
        }
      }
      syncComposer();
    }
    function showChanges(side) {
      const preview = data.group.differences[side]; if (!preview) return;
      const detail = $("#compare-changes"); detail.replaceChildren(node("h3", `${side === "left" ? "左侧" : "右侧"}完整改动清单 · ${preview.changes.length} 项`));
      for (const change of preview.changes) {
        const entry = node("details"), label = node("summary", `${{ added: "新增", modified: "修改", deleted: "删除" }[change.kind]} · ${change.path}${change.binary ? " · 二进制" : ""}`);
        entry.append(label, node("pre", change.blocked || change.diff || "二进制内容已变化。")); detail.append(entry);
      }
      if (!data.group.workspace.expired && !data.group.workspace.readOnly && preview.changes.length) {
        const adopt = node("button", "采用这侧的全部改动", "primary-button"); adopt.type = "button";
        adopt.disabled = Object.values(data.group.rounds.at(-1)?.runs ?? {}).some((r) => r.status === "running") || preview.changes.some((c) => c.blocked);
        adopt.onclick = () => void action(async () => {
          const result = await api.compareAdopt(selected, side, preview.token);
          status(result.cancelled ? "已取消采用。" : result.conflicts.length ? `发现冲突，未写回任何文件：${result.conflicts.join("、")}` : `已采用 ${result.applied.length} 项改动。`);
        }); detail.append(adopt);
      }
      detail.hidden = false;
    }
    async function inspect() {
      const box = $("#compare-timeline"); box.replaceChildren(node("h3", "并列 X 光 · 按各自模型 round 展示"));
      const records = {};
      for (const side of ["left", "right"]) {
        records[side] = new Map();
        for (const turn of data.traces[side] ?? []) if (turn) {
          let round = 1;
          for (const event of turn.events) {
            if (event.round) round = event.round;
            if (!records[side].has(round)) records[side].set(round, []);
            records[side].get(round).push({ turn, event });
          }
        }
      }
      const rounds = [...new Set([...records.left.keys(), ...records.right.keys()])].sort((a, b) => a - b);
      for (const round of rounds) {
        box.append(node("h4", `Round ${round}`)); const columns = node("div", undefined, "compare-columns");
        for (const side of ["left", "right"]) {
          const column = node("div", undefined, "compare-timeline-side"); column.append(node("strong", side === "left" ? "左侧" : "右侧"));
          for (const { turn, event } of records[side].get(round) ?? []) {
            const signature = `${event.type}:${event.name ?? ""}`, other = side === "left" ? "right" : "left";
            const unique = !(records[other].get(round) ?? []).some(({ event: e }) => `${e.type}:${e.name ?? ""}` === signature);
            const entry = node("details", undefined, unique ? "compare-one-side" : ""); entry.append(node("summary", `${event.type}${event.name ? ` · ${event.name}` : ""}${turn.parentTurnId ? " · 子任务" : ""}${unique ? " · 仅此侧" : ""}`), node("pre", JSON.stringify(event, null, 2))); column.append(entry);
          }
          if (!records[side].has(round)) column.append(node("p", "此侧没有这一 round 的记录。"));
          columns.append(column);
        }
        box.append(columns);
      }
      box.hidden = false; await api.compareXrayOpened(selected);
    }
    async function fresh() {
      cancelStreamUpdates();
      stashDraft(); readingReference = undefined; readingGroup = undefined; selected = undefined; data = undefined; summaryKey = undefined; generation++;
      prompt.value = drafts.get("new") || ""; sizePrompt();
      $("#compare-title").textContent = "双路聊天"; $("#compare-subtitle").textContent = "同一个问题，两个 Agent，各自继续对话";
      $("#compare-summary").replaceChildren(); $("#compare-new-form").hidden = false; $("#compare-fixed-settings").hidden = true;
      $("#compare-delete").hidden = true; $("#compare-inspect").hidden = true; $("#compare-changes").hidden = true; $("#compare-timeline").hidden = true;
      togglePanel("results", false); togglePanel("settings", false);
      state = await api.state();
      for (const side of ["left", "right"]) {
        const select = $(`#compare-${side}-connection`); select.replaceChildren();
        for (const c of state.connections) { const option = node("option", `${c.name || c.provider} · ${c.model}`); option.value = c.id; select.append(option); }
        select.value = state.activeConnectionId;
      }
      status("自动执行（免工具审批） · 两个 Agent 同时回答，可以连续追问");
      chooseKind(); togglePanel("settings", $("#compare-kind").value !== "harness"); syncComposer(); await list(); prompt.focus(); return state;
    }
    async function open() {
      show(); state = await api.state(); const groups = await list();
      if (selected) await select(selected); else if (groups.length) await select(groups[0].id); else await fresh();
      prompt.focus();
    }
    async function chooseWorkspace() {
      const result = await api.chooseWorkspace(); if (!result) return false;
      state = await api.state(); onState?.(state); syncComposer(); return Boolean(state.workspace);
    }
    async function create() {
      if (!state.workspace && !await chooseWorkspace()) return false;
      const text = prompt.value;
      const group = await api.compareCreate({ kind: $("#compare-kind").value, leftConnectionId: $("#compare-left-connection").value, rightConnectionId: $("#compare-right-connection").value, piAll: $("#compare-pi-all").checked });
      readingGroup = group.kind === "reading" ? group.id : undefined; drafts.set(group.id, text); drafts.delete("new");
      await select(group.id); drafts.delete("new"); togglePanel("settings", false); prompt.focus(); return true;
    }
    $("#comparisons").onclick = () => void action(open);
    $("#compare-close").onclick = () => { close(); $("#prompt").focus(); };
    $("#compare-new").onclick = () => void action(fresh);
    $("#compare-kind").onchange = chooseKind;
    for (const side of ["left", "right"]) $(`#compare-${side}-connection`).onchange = () => renderConversations();
    $("#compare-settings-toggle").onclick = () => togglePanel("settings", $("#compare-settings-panel").hidden);
    $("#compare-results-toggle").onclick = () => togglePanel("results", $("#compare-analysis").hidden);
    $("#compare-analysis-close").onclick = () => togglePanel("results", false);
    $("#compare-workspace-chip").onclick = () => data ? togglePanel("results", true) : void action(chooseWorkspace);
    $("#compare-create").onclick = () => void action(create);
    $("#compare-send-form").onsubmit = (event) => {
      event.preventDefault(); if (running() || data?.group.workspace.expired) return;
      void action(async () => {
        const text = prompt.value.trim(); if (!text) return;
        if (!selected && !await create()) return;
        await api.compareSend(selected, text);
        if (prompt.value.trim() === text) prompt.value = "";
        stashDraft(); sizePrompt(); await select(selected); prompt.focus();
      });
    };
    prompt.addEventListener("input", () => { stashDraft(); sizePrompt(); });
    prompt.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!pending && !running()) $("#compare-send-form").requestSubmit(); }
    });
    $("#compare-stop").onclick = () => void action(async () => { await api.compareStop(selected); await select(selected); prompt.focus(); });
    $("#compare-delete").onclick = () => void action(async () => {
      if (!window.confirm("删除此双路会话及两个副本？真实工作区不受影响。")) return;
      const removed = selected; await api.compareDelete(removed); await fresh(); drafts.delete(removed);
    });
    $("#compare-inspect").onclick = () => void action(inspect);
    api.onCompare(event => {
      if (event.groupId !== selected || !data) return;
      if (event.type === "stream") {
        const run = data.group.rounds.at(-1)?.runs[event.side]; if (!run) return;
        if (event.kind === "reasoning") run.reasoning = (run.reasoning || "") + event.delta;
        else run.text += event.delta;
        dirtySides.add(event.side); streamUpdates.schedule();
      } else { streamUpdates.flush(); void select(selected).catch(error => status(error.message)); }
    });
    return {
      close, isOpen: () => !panel.hidden, isBusy: () => pending || running(), newConversation: () => action(fresh),
      open: example => action(async () => {
        if (example) { show(); await fresh(); prompt.value = example; stashDraft(); sizePrompt(); prompt.focus(); }
        else await open();
      }),
      openReading: (turn, usage) => action(async () => {
        show(); await fresh(); $("#compare-kind").value = "reading"; $("#compare-pi-all").checked = false;
        const same = state.connections.find(connection => connection.provider === turn.model.provider && connection.model === turn.model.id);
        if (same) $("#compare-left-connection").value = same.id;
        prompt.value = turn.userPrompt; stashDraft(); sizePrompt();
        if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
          const baseline = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
          readingReference = `原回合及已记录子任务合计 ${baseline.toLocaleString("zh-CN")} tokens（含已报告缓存）；两侧重跑可先参考 ${(baseline * 2).toLocaleString("zh-CN")} tokens 量级。实际用量可能变化，这不是费用上限。`;
        }
        chooseKind(); togglePanel("settings", true); prompt.focus();
      }),
    };
  };
})();
