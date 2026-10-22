(() => {
  "use strict";

  const NAV = [
    ["overview", "课题总览", "01", "从已有基础，推进下一次实验"],
    ["compounds", "分子库", "02", "保存结构与每次改造的理由"],
    ["plans", "合成方案", "03", "路线、假设与条件优化"],
    ["runs", "实验记录", "04", "反应进度与独立产物批次"],
    ["assays", "表征与活性", "05", "让结构、纯度和活性对应同一批次"],
    ["paper", "论文与证据", "06", "从完成的实验逐步积累论文"],
  ];
  const PROVENANCE = { measured: "本人实测", literature: "已核验文献", predicted: "计算预测", proposed: "待验证建议", imported: "导入资料", computed: "数据计算", example: "示例数据" };
  const STATUSES = { planned: "待开展", running: "进行中", completed: "已完成", failed: "失败", aborted: "中止", draft: "草稿", reviewed: "已复核", needs_review: "需要复核", stale: "依据已更新" };
  const KINDS = { methods: "实验方法", results: "实验结果", discussion: "讨论" };
  const EXAMPLE_CARDS = [
    { title: "分子对比与路线", icon: "molecule", description: "比较公开药物结构与真实计算性质，查看候选合成方案、研究假设和待核实事项。", features: "公开结构 · 真实性质计算 · 合成方案" },
    { title: "反应条件优化", icon: "flask", description: "查看条件筛选中的成功、低收率与失败记录，理解独立反应重复与产物批次。", features: "条件筛选 · 实际记录格式 · 批次关联" },
    { title: "活性与论文证据", icon: "chart", description: "从模拟原始读数到样本统计，查看检测体系、结论范围和可追溯的论文草稿。", features: "检测数据 · 描述统计 · 论文证据" },
  ];
  const EXAMPLE_NOTICE = "教学示例：实验数据为模拟；公开结构和真实计算分别标注来源";
  const ICONS = {
    flask: '<path d="M9 3h6m-5 0v7l-5 8a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-8V3M8 15h8"/>',
    molecule: '<circle cx="6" cy="7" r="2.5"/><circle cx="18" cy="7" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8.5 7h7M7.3 9.2l3.5 6.5m6-6.5-3.5 6.5"/>',
    route: '<circle cx="5" cy="5" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="5" cy="19" r="2"/><path d="M7 5h3a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7m6-7h4"/>',
    chart: '<path d="M4 3v17h17M8 16V9m5 7V6m5 10v-5"/>',
    book: '<path d="M12 5C9 3 6 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15"/>',
    home: '<path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
  };
  const node = (tag, className, value) => {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (value !== undefined && value !== null) item.textContent = String(value);
    return item;
  };
  const icon = name => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(key, value);
    svg.innerHTML = ICONS[name] || ICONS.flask;
    return svg;
  };
  const lines = text => String(text || "").split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const asText = value => Array.isArray(value) ? value.map(item => typeof item === "string" ? item : JSON.stringify(item)).join("\n") : typeof value === "object" && value ? JSON.stringify(value, null, 2) : String(value ?? "");
  const finite = value => value !== "" && value !== null && value !== undefined && Number.isFinite(Number(value));
  const numberText = value => finite(value) ? Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 4 }) : "—";
  const dateText = value => value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";

  window.createResearch = (api, { onPrompt = () => {}, onClose = () => {}, onState = () => {}, onSwitchMode = async () => false } = {}) => {
    let state = { projects: [], snapshot: null, skills: [], chemistry: {}, exampleProjects: [] };
    let tab = "overview", visible = false, busy = false, switchingMode = false, lastFocus = null, appInert = null;
    let message = "", messageType = "info", formDialog = null;
    const markdown = typeof window.markdownit === "function" ? window.markdownit({ html: false, breaks: true }) : null;
    if (markdown) markdown.validateLink = url => /^https?:\/\//i.test(url);
    const selected = {}, appShell = document.querySelector(".app-shell");
    const panel = node("section", "research-panel"); panel.hidden = true;
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-modal", "true"); panel.setAttribute("aria-label", "BuildMe 药物化学实验工作台");
    const top = node("header", "research-top"), brand = node("div", "research-brand"), emblem = node("span", "research-brand-mark"); emblem.append(icon("flask"));
    const modeHost = node("div", "research-mode-host"), modeTrigger = button("科研版", toggleModeMenu, "research-edition research-mode-trigger"), modeChevron = node("span", "research-mode-chevron", "⌄");
    modeTrigger.append(modeChevron); modeTrigger.setAttribute("aria-label", "切换 BuildMe 版本，当前为科研版"); modeTrigger.setAttribute("aria-haspopup", "menu"); modeTrigger.setAttribute("aria-expanded", "false"); modeTrigger.setAttribute("aria-controls", "research-mode-menu");
    const modeMenu = node("div", "research-mode-menu"); modeMenu.id = "research-mode-menu"; modeMenu.hidden = true; modeMenu.setAttribute("role", "menu"); modeMenu.setAttribute("aria-label", "选择 BuildMe 版本");
    modeMenu.append(node("small", "research-eyebrow", "选择工作台"));
    const modeOptions = [ ["original", "原版工作台", "创造、执行与自由探索", "home"], ["learning", "学习版", "认识 Agent，观察它的工作过程", "book"], ["research", "科研版", "药物化学实验与论文证据", "flask"] ].map(([id, title, description, mark]) => {
      const option = button("", () => void switchMode(id), "research-mode-option"); option.dataset.mode = id;
      option.setAttribute("role", "menuitemradio"); option.setAttribute("aria-checked", String(id === "research"));
      const copy = node("span", "research-mode-copy"); copy.append(node("strong", "", title), node("small", "", description));
      option.replaceChildren(icon(mark), copy, node("span", "research-mode-check", id === "research" ? "✓" : "")); modeMenu.append(option); return option;
    });
    modeHost.append(modeTrigger, modeMenu); brand.append(emblem, node("strong", "", "BuildMe"), modeHost);
    const topActions = node("div", "research-top-actions");
    const saveLabel = node("span", "research-save-label", "课题数据保存在本机");
    topActions.append(saveLabel, button("导出课题", () => operate(async () => { const result = await api.researchExport(); if (!result?.canceled) announce(`课题已导出${result?.path ? `：${result.path}` : ""}`, "success"); }), "research-button"), button("返回聊天", close, "research-button research-back"));
    top.append(brand, topActions);
    const shell = node("div", "research-shell"), sidebar = node("aside", "research-sidebar"), content = node("main", "research-content"), rail = node("aside", "research-rail");
    const projectBlock = node("div", "research-project-block"), nav = node("nav", "research-nav"); nav.setAttribute("aria-label", "科研流程");
    const sidebarBottom = node("div", "research-sidebar-bottom");
    sidebarBottom.append(node("span", "research-local-dot"), node("span", "", "实验驱动 · 证据可追溯"));
    sidebar.append(projectBlock, nav, sidebarBottom);
    const contentHeader = node("div", "research-content-header"), page = node("div", "research-page");
    const notice = node("div", "research-notice"); notice.hidden = true; notice.setAttribute("role", "status"); notice.setAttribute("aria-live", "polite");
    content.append(contentHeader, notice, page);
    shell.append(sidebar, content, rail); panel.append(top, shell); document.body.append(panel);

    function button(label, action, className = "research-button", iconName) {
      const item = node("button", className); item.type = "button";
      if (iconName) item.append(icon(iconName)); item.append(node("span", "", label));
      item.addEventListener("click", action); return item;
    }
    function closeModeMenu(restoreFocus = false) {
      modeMenu.hidden = true; modeTrigger.setAttribute("aria-expanded", "false");
      if (restoreFocus && visible) modeTrigger.focus();
    }
    function openModeMenu(index = 2) {
      if (busy || !visible || formDialog) return;
      modeMenu.hidden = false; modeTrigger.setAttribute("aria-expanded", "true"); modeOptions[index]?.focus();
    }
    function toggleModeMenu() { if (modeMenu.hidden) openModeMenu(); else closeModeMenu(true); }
    async function switchMode(next) {
      if (busy || !visible) return;
      if (next === "research") { closeModeMenu(true); return; }
      closeModeMenu(); busy = true; switchingMode = true; updateBusy();
      let restoreFocus = false;
      try {
        const switched = await onSwitchMode(next);
        if (switched === false && visible) { announce("版本尚未切换，请在当前任务结束后重试。"); restoreFocus = true; }
      } catch (error) { announce(error?.message || String(error), "error"); restoreFocus = true; }
      finally { switchingMode = false; busy = false; updateBusy(); if (restoreFocus && visible) modeTrigger.focus(); }
    }
    modeTrigger.addEventListener("keydown", event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); event.stopPropagation(); openModeMenu(event.key === "ArrowDown" ? 0 : modeOptions.length - 1); }
    });
    modeMenu.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeModeMenu(true); return; }
      if (event.key === "Tab") { event.preventDefault(); event.stopPropagation(); closeModeMenu(); (event.shiftKey ? modeTrigger : topActions.querySelector("button:not(:disabled)") || modeTrigger).focus(); return; }
      const index = modeOptions.indexOf(document.activeElement); let nextIndex;
      if (event.key === "ArrowDown") nextIndex = (index + 1) % modeOptions.length;
      else if (event.key === "ArrowUp") nextIndex = (index - 1 + modeOptions.length) % modeOptions.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = modeOptions.length - 1;
      if (nextIndex !== undefined) { event.preventDefault(); event.stopPropagation(); modeOptions[nextIndex].focus(); }
    });
    modeHost.addEventListener("focusout", event => { if (event.relatedTarget && !modeHost.contains(event.relatedTarget)) closeModeMenu(); });
    panel.addEventListener("pointerdown", event => { if (!modeHost.contains(event.target)) closeModeMenu(); });
    function badge(value, kind = "") { return node("span", `research-badge ${kind}`, value); }
    function provenance(value = "measured") { return badge(PROVENANCE[value] || value, `research-provenance-${value}`); }
    function statusBadge(value = "draft") { return badge(STATUSES[value] || value, `research-status-${value}`); }
    function snapshot() { return state.snapshot || {}; }
    function collection(name) { const value = snapshot()[name]; return Array.isArray(value) ? value : []; }
    function currentProject() { return snapshot().project || state.projects?.find(project => project.id === state.activeProjectId) || null; }
    function lookup(name, id) { return collection(name).find(item => item.id === id); }
    function labelFor(name, id) { const item = lookup(name, id); return item ? item.name || item.title || item.code || item.endpoint || item.id : id ? "关联记录缺失" : "未关联"; }
    function selection(name) { const list = collection(name); return list.find(item => item.id === selected[name]) || list[0] || null; }
    function announce(value, type = "info") { message = value; messageType = type; notice.textContent = value; notice.className = `research-notice research-notice-${type}`; notice.hidden = !value; }
    function updateBusy() {
      panel.setAttribute("aria-busy", String(busy));
      for (const control of panel.querySelectorAll("button, select")) control.disabled = busy || control.dataset.unavailable === "true";
      if (formDialog) for (const control of formDialog.querySelectorAll("button, input, select, textarea")) control.disabled = busy || control.dataset.locked === "true";
      saveLabel.textContent = busy ? "正在处理…" : "课题数据保存在本机";
    }
    async function apply(result) {
      if (result?.projects || Object.prototype.hasOwnProperty.call(result || {}, "snapshot")) { state = result; onState(state); }
      else state = await api.researchState();
      render();
    }
    async function operate(task, success = "") {
      if (busy) return false;
      busy = true; updateBusy();
      try { await task(); if (success) announce(success, "success"); return true; }
      catch (error) { announce(error?.message || String(error), "error"); return false; }
      finally { busy = false; updateBusy(); }
    }
    async function mutate(action, data, success) { return operate(async () => { await apply(await api.researchMutate({ action, data })); }, success || "记录已保存。"); }
    async function refresh() { return operate(async () => { state = await api.researchState(); onState(state); render(); }); }
    async function open(nextState) {
      if (!visible) {
        lastFocus = document.activeElement;
        if (appShell) { appInert = appShell.inert; appShell.inert = true; }
      }
      visible = true; panel.hidden = false;
      if (nextState?.projects || nextState?.snapshot) { state = nextState; render(); }
      else await refresh();
      panel.querySelector(".research-nav button[aria-current='page']")?.focus();
    }
    function close() {
      if (!visible || busy && !switchingMode) return;
      closeModeMenu();
      if (formDialog) dismissForm();
      visible = false; panel.hidden = true;
      if (appShell) appShell.inert = appInert || false;
      onClose(); lastFocus?.focus();
    }
    async function prompt(task, entityId) {
      if (!currentProject()) { showForm("project"); return; }
      await operate(async () => { const result = await api.researchPrompt({ task, ...(entityId ? { entityId } : {}) }); if (!result?.prompt) throw new Error("没有获得实验任务说明，请重试。"); busy = false; close(); onPrompt(result.prompt); });
    }
    function go(nextTab, id) { tab = nextTab; if (id) selected[nextTab] = id; render(); }
    function empty(title, description, actionLabel, action, iconName = "flask") {
      const block = node("div", "research-empty"), mark = node("span", "research-empty-icon"); mark.append(icon(iconName));
      block.append(mark, node("h3", "", title), node("p", "", description));
      if (actionLabel) block.append(button(actionLabel, action, "research-button research-primary", "plus")); return block;
    }
    function sectionTitle(title, description, actions = []) {
      const row = node("div", "research-section-heading"), copy = node("div"); copy.append(node("h3", "", title));
      if (description) copy.append(node("p", "", description)); row.append(copy);
      if (actions.length) { const tools = node("div", "research-actions"); tools.append(...actions); row.append(tools); } return row;
    }
    function detail(label, value, { mono = false } = {}) {
      const row = node("div", "research-detail"), text = node("div", mono ? "research-mono" : "", asText(value) || "待补充"); row.append(node("dt", "", label), text); return row;
    }
    function render() {
      const project = currentProject();
      projectBlock.replaceChildren(node("span", "research-eyebrow", "RESEARCH PROJECT"));
      if (state.projects?.length) {
        const picker = node("select", "research-project-picker"); picker.setAttribute("aria-label", "选择课题");
        for (const item of state.projects) { const option = node("option", "", item.title); option.value = item.id; option.selected = item.id === state.activeProjectId; picker.append(option); }
        picker.addEventListener("change", () => operate(async () => { for (const key of Object.keys(selected)) delete selected[key]; await apply(await api.researchSelectProject(picker.value)); }, "已切换课题。"));
        projectBlock.append(picker);
      } else projectBlock.append(node("strong", "", "我的第一个课题"));
      projectBlock.append(button("新建课题", () => showForm("project"), "research-new-project", "plus"));
      nav.replaceChildren(...NAV.map(([id, title, index]) => {
        const item = button(title, () => go(id), "research-nav-item"); item.prepend(node("small", "", index));
        if (tab === id) item.setAttribute("aria-current", "page");
        const count = id === "paper" ? collection("sections").length : id === "overview" ? null : collection(id).length;
        if (count !== null) item.append(node("span", "research-nav-count", count)); return item;
      }));
      const data = NAV.find(item => item[0] === tab), copy = node("div"), tools = node("div", "research-actions");
      copy.append(node("p", "research-eyebrow", "DRUG DISCOVERY · ALZHEIMER’S"), node("h1", "", data[1]), node("p", "research-page-subtitle", data[3]));
      if (project && (state.exampleProjects || []).some(item => item.id === project.id)) copy.append(node("p", "research-example-notice", EXAMPLE_NOTICE));
      tools.append(button("示例课题", showExamples, "research-button research-examples-button", "book"), button("刷新", refresh, "research-button research-quiet"));
      if (project && tab === "overview") tools.append(button("编辑课题", () => showForm("project", project), "research-button"));
      contentHeader.replaceChildren(copy, tools); announce(message, messageType);
      page.replaceChildren();
      if (!project) renderOnboarding();
      else ({ overview: renderOverview, compounds: renderCompounds, plans: renderPlans, runs: renderRuns, assays: renderAssays, paper: renderPaper })[tab]();
      renderRail(); updateBusy();
    }
    function renderOnboarding() {
      const hero = node("div", "research-onboarding");
      hero.append(node("span", "research-kicker", "让下一步实验，有理由、有记录。"), node("h2", "", "从一个分子，\n开始你的研究。"), node("p", "", "围绕阿尔兹海默症小分子研究，把结构设计、合成方案、真实实验与论文证据连接起来。先保存你已有的课题基础。"));
      const actions = node("div", "research-actions"); actions.append(button("建立我的课题", () => showForm("project"), "research-button research-primary", "plus"), button("看看示例课题", showExamples, "research-button research-examples-button", "book"));
      hero.append(actions, node("p", "research-example-notice", EXAMPLE_NOTICE));
      const pathway = node("div", "research-start-path");
      [["molecule", "已有分子", "导入 SMILES，保留改造理由"], ["route", "实验方案", "比较路线，设计可验证的实验"], ["chart", "实际数据", "关联批次，分析与记录结果"], ["book", "论文证据", "由已完成的实验逐节积累"]].forEach(([mark, title, desc]) => { const item = node("div"); item.append(icon(mark), node("strong", "", title), node("span", "", desc)); pathway.append(item); });
      hero.append(pathway); page.append(hero);
    }
    function renderOverview() {
      const project = currentProject(), hero = node("article", "research-project-hero"), copy = node("div");
      copy.append(node("span", "research-kicker", "当前课题"), node("h2", "", project.title), node("p", "", project.objective || "补充研究目的，让实验建议贴近你的课题。"));
      const tagRow = node("div", "research-tags"); tagRow.append(badge(project.target || "靶点 / 实验体系待补充"), badge("小分子 · 药物化学")); copy.append(tagRow);
      if ((state.exampleProjects || []).some(item => item.id === project.id)) copy.append(node("p", "research-example-notice", EXAMPLE_NOTICE));
      hero.append(copy, icon("molecule")); page.append(hero);
      const stats = node("div", "research-stats");
      [["compounds", "分子结构", "molecule"], ["plans", "合成方案", "route"], ["runs", "反应记录", "flask"], ["assays", "检测数据", "chart"]].forEach(([key, label, mark]) => { const item = button("", () => go(key), "research-stat"); item.replaceChildren(icon(mark), node("strong", "", collection(key).length), node("span", "", label)); stats.append(item); });
      page.append(stats);
      const grid = node("div", "research-overview-grid"), next = node("article", "research-card research-next"), step = nextStep();
      next.append(node("span", "research-eyebrow", "NEXT EXPERIMENT"), node("h3", "", step.title), node("p", "", step.description));
      const actions = node("div", "research-actions"); actions.append(button(step.label, step.action, "research-button research-primary", "arrow"), button("讨论下一步实验", () => prompt("next-experiment"), "research-button")); next.append(actions);
      const evidence = node("article", "research-card"); evidence.append(sectionTitle("研究完整度", "缺失信息会保留为待补充。"));
      const checkList = node("ul", "research-checklist");
      [ ["已保存起始分子", collection("compounds").length > 0, "compounds"], ["已有带假设的合成方案", collection("plans").some(item => item.hypothesis), "plans"], ["反应记录绑定方案版本", collection("runs").length > 0, "runs"], ["产物批次具备纯度记录", collection("batches").some(item => finite(item.purityPercent)), "runs"], ["检测记录可追溯至批次", collection("assays").length > 0, "assays"] ].forEach(([label, done, target]) => { const item = node("li", done ? "is-complete" : ""); const action = button(label, () => go(target), "research-check-action"); action.prepend(node("span", "", done ? "✓" : "○")); item.append(action); checkList.append(item); });
      evidence.append(checkList); grid.append(next, evidence); page.append(grid);
      page.append(sectionTitle("近期记录", "每一步都留在课题档案中。"));
      const timeline = node("div", "research-timeline");
      const items = [ ...collection("runs").map(item => ({ ...item, title: labelFor("plans", item.planId), type: "实验记录", target: "runs" })), ...collection("batches").map(item => ({ ...item, title: item.code, type: "产物批次", target: "runs" })), ...collection("assays").map(item => ({ ...item, title: item.endpoint, type: "检测记录", target: "assays" })), ...collection("plans").map(item => ({ ...item, type: `方案 v${item.version || 1}`, target: "plans" })) ].sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0)).slice(0, 5);
      if (!items.length) timeline.append(empty("实验记录从这里积累", "先保存一个分子，或录入你已经完成的实验。", "添加分子", () => showForm("compound"), "molecule"));
      else items.forEach(item => { const row = button("", () => go(item.target, item.id), "research-timeline-row"), copy = node("span"); copy.append(node("strong", "", item.title), node("small", "", item.type)); row.replaceChildren(node("span", "research-timeline-dot"), copy, node("time", "", dateText(item.updatedAt || item.createdAt)), icon("arrow")); timeline.append(row); });
      page.append(timeline);
      const capabilities = node("article", "research-card research-capabilities-summary"), skills = Array.isArray(state.skills) ? state.skills : state.skills?.skills || [];
      capabilities.append(sectionTitle("科研技能与计算环境", "技能指引实验思考，计算工具返回可保存的实际结果。"));
      const skillTags = node("div", "research-tags"); skills.forEach(skill => skillTags.append(badge(`${skill.title || skill.label || skill.name || skill.id} · ${skill.installed ? "已安装" : "待安装"}`)));
      const runtime = state.chemistry || {};
      capabilities.append(skillTags, node("p", "research-runtime-summary", `RDKit ${runtime.rdkit?.ready ? `已就绪${runtime.rdkit.version ? `（${runtime.rdkit.version}）` : ""}` : "待配置"} · 逆合成模型与库存 ${runtime.retrosynthesis?.ready ? "已就绪" : "待配置"}`));
      if (runtime.retrosynthesis?.reason) capabilities.append(node("small", "research-runtime-summary", runtime.retrosynthesis.reason)); page.append(capabilities);
      renderExampleCards(page);
    }
    function exampleCard(project, index, compact = false) {
      const definitionIndex = { molecule: 0, optimization: 1, evidence: 2 }[project.key] ?? index % EXAMPLE_CARDS.length;
      const definition = EXAMPLE_CARDS[definitionIndex], card = button("", () => void selectExample(project.id), `research-example-card${compact ? " research-example-compact" : ""}`);
      card.dataset.exampleId = project.id; if (project.key) card.dataset.exampleKey = project.key;
      const mark = node("span", "research-example-icon"); mark.append(icon(definition.icon));
      card.replaceChildren(mark, node("span", "research-eyebrow", `0${definitionIndex + 1} · ${definition.title}`), node("strong", "", project.title || definition.title));
      if (!compact) card.append(node("p", "", definition.description), node("small", "research-example-features", definition.features));
      card.append(node("small", "research-example-notice", EXAMPLE_NOTICE));
      const open = node("span", "research-example-open"); open.append(node("span", "", "查看示例"), icon("arrow")); card.append(open); return card;
    }
    function renderExampleCards(parent) {
      const projects = Array.isArray(state.exampleProjects) ? state.exampleProjects : [];
      if (!projects.length) return;
      parent.append(sectionTitle("教学示例课题", EXAMPLE_NOTICE));
      const cards = node("div", "research-example-grid"); projects.slice(0, 3).forEach((project, index) => cards.append(exampleCard(project, index, true))); parent.append(cards);
    }
    async function showExamples() {
      if (busy) return;
      const loaded = await operate(async () => {
        const result = await api.researchExamples();
        if (!result) throw new Error("没有取得示例课题，请重试。");
        await apply(result);
      });
      if (!loaded || !visible) return;
      const projects = Array.isArray(state.exampleProjects) ? state.exampleProjects : [];
      if (!projects.length) { announce("暂时没有可打开的示例课题。", "error"); return; }
      dismissForm(); const dialog = node("dialog", "research-form-dialog research-example-dialog"); formDialog = dialog;
      const body = node("div", "research-form"), header = node("header", "research-form-header"), copy = node("div");
      copy.append(node("span", "research-eyebrow", "EXPLORE THE WORKBENCH"), node("h2", "", "先看看研究如何一步步展开"), node("p", "", "选择一个示例，直接查看分子、实验记录、数据图表与论文证据。示例首次创建后会保留，你自己的修改也会保留。"), node("p", "research-example-notice", EXAMPLE_NOTICE));
      header.append(copy, button("关闭", dismissForm)); body.append(header);
      const cards = node("div", "research-example-grid research-example-dialog-cards"); projects.slice(0, 3).forEach((project, index) => cards.append(exampleCard(project, index))); body.append(cards);
      dialog.append(body); document.body.append(dialog); dialog.showModal();
      dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); else dismissForm(); });
      cards.querySelector("button")?.focus();
    }
    async function selectExample(id) {
      const selectedExample = await operate(async () => {
        for (const key of Object.keys(selected)) delete selected[key];
        await apply(await api.researchSelectProject(id));
      }, `已打开${EXAMPLE_NOTICE}。`);
      if (selectedExample) { dismissForm(); go("overview"); }
    }
    function nextStep() {
      if (!collection("compounds").length) return { title: "保存已有的起始分子", description: "从已知母核、结构改造或已有产物开始，保存结构与研究目的。", label: "添加分子", action: () => showForm("compound") };
      if (!collection("plans").length) return { title: "为分子建立第一份合成方案", description: "写清要验证的假设、反应步骤与对照，让下一次实验可讨论、可复查。", label: "新建方案", action: () => showForm("plan") };
      if (!collection("runs").length) return { title: "记录一次实际反应", description: "绑定使用的方案版本，保存实际条件、产率与观察。失败同样是有用的结果。", label: "记录实验", action: () => showForm("run") };
      if (!collection("batches").length) return { title: "为产物建立独立批次", description: "用批次编号连接实际反应、结构表征、纯度与后续活性检测。", label: "登记批次", action: () => showForm("batch") };
      if (!collection("assays").length) return { title: "导入同一批次的检测数据", description: "保存具体检测方法、对照与重复，先看实测分布，再考虑下一轮实验。", label: "记录检测", action: () => showForm("assay") };
      return { title: "比较结果，提出下一次验证", description: "结合已经完成的反应与检测，检查不确定性，把实验结论积累到论文证据中。", label: "查看实验数据", action: () => go("assays") };
    }
    function splitView(list, detailPane) { const split = node("div", "research-split-view"); split.append(list, detailPane); page.append(split); }
    function recordList(name, titleFn, subFn) {
      const list = node("div", "research-record-list"), active = selection(name);
      for (const item of collection(name)) { const row = button("", () => { selected[name] = item.id; render(); }, "research-record-item"); row.setAttribute("aria-pressed", String(item.id === active?.id)); row.replaceChildren(node("strong", "", titleFn(item)), node("small", "", subFn(item))); list.append(row); }
      return list;
    }
    function renderCompounds() {
      page.append(sectionTitle("结构与改造", `${collection("compounds").length} 个分子 · 保存结构，不把预测当作活性结果`, [button("导入 MOL / SDF", importMolecules), button("添加分子", () => showForm("compound"), "research-button research-primary", "plus")]));
      if (!collection("compounds").length) { page.append(empty("先导入你的分子", "粘贴 SMILES 结构式，并记录母核、立体化学或本次结构改造的目的。", "添加分子", () => showForm("compound"), "molecule")); return; }
      const item = selection("compounds"), pane = node("article", "research-card research-record-detail");
      pane.append(sectionTitle(item.name, "分子档案", [button("编辑", () => showForm("compound", item))]), provenance(item.provenance || "proposed"));
      const propertyAnalysis = collection("analyses").filter(analysis => analysis.compoundId === item.id && /propert|rdkit|descriptor/i.test(analysis.method) && analysis.result?.originalSmiles === item.smiles).at(-1);
      const chemistry = item.properties || item.chemistry || propertyAnalysis?.result || {}, svg = item.structureSvg || chemistry.svg || chemistry.structureSvg;
      const structure = node("div", "research-structure");
      if (svg && typeof svg === "string" && /<svg[\s>]/i.test(svg)) { const image = node("img"); image.alt = `${item.name} 的分子结构`; image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; structure.append(image); }
      else { structure.append(icon("molecule"), node("span", "", "SMILES 结构已保存"), node("small", "", "计算分子性质后生成结构图")); }
      pane.append(structure, detail("SMILES", item.smiles, { mono: true }), detail("立体化学 / 盐型", item.stereo), detail("改造目的与备注", item.notes));
      if (!propertyAnalysis && collection("analyses").some(analysis => analysis.compoundId === item.id && /propert|rdkit|descriptor/i.test(analysis.method))) pane.append(node("p", "research-evidence-note", "结构已更新，请重新计算分子性质；历史结构计算保留在课题档案中。"));
      const actions = node("div", "research-actions"); actions.append(button("计算分子性质", () => operate(async () => apply(await api.researchChemistry({ action: "properties", compoundId: item.id })), "分子计算完成。")), button("搜索逆合成路线", () => {
        if (!state.chemistry?.retrosynthesis?.ready) { announce(`逆合成需要本地 AiZynthFinder 策略模型与库存。${state.chemistry?.retrosynthesis?.reason || "请先完成计算环境配置，再搜索候选路线。"}`); return; }
        return operate(async () => apply(await api.researchChemistry({ action: "retrosynthesis", compoundId: item.id })), "逆合成搜索完成。");
      }), button("讨论结构与路线", () => prompt("routes", item.id), "research-button research-primary", "spark")); pane.append(actions);
      const entries = Object.entries(chemistry.descriptors || chemistry.properties || chemistry).filter(([key, value]) => typeof value === "number" && !["version"].includes(key));
      if (entries.length) { pane.append(sectionTitle("计算性质", "结构描述符仅用于候选比较，不能替代实测药效。"), provenance("computed")); const properties = node("div", "research-property-grid"); entries.forEach(([label, value]) => { const box = node("div"); box.append(node("span", "", ({ molecularWeight: "分子量", exactMass: "精确质量", logP: "CLogP（计算估计）", tpsa: "极性表面积", hBondDonors: "氢键供体", hBondAcceptors: "氢键受体", rotatableBonds: "可旋转键", ringCount: "环数量", aromaticRingCount: "芳香环", formalCharge: "形式电荷", atomCount: "原子数量" })[label] || label), node("strong", "", numberText(value))); properties.append(box); }); pane.append(properties); }
      if (chemistry.warnings?.length) pane.append(node("p", "research-evidence-note", chemistry.warnings.join("\n")));
      const runtime = state.chemistry || {};
      pane.append(node("p", "research-evidence-note", `RDKit ${runtime.rdkit?.ready ? "已就绪" : "运行环境待配置"} · 逆合成${runtime.retrosynthesis?.ready ? "模型与库存已配置" : "需要本地策略模型与库存"}${runtime.retrosynthesis?.reason ? `。${runtime.retrosynthesis.reason}` : ""}`));
      const retro = item.retrosynthesis || collection("analyses").filter(analysis => analysis.compoundId === item.id && /retro|aizynth/i.test(analysis.method) && (analysis.result?.originalSmiles || analysis.result?.evidence?.originalSmiles) === item.smiles).at(-1)?.result;
      if (retro) renderRetrosynthesis(pane, retro);
      const relatedBatches = collection("batches").filter(batch => batch.compoundId === item.id);
      if (relatedBatches.length) { pane.append(sectionTitle("实际产物批次")); relatedBatches.forEach(batch => pane.append(button(`${batch.code} · 纯度 ${numberText(batch.purityPercent)}%`, () => go("runs", batch.runId), "research-link-button"))); }
      splitView(recordList("compounds", value => value.name, value => value.smiles), pane);
    }
    async function importMolecules() {
      return operate(async () => {
        const result = await api.researchImportMolecules();
        if (!result || result.canceled) return;
        await apply(result);
        selected.compounds = collection("compounds").at(-1)?.id;
        go("compounds");
        announce(typeof result.importMessage === "string" ? result.importMessage : result.importMessage ? asText(result.importMessage) : "结构文件已导入，原始文件已归档。", "success");
      });
    }
    function renderRetrosynthesis(parent, result) {
      const routes = Array.isArray(result.routes) ? result.routes : [];
      parent.append(sectionTitle("逆合成搜索结果", `${routes.length} 条候选路线 · 仍需核查底物、选择性与实验条件。`), provenance("predicted"));
      if (!routes.length) parent.append(node("p", "research-evidence-note", "本次运行预算和库存下没有找到候选路线。这不表示该分子无法合成，可以继续核查文献与人工设计路线。"));
      routes.slice(0, 3).forEach((route, index) => {
        const card = node("div", "research-retro-route"); card.append(node("strong", "", `候选路线 ${index + 1}`)); let visited = 0;
        function branch(value, depth) {
          if (!value || typeof value !== "object" || depth > 9 || visited++ > 75) return null;
          const row = node("li"), reaction = value.type === "reaction" || value.is_reaction;
          row.append(node("span", reaction ? "research-retro-reaction research-mono" : "research-retro-molecule research-mono", value.smiles || value.name || (reaction ? "候选反应" : "候选前体")));
          if (value.in_stock || value.inStock) row.append(badge("库存可得"));
          if (value.children?.length) { const children = node("ul"); value.children.forEach(child => { const item = branch(child, depth + 1); if (item) children.append(item); }); row.append(children); }
          return row;
        }
        const tree = node("ul", "research-retro-tree"), entry = branch(route.tree || route.reaction_tree || route, 0);
        if (entry) tree.append(entry); card.append(tree); parent.append(card);
      });
      const details = node("details", "research-version-history"); details.append(node("summary", "", "查看原始计算输出")); const output = JSON.stringify(result, null, 2); details.append(node("pre", "research-raw-result", output.length > 120000 ? `${output.slice(0, 120000)}\n…页面显示已截断，完整结果保存在课题导出中。` : output)); parent.append(details);
    }
    function renderPlans() {
      page.append(sectionTitle("可验证的合成方案", "修改时保留历史版本，实际实验绑定采用的版本。", [button("新建方案", () => showForm("plan"), "research-button research-primary", "plus")]));
      if (!collection("plans").length) { page.append(empty("把实验思路保存成方案", "写下研究假设、候选反应步骤、因素范围、对照和重复。先有可验证的方案，再记录实际执行。", "新建方案", () => showForm("plan"), "route")); return; }
      const item = selection("plans"), pane = node("article", "research-card research-record-detail");
      pane.append(sectionTitle(item.title, `当前版本 v${item.version || 1}`, [button("修订方案", () => showForm("plan", item))]));
      pane.append(provenance(item.provenance || "proposed"), detail("目标分子", labelFor("compounds", item.targetCompoundId)), detail("待验证假设", item.hypothesis));
      const steps = node("ol", "research-route-steps"); (Array.isArray(item.steps) ? item.steps : lines(item.steps)).forEach((step, index) => { const row = node("li"), description = node("div"); description.append(node("strong", "", `步骤 ${index + 1}`), node("p", "", typeof step === "string" ? step : step.description || step.title || JSON.stringify(step))); row.append(node("span", "research-route-node", index + 1), description); steps.append(row); });
      if (steps.children.length) pane.append(steps);
      pane.append(detail("待筛选因素与范围", item.factors), detail("对照", item.controls), detail("独立反应重复", `${item.replicates || "待补充"}${item.replicates ? " 次" : ""}`), detail("文献先例与来源", item.sources));
      const actions = node("div", "research-actions"); actions.append(button("讨论实验假设", () => prompt("hypothesis", item.id)), button("设计条件优化", () => prompt("optimize", item.id), "research-button research-primary", "spark"), button("记录一次实验", () => showForm("run", null, { planId: item.id }))); pane.append(actions);
      const versions = item.versions || item.history || [];
      if (versions.length) { const history = node("details", "research-version-history"); history.append(node("summary", "", `历史版本（${versions.length}）`)); versions.forEach(version => { const entry = node("div", "research-version-item"); entry.append(node("strong", "", `v${version.version || ""} · ${dateText(version.updatedAt || version.createdAt)}`), node("p", "", version.hypothesis || version.title || "历史方案")); history.append(entry); }); pane.append(history); }
      splitView(recordList("plans", value => value.title, value => `v${value.version || 1} · ${labelFor("compounds", value.targetCompoundId)}`), pane);
    }
    function renderRuns() {
      const isExample = (state.exampleProjects || []).some(item => item.id === currentProject()?.id);
      page.append(sectionTitle(isExample ? "示例实验记录" : "实验记录", isExample ? "教学演示中的实验数据为模拟，公开结构和真实计算分别标注来源。" : "按实际开展状态保存条件、观察与阴性结果；未执行的实验保留待开展状态。", [button("登记产物批次", () => showForm("batch")), button("记录实验", () => showForm("run"), "research-button research-primary", "plus")]));
      if (!collection("runs").length) page.append(empty("保留每一次实际实验", "选择合成方案与版本，记录实际反应条件、结果、收率和异常。", "记录实验", () => showForm("run"), "flask"));
      else {
        const item = selection("runs"), pane = node("article", "research-card research-record-detail");
        pane.append(sectionTitle(labelFor("plans", item.planId), `方案 v${item.planVersion || "?"} · ${dateText(item.createdAt)}`, [button("编辑记录", () => showForm("run", item))]));
        const tags = node("div", "research-tags"); tags.append(statusBadge(item.status), provenance(item.provenance || "measured")); pane.append(tags, detail("实际条件", item.conditions), detail("收率", finite(item.yieldPercent) ? `${numberText(item.yieldPercent)}%` : "待测 / 未获得产物"), detail("观察、失败原因与备注", item.notes));
        const actions = node("div", "research-actions"); actions.append(button("登记本次产物", () => showForm("batch", null, { runId: item.id, compoundId: lookup("plans", item.planId)?.targetCompoundId })), button("分析下一步实验", () => prompt("next-experiment", item.id), "research-button research-primary", "spark"), button("导入实验附件", () => importFile("attachment", { runId: item.id }))); pane.append(actions);
        splitView(recordList("runs", value => labelFor("plans", value.planId), value => `${STATUSES[value.status] || value.status} · v${value.planVersion || "?"} · 收率 ${numberText(value.yieldPercent)}%`), pane);
      }
      page.append(sectionTitle("产物批次档案", "表征与活性绑定到实际使用的同一个批次。"));
      if (!collection("batches").length) page.append(node("p", "research-inline-empty", "尚未登记批次。可以为现有化合物或新获得的产物建立批次编号。"));
      else {
        const wrap = node("div", "research-table-wrap"), table = node("table", "research-table");
        table.append(tableHead(["批次", "化合物", "来源实验", "纯度", "操作"])); const body = node("tbody");
        collection("batches").forEach(batch => { const row = node("tr"); row.id = `research-batch-${batch.id}`; [batch.code, labelFor("compounds", batch.compoundId), batch.runId ? labelFor("plans", lookup("runs", batch.runId)?.planId) : "外部 / 已有批次", finite(batch.purityPercent) ? `${numberText(batch.purityPercent)}%${batch.evidenceStatus === "needs-source" ? " · 表征待关联" : ""}` : "待测"].forEach(value => row.append(node("td", "", value))); const tools = node("td", "research-table-actions"); tools.append(button("编辑", () => showForm("batch", batch), "research-link-button"), button("表征附件", () => importFile("characterization", { batchId: batch.id }), "research-link-button"), button("录入检测", () => showForm("assay", null, { batchId: batch.id }), "research-link-button")); row.append(tools); body.append(row); }); table.append(body); wrap.append(table); page.append(wrap);
      }
      renderArtifacts(page);
    }
    function tableHead(labels) { const head = node("thead"), row = node("tr"); labels.forEach(label => row.append(node("th", "", label))); head.append(row); return head; }
    async function importFile(kind, data = {}) { return operate(async () => { const result = await api.researchImport({ kind, ...data }); if (result) { await apply(result); announce("文件已导入，原始文件已归档。", "success"); } }); }
    function renderAssays() {
      page.append(sectionTitle("表征与活性数据", "保存原始读数、检测方法、对照和重复信息。", [button("导入数据文件", () => showImportForm()), button("录入检测", () => showForm("assay"), "research-button research-primary", "plus")]));
      if (!collection("assays").length) { page.append(empty("让活性结果回到实际批次", "先登记产物批次，再粘贴 CSV / TSV 数据或导入检测文件。保留检测体系与原始读数。", "录入检测", () => showForm("assay"), "chart")); renderArtifacts(page); return; }
      const item = selection("assays"), pane = node("article", "research-card research-record-detail");
      pane.append(sectionTitle(item.endpoint, `${labelFor("batches", item.batchId)} · ${item.unit || "单位待补充"}`, [button("编辑检测", () => showForm("assay", item))]));
      pane.append(provenance(item.provenance || "measured"), detail("检测方法与实验体系", item.method), detail("对照", item.controls));
      const records = Array.isArray(item.records) ? item.records : [];
      if (records.length) {
        const graph = measurementChart(records, item); if (graph) pane.append(graph);
        const wrap = node("div", "research-table-wrap research-data-table"), table = node("table", "research-table"); table.append(tableHead(["样本", "浓度", "原始读数", "重复", "组别"]));
        const body = node("tbody"); records.slice(0, 100).forEach(row => { const tr = node("tr"); [row.sampleId || "—", row.concentration ?? "—", numberText(row.value), row.replicate ?? "—", row.group || "—"].forEach(value => tr.append(node("td", "", value))); body.append(tr); }); table.append(body); wrap.append(table); pane.append(sectionTitle("原始数据", `${records.length} 条记录${records.length > 100 ? " · 页面展示前 100 条，导出包含全部数据" : ""}`), wrap);
      } else pane.append(node("p", "research-inline-empty", "原始读数待补充。"));
      const actions = node("div", "research-actions"); actions.append(button("计算描述统计", () => operate(async () => apply(await api.researchAnalyze({ assayId: item.id })), "描述统计已更新。"), "research-button research-primary", "chart"), button("讨论结果与下一步", () => prompt("next-experiment", item.id))); pane.append(actions);
      const analyses = collection("analyses").filter(value => value.assayId === item.id);
      const analysis = analyses.filter(value => value.result?.inputRawAssetId === item.rawAssetId && (!value.result?.inputAssayUpdatedAt || value.result.inputAssayUpdatedAt === item.updatedAt)).at(-1);
      if (analysis || analyses.length) {
        pane.append(sectionTitle("描述统计结果", "按样本编号汇总重复读数，保留真实重复结构。"));
        if (analysis) renderAnalysis(pane, analysis);
        else pane.append(node("p", "research-evidence-note", "检测记录已更新，请重新分析。历史统计结果保留在课题档案中。"));
      }
      splitView(recordList("assays", value => value.endpoint, value => `${labelFor("batches", value.batchId)} · ${(value.records || []).length} 条读数`), pane);
      renderArtifacts(page);
    }
    function measurementChart(records, assay) {
      const rows = records.filter(row => finite(row.value)); if (!rows.length) return null;
      const holder = node("figure", "research-chart"), svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 560 235"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", `${assay.endpoint} 原始读数分布，共 ${rows.length} 条记录`);
      let actualMin = Infinity, actualMax = -Infinity;
      for (const row of rows) { const value = Number(row.value); actualMin = Math.min(actualMin, value); actualMax = Math.max(actualMax, value); }
      const pad = (actualMax - actualMin || Math.abs(actualMax) || 1) * .15, min = actualMin - pad, max = actualMax + pad;
      const y = value => 185 - (value - min) / (max - min) * 145;
      const part = (tag, attrs, text) => { const element = document.createElementNS("http://www.w3.org/2000/svg", tag); Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, value)); if (text !== undefined) element.textContent = String(text); svg.append(element); return element; };
      for (let index = 0; index < 4; index++) { const value = min + (max - min) * index / 3, topY = y(value); part("line", { x1: 60, x2: 535, y1: topY, y2: topY, class: "research-chart-grid" }); part("text", { x: 51, y: topY + 4, "text-anchor": "end", class: "research-chart-label" }, numberText(value)); }
      part("text", { x: 60, y: 18, class: "research-chart-title" }, `${assay.endpoint}${assay.unit ? ` (${assay.unit})` : ""}`);
      const visibleRows = rows.slice(0, 250), groups = [...new Set(visibleRows.map(row => row.group || "未分组"))], concentrationAxis = visibleRows.every(row => finite(row.concentration)) && new Set(visibleRows.map(row => Number(row.concentration))).size > 1;
      const concentrations = visibleRows.map(row => Number(row.concentration)), xMin = Math.min(...concentrations), xMax = Math.max(...concentrations);
      visibleRows.forEach((row, index) => { const cx = concentrationAxis ? 75 + (Number(row.concentration) - xMin) / (xMax - xMin) * 445 : 75 + index / Math.max(1, visibleRows.length - 1) * 445, circle = part("circle", { cx, cy: y(Number(row.value)), r: 4, class: `research-chart-point research-chart-group-${groups.indexOf(row.group || "未分组") % 5}` }); const title = document.createElementNS("http://www.w3.org/2000/svg", "title"); title.textContent = `${row.sampleId} · 读数 ${row.value} · 浓度 ${row.concentration ?? "待补充"} · ${row.group || "未分组"}`; circle.append(title); });
      part("text", { x: 60, y: 213, class: "research-chart-label" }, concentrationAxis ? numberText(xMin) : "1"); part("text", { x: 535, y: 213, "text-anchor": "end", class: "research-chart-label" }, concentrationAxis ? numberText(xMax) : visibleRows.length); part("text", { x: 300, y: 225, "text-anchor": "middle", class: "research-chart-label" }, concentrationAxis ? "浓度（沿用原始记录单位）" : "记录顺序");
      const legend = node("div", "research-chart-legend"); groups.forEach((group, index) => { const label = node("span"); label.append(node("i", `research-chart-legend-dot research-chart-group-${index % 5}`), node("span", "", group)); legend.append(label); });
      holder.append(svg, legend, node("figcaption", "", `每个点代表实际读数${rows.length > 250 ? "，图中展示前 250 条" : ""}。未进行曲线拟合；重复读数不自动视为独立样本。${records.length > rows.length ? ` ${records.length - rows.length} 条缺失读数保留在原始表中。` : ""}`)); return holder;
    }
    function renderAnalysis(parent, analysis) {
      const data = analysis.result || analysis, groups = data.rows || data.groups || data.summary || [];
      if (Array.isArray(groups) && groups.length) {
        const wrap = node("div", "research-table-wrap"), table = node("table", "research-table"); table.append(tableHead(["组别 / 浓度", "样本 n", "读数", "均值", "标准差", "最小值", "最大值"])); const body = node("tbody");
        groups.forEach(group => { const row = node("tr"), label = `${group.label || group.group || group.name || "全部"}${finite(group.concentration) ? ` · ${numberText(group.concentration)}` : ""}`; [label, group.n ?? group.count, group.readings, group.mean, group.sd ?? group.std, group.min, group.max].forEach((value, index) => row.append(node("td", "", index ? numberText(value) : value))); body.append(row); }); table.append(body); wrap.append(table); parent.append(wrap);
      } else { const fields = Object.entries(data).filter(([, value]) => typeof value === "number"); if (fields.length) { const props = node("div", "research-property-grid"); fields.forEach(([key, value]) => { const box = node("div"); box.append(node("span", "", ({ n: "读数数量", count: "读数数量", mean: "均值", sd: "标准差", std: "标准差", min: "最小值", max: "最大值", median: "中位数" })[key] || key), node("strong", "", numberText(value))); props.append(box); }); parent.append(props); } else parent.append(node("pre", "research-raw-result", JSON.stringify(data, null, 2))); }
      const notes = [asText(data.warnings), asText(data.notes), asText(data.inference)].filter(Boolean).join("\n"); if (notes) parent.append(node("p", "research-evidence-note", notes));
    }
    function renderArtifacts(parent) {
      const artifacts = collection("assets"); if (!artifacts.length) return;
      parent.append(sectionTitle("原始文件与表征附件", "专有仪器文件以归档为主，解析结果可在备注中补充。"));
      const files = node("div", "research-file-list"); artifacts.forEach(file => {
        const row = node("div", "research-file-item"), copy = node("div", "research-detail");
        copy.append(node("strong", "", file.name || file.filename || file.originalName || "实验附件"), node("small", "", `${file.batchId ? labelFor("batches", file.batchId) : file.runId ? "实验附件" : "课题附件"} · ${dateText(file.createdAt)}`), button("查看原文件", () => openAsset(file.id), "research-link-button"));
        row.append(icon("book"), copy); files.append(row);
      }); parent.append(files);
    }
    async function openAsset(id) { return operate(async () => { await api.researchOpenAsset(id); announce("已打开归档的原始文件。", "success"); }); }
    function renderPaper() {
      page.append(sectionTitle("按实验积累论文", "草稿依据当前真实记录生成，证据不足处保持待补充。", [button("新增证据结论", () => showForm("claim")), button("添加章节", () => showForm("section"), "research-button", "plus")]));
      const drafting = node("div", "research-draft-actions");
      Object.entries(KINDS).forEach(([kind, label]) => { const action = button("", () => operate(async () => apply(await api.researchDraft({ kind })), `${label}草稿已生成。`), "research-draft-card"); action.replaceChildren(icon("book"), node("strong", "", `整理${label}`), node("small", "", { methods: "来自实际条件、批次与检测方法", results: "来自实测收率、表征与活性读数", discussion: "结合已有证据，保留结论边界" }[kind]), icon("arrow")); drafting.append(action); }); page.append(drafting);
      const sections = collection("sections");
      if (!sections.length) page.append(empty("论文章节随着实验积累", "完成实验记录后，可先生成方法草稿；有实际数据后，再整理结果与讨论。", "添加章节", () => showForm("section"), "book"));
      else sections.forEach(section => { const article = node("article", "research-card research-paper-section"), tags = node("div", "research-tags"); tags.append(statusBadge(section.stale ? "stale" : section.status || "draft"), badge(KINDS[section.kind] || section.kind || "章节")); article.append(sectionTitle(section.title || KINDS[section.kind], `${dateText(section.updatedAt || section.createdAt)}`, [button("编辑章节", () => showForm("section", section))]), tags, markdownBody(section.body)); const evidence = node("div", "research-evidence-links"); evidence.append(node("span", "", "关联证据：")); if (!section.evidenceIds?.length) evidence.append(node("span", "research-missing", "待补充")); else section.evidenceIds.forEach(id => evidence.append(evidenceLink(id))); article.append(evidence); if (section.stale) article.append(node("p", "research-evidence-note", "相关数据发生更新，请复核本节描述与数字。")); page.append(article); });
      page.append(sectionTitle("证据与结论", "记录这项结果实际支持什么，保留实验体系与适用范围。"));
      if (!collection("claims").length) page.append(node("p", "research-inline-empty", "尚无证据结论。可以从一项真实实验或已核验文献开始记录。"));
      else collection("claims").forEach(claim => { const row = node("article", "research-card research-claim"); row.id = `research-claim-${claim.id}`; row.append(provenance(claim.provenance), node("p", "", claim.text), detail("适用范围", claim.scope)); const links = node("div", "research-evidence-links"); (claim.evidenceIds || []).forEach(id => links.append(evidenceLink(id))); row.append(links, button("编辑结论", () => showForm("claim", claim), "research-link-button")); page.append(row); });
    }
    function allEvidence() {
      return [ ...collection("compounds").map(item => ({ id: item.id, label: `分子 · ${item.name}` })), ...collection("plans").map(item => ({ id: item.id, label: `方案 · ${item.title}` })), ...collection("runs").map(item => ({ id: item.id, label: `实验 · ${labelFor("plans", item.planId)} · ${STATUSES[item.status] || item.status}` })), ...collection("batches").map(item => ({ id: item.id, label: `批次 · ${item.code}` })), ...collection("assays").map(item => ({ id: item.id, label: `检测 · ${item.endpoint} · ${labelFor("batches", item.batchId)}` })), ...collection("assets").map(item => ({ id: item.id, label: `文件 · ${item.originalName || "附件"}` })), ...collection("analyses").map(item => ({ id: item.id, label: `分析 · ${item.method}` })), ...collection("claims").map(item => ({ id: item.id, label: `结论 · ${item.text?.slice(0, 60)}` })) ];
    }
    function evidenceLink(id) { const link = button(evidenceLabel(id), () => navigateEvidence(id), "research-badge"); link.title = "查看关联证据"; return link; }
    function navigateEvidence(id) {
      if (lookup("assets", id)) { void openAsset(id); return; }
      for (const target of ["compounds", "plans", "runs", "assays"]) if (lookup(target, id)) { go(target, id); return; }
      const batch = lookup("batches", id);
      if (batch) { go("runs", batch.runId); panel.querySelector(`#research-batch-${id}`)?.scrollIntoView?.({ block: "center" }); return; }
      const analysis = lookup("analyses", id);
      if (analysis) { showAnalysisEvidence(analysis); return; }
      if (lookup("claims", id)) { go("paper"); panel.querySelector(`#research-claim-${id}`)?.scrollIntoView?.({ block: "center" }); return; }
      announce("这条证据已不在当前课题中，请检查原始记录。", "error");
    }
    function showAnalysisEvidence(analysis) {
      if (busy) return;
      dismissForm(); const dialog = node("dialog", "research-form-dialog"); formDialog = dialog;
      const body = node("div", "research-form"), header = node("header", "research-form-header"), copy = node("div");
      copy.append(node("span", "research-eyebrow", "ARCHIVED ANALYSIS"), node("h2", "", analysis.method), node("p", "", "这是所引用的分析记录；当前实验数据的最新分析请在检测页面核对。"));
      header.append(copy, button("关闭", dismissForm)); body.append(header);
      const fields = node("div", "research-form-fields"), detailPane = node("div", "research-field research-field-wide");
      detailPane.append(provenance(analysis.provenance), detail("分析摘要", analysis.summary), detail("记录时间", dateText(analysis.createdAt)));
      const output = JSON.stringify(analysis.result, null, 2); detailPane.append(node("pre", "research-raw-result", output?.length > 120000 ? `${output.slice(0, 120000)}\n…完整计算输出保存在课题导出中。` : output || "没有计算输出。"));
      (analysis.assetIds || []).forEach(id => { const asset = lookup("assets", id); if (asset) detailPane.append(button(`查看原文件 · ${asset.originalName}`, () => openAsset(id), "research-link-button")); });
      fields.append(detailPane); body.append(fields); dialog.append(body); document.body.append(dialog); dialog.showModal();
      dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); else dismissForm(); });
    }
    function markdownBody(text) {
      const body = node("div", "research-section-body");
      if (!markdown) { body.textContent = text || ""; return body; }
      const allowed = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li", "strong", "em", "s", "table", "thead", "tbody", "tr", "th", "td"]);
      const stack = [body];
      function append(tokens) {
        for (const token of tokens) {
          const current = stack.at(-1);
          if (token.type === "inline") { append(token.children || []); continue; }
          if (token.nesting === 1) {
            let element;
            if (token.type === "link_open") {
              const href = token.attrGet("href") || "";
              element = node(/^https?:\/\//i.test(href) ? "a" : "span");
              if (element.tagName === "A") { element.href = href; element.target = "_blank"; element.rel = "noopener noreferrer"; }
            } else element = node(allowed.has(token.tag) ? token.tag : "span", token.tag === "table" ? "research-table" : "");
            if (token.tag === "ol" && token.attrGet("start")) element.start = Number(token.attrGet("start"));
            current.append(element); stack.push(element); continue;
          }
          if (token.nesting === -1) { if (stack.length > 1) stack.pop(); continue; }
          if (token.type === "softbreak" || token.type === "hardbreak") current.append(node("br"));
          else if (token.type === "fence" || token.type === "code_block") { const pre = node("pre", "research-raw-result"); pre.append(node("code", "", token.content)); current.append(pre); }
          else if (token.type === "code_inline") current.append(node("code", "research-inline-code", token.content));
          else if (token.type === "hr") current.append(node("hr"));
          else if (token.type === "image") current.append(document.createTextNode(token.content || "图片"));
          else if (token.content) current.append(document.createTextNode(token.content));
        }
      }
      append(markdown.parse(String(text || ""), {})); return body;
    }
    function evidenceLabel(id) { return allEvidence().find(item => item.id === id)?.label || `证据缺失 · ${id}`; }
    function renderRail() {
      rail.replaceChildren();
      const context = node("div", "research-rail-section"); context.append(node("span", "research-eyebrow", "EVIDENCE FIRST"), node("h3", "", "把每个结论，\n接回实验。"), node("p", "", "分子 → 合成方案 → 实际反应 → 产物批次 → 表征 / 活性 → 论文证据")); rail.append(context);
      const legend = node("div", "research-rail-section"); legend.append(node("h4", "", "来源始终可见"));
      [["measured", "来自实际实验记录"], ["literature", "有可核验的原始来源"], ["predicted", "工具计算，尚需验证"], ["proposed", "实验思路，尚未执行"]].forEach(([key, text]) => { const row = node("div", "research-legend-row"); row.append(provenance(key), node("small", "", text)); legend.append(row); }); rail.append(legend);
      const capability = node("div", "research-rail-section research-skill-status"); capability.append(node("h4", "", "科研技能"));
      const skills = Array.isArray(state.skills) ? state.skills : state.skills?.skills || [];
      if (!skills.length) capability.append(node("p", "", "正在检查技能配置。"));
      else skills.forEach(skill => { const installed = skill.installed ?? skill.available ?? skill.ready ?? false, row = node("div", "research-skill-row"); row.append(node("span", installed ? "is-installed" : "", installed ? "✓" : "○"), node("span", "", skill.label || skill.title || ({ rdkit: "分子结构与性质", medchem: "药物化学规则", retrosynthesis: "逆合成搜索", "hypothesis-generation": "实验假设", "experimental-design": "实验设计", "analytical-method-validation": "分析方法", "statistical-analysis": "统计分析" })[skill.name || skill.id] || skill.name || skill.id), node("small", "", installed ? "已安装" : "待安装")); capability.append(row); });
      const chemistry = state.chemistry || {}, runtime = node("div", "research-runtime-state");
      const rdkit = chemistry.rdkit?.ready ?? chemistry.rdkit?.available ?? chemistry.rdkitAvailable ?? chemistry.available ?? false, retro = chemistry.retrosynthesis?.ready ?? chemistry.retrosynthesis?.available ?? chemistry.retrosynthesisAvailable ?? chemistry.aizynthfinder?.available ?? false;
      runtime.append(node("strong", "", "计算环境"), node("p", "", `RDKit：${rdkit ? "可用" : "尚未就绪"}`), node("p", "", `逆合成模型：${retro ? "已配置" : "待配置模型与库存"}`)); capability.append(runtime); rail.append(capability);
      const boundary = node("div", "research-rail-note"); boundary.append(icon("flask"), node("p", "", "保留检测体系和实际批次。体外结果与计算预测的结论范围，会一直显示在记录与论文中。")); rail.append(boundary);
    }
    function dismissForm() { if (!formDialog) return; const dialog = formDialog; formDialog = null; if (dialog.open) dialog.close(); dialog.remove(); }
    function field(label, key, type = "text", options = {}) { return { label, key, type, ...options }; }
    function choices(name, titleFn, optional = false) { return [ ...(optional ? [{ value: "", label: "不关联 / 已有外部批次" }] : []), ...collection(name).map(item => ({ value: item.id, label: titleFn ? titleFn(item) : item.title || item.name || item.code || item.endpoint })) ]; }
    function provenanceOptions() { return Object.entries(PROVENANCE).map(([value, label]) => ({ value, label })); }
    function schemas(kind, existing, defaults) {
      const base = { ...(existing || {}), ...defaults };
      if (kind === "project") return { title: existing ? "编辑课题" : "建立研究课题", action: "update-project", data: base, fields: [field("课题名称", "title", "text", { required: true, placeholder: "例如：某母核衍生物的合成与体外活性评价" }), field("研究目的与已有基础", "objective", "textarea", { required: true, placeholder: "已知母核、当前问题、已有实验和准备验证的目标" }), field("靶点 / 检测体系", "target", "text", { placeholder: "填写你实际研究的靶点、模型或评价体系" })] };
      if (kind === "compound") return { title: existing ? "编辑分子" : "添加分子结构", action: existing ? "update-compound" : "add-compound", data: base, fields: [field("分子名称 / 编号", "name", "text", { required: true, placeholder: "如化合物 A01 或已知先导物编号" }), field("SMILES 结构", "smiles", "textarea", { required: true, mono: true, placeholder: "粘贴已有的 SMILES，保留立体化学符号" }), field("立体化学 / 盐型说明", "stereo", "text", { placeholder: "未确定时写明未确定" }), field("母核、改造目的与备注", "notes", "textarea", { placeholder: "为什么设计这个分子？已有合成或活性信息来自哪里？" })] };
      if (kind === "plan") return { title: existing ? "修订合成方案" : "新建合成方案", description: existing ? "保存后形成新版本，历史实验仍关联原版本。" : "这是待验证的实验方案，实际执行另行记录。", action: existing ? "revise-plan" : "add-plan", data: base, fields: [field("方案名称", "title", "text", { required: true }), field("目标分子", "targetCompoundId", "select", { required: true, options: choices("compounds") }), field("待验证假设", "hypothesis", "textarea", { required: true, placeholder: "预期会观察到什么？什么结果能支持或否定这个假设？" }), field("反应步骤（每行一步）", "steps", "textarea", { required: true, lines: true }), field("待筛选因素与可行范围", "factors", "textarea", { placeholder: "例如溶剂、温度、时间、当量；填写课题允许的实际范围" }), field("对照与判断标准", "controls", "textarea", { required: true }), field("独立反应重复次数", "replicates", "number", { value: 3, min: 1, max: 100, integer: true, required: true }), field("已核验先例 / 来源（每行一条）", "sources", "textarea", { lines: true, placeholder: "原文 DOI / 链接与适用的底物条件；无法核验时写明待核验" })] };
      if (kind === "run") return { title: existing ? "编辑实际实验" : "记录一次实际实验", action: existing ? "update-run" : "add-run", data: base, fields: [field("采用的合成方案", "planId", "select", { required: true, options: choices("plans") }), field("采用的方案版本", "planVersion", "number", { required: true, integer: true, min: 1, value: lookup("plans", base.planId || collection("plans")[0]?.id)?.version || 1 }), field("实验状态", "status", "select", { value: "completed", options: ["planned", "running", "completed", "failed", "inconclusive"].map(value => ({ value, label: STATUSES[value] })) }), field("实际反应条件", "conditions", "textarea", { required: true, placeholder: "记录实际用量、溶剂、温度、时间、后处理和偏离方案的地方" }), field("分离收率（%）", "yieldPercent", "number", { min: 0, max: 100, step: "any", placeholder: "未测得可留空" }), field("观察、阴性结果与备注", "notes", "textarea", { placeholder: "现象、异常、失败经过或待核实原因" })] };
      if (kind === "batch") return { title: existing ? "编辑产物批次" : "登记产物批次", description: "每次独立制备单独编号，后续检测关联实际使用的批次。", action: existing ? "update-batch" : "add-batch", data: base, fields: [field("批次编号", "code", "text", { required: true, placeholder: "例如 A01-20261014-01" }), field("所属化合物", "compoundId", "select", { required: true, options: choices("compounds") }), field("来源实际实验", "runId", "select", { options: choices("runs", item => `${labelFor("plans", item.planId)} · v${item.planVersion} · ${dateText(item.createdAt)}`, true) }), field("纯度（%）", "purityPercent", "number", { min: 0, max: 100, step: "any", placeholder: "待测可留空" }), field("表征摘要、纯度方法与备注", "notes", "textarea", { placeholder: "NMR / MS / 色谱结论、纯度测定方法、储存与使用情况" })] };
      if (kind === "assay") return { title: existing ? "编辑检测数据" : "录入检测数据", description: "CSV / TSV 表头：sampleId,concentration,value,replicate,group；value 为必填数值。", action: existing ? "update-assay" : "add-assay", data: base, fields: [field("实际检测的产物批次", "batchId", "select", { required: true, options: choices("batches") }), field("检测指标", "endpoint", "text", { required: true, placeholder: "填写原始读数或实际测定指标的名称" }), field("读数单位", "unit", "text", { required: true }), field("检测方法与实验体系", "method", "textarea", { required: true, placeholder: "方法、实验模型、检测设置与样本条件" }), field("对照、重复类型与批次说明", "controls", "textarea", { required: true, placeholder: "阳性/阴性对照、独立样本或重复检测、重复次数" }), field("原始数据（粘贴 CSV / TSV）", "records", "textarea", { required: true, records: true, mono: true, rows: 8, placeholder: "sampleId,concentration,value,replicate,group\nA01,1,23.4,1,treatment" }), field("数据来源", "provenance", "select", { value: "measured", options: provenanceOptions() })] };
      if (kind === "claim") return { title: existing ? "编辑证据结论" : "记录证据结论", action: existing ? "update-claim" : "add-claim", data: base, fields: [field("结论或观察", "text", "textarea", { required: true }), field("适用范围与局限", "scope", "textarea", { required: true, placeholder: "本结论适用于哪一检测体系、条件和数据范围？还缺什么验证？" }), field("证据来源类别", "provenance", "select", { value: "measured", options: provenanceOptions() }), field("关联证据", "evidenceIds", "evidence", { required: true })] };
      return { title: existing ? "编辑论文章节" : "添加论文章节", action: existing ? "update-section" : "add-section", data: base, fields: [field("章节类型", "kind", "select", { options: Object.entries(KINDS).map(([value, label]) => ({ value, label })) }), field("章节标题", "title", "text", { required: true }), field("章节内容", "body", "textarea", { required: true, rows: 12 }), field("状态", "status", "select", { value: "draft", options: ["draft", "needs_review", "verified"].map(value => ({ value, label: STATUSES[value] })) }), field("关联证据", "evidenceIds", "evidence")] };
    }
    function showForm(kind, existing = null, defaults = {}) {
      if (busy) return;
      if (kind !== "project" && !currentProject()) { showForm("project"); return; }
      const required = { plan: ["compounds", "先添加目标分子，再保存合成方案。"], run: ["plans", "先建立合成方案，再记录实际实验。"], batch: ["compounds", "先添加所属化合物，再登记产物批次。"], assay: ["batches", "先登记实际检测的产物批次，再录入数据。"] }[kind];
      if (required && !collection(required[0]).length) { go(required[0] === "batches" ? "runs" : required[0]); announce(required[1]); return; }
      dismissForm(); const schema = schemas(kind, existing, defaults), dialog = node("dialog", "research-form-dialog"); formDialog = dialog;
      schema.action = { project: "updateProject", compound: "addCompound", plan: "savePlan", run: "recordRun", batch: "recordBatch", assay: "recordAssay", claim: "addClaim", section: "saveSection" }[kind];
      if (kind === "run") schema.fields.find(config => config.key === "status").options = ["planned", "running", "completed", "failed", "aborted"].map(value => ({ value, label: STATUSES[value] }));
      if (kind === "section") schema.fields.find(config => config.key === "status").options = ["draft", "reviewed"].map(value => ({ value, label: STATUSES[value] }));
      if (kind === "assay") schema.description = "CSV / TSV 表头：sampleId,concentration,value,replicate,group。每个实际样本保留编号；缺失读数可留空。";
      const immutableFields = existing ? { run: ["planId", "planVersion"], batch: ["compoundId", "runId"], assay: ["batchId"] }[kind] || [] : [];
      const form = node("form", "research-form"), header = node("header", "research-form-header");
      const copy = node("div"); copy.append(node("span", "research-eyebrow", "RESEARCH RECORD"), node("h2", "", schema.title)); if (schema.description) copy.append(node("p", "", schema.description));
      const cancel = button("关闭", dismissForm, "research-form-close"); cancel.setAttribute("aria-label", "关闭表单"); cancel.replaceChildren(icon("close")); header.append(copy, cancel); form.append(header);
      const inputs = {}, body = node("div", "research-form-fields");
      schema.fields.forEach(config => {
        const wrapper = node("div", `research-field${config.type === "textarea" || config.type === "evidence" ? " research-field-wide" : ""}`), id = `research-field-${config.key}`;
        const label = node("label", "", `${config.label}${config.required ? " *" : ""}`); label.htmlFor = id; wrapper.append(label);
        const value = schema.data[config.key] ?? config.value ?? ""; let control;
        if (config.type === "evidence") {
          control = node("fieldset", "research-evidence-picker"); control.id = id; control.append(node("legend", "sr-only", config.label));
          const evidence = allEvidence().filter(item => item.id !== existing?.id);
          if (!evidence.length) control.append(node("p", "research-inline-empty", "还没有实际实验、批次或检测记录可关联。"));
          evidence.forEach(item => { const option = node("label", "research-evidence-option"), input = node("input"); input.type = "checkbox"; input.value = item.id; input.checked = Array.isArray(value) && value.includes(item.id); option.append(input, node("span", "", item.label)); control.append(option); });
        } else if (config.type === "select") { control = node("select"); (config.options || []).forEach(option => { const element = node("option", "", option.label); element.value = option.value; control.append(element); }); if (value !== "") control.value = value; }
        else if (config.type === "textarea") { control = node("textarea"); control.rows = config.rows || 4; control.value = config.records && Array.isArray(value) ? recordsCSV(value) : asText(value); }
        else { control = node("input"); control.type = config.type; control.value = value; if (config.min !== undefined) control.min = config.min; if (config.max !== undefined) control.max = config.max; if (config.step !== undefined) control.step = config.step; else if (config.type === "number") control.step = config.integer ? 1 : "any"; }
        control.id = id; if (config.required && config.type !== "evidence") control.required = true;
        if (config.placeholder) control.placeholder = config.placeholder; if (config.mono) control.classList.add("research-mono");
        if (immutableFields.includes(config.key)) { control.disabled = true; control.dataset.locked = "true"; wrapper.append(node("small", "research-field-note", "关联固定；更换关联请建立新记录。")); }
        inputs[config.key] = control; wrapper.append(control); body.append(wrapper);
      }); form.append(body);
      const formError = node("p", "research-form-error"); formError.hidden = true; formError.setAttribute("role", "alert"); form.append(formError);
      const footer = node("footer", "research-form-footer"), submit = node("button", "research-button research-primary", existing && kind === "plan" ? "保存新版本" : "保存记录"); submit.type = "submit";
      footer.append(node("small", "", "* 为必填项 · 保存真实信息，未知项标记为待补充"), button("取消", dismissForm), submit); form.append(footer); dialog.append(form); document.body.append(dialog); dialog.showModal();
      dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); else dismissForm(); });
      if (kind === "run") inputs.planId?.addEventListener("change", () => { inputs.planVersion.value = lookup("plans", inputs.planId.value)?.version || 1; });
      form.addEventListener("submit", async event => {
        event.preventDefault(); if (busy || !form.reportValidity()) return;
        formError.hidden = true;
        try {
          const data = existing && kind !== "project" ? { id: existing.id } : {};
          if (["run", "batch"].includes(kind)) data.provenance = existing?.provenance || "measured";
          if (["compound", "plan", "section"].includes(kind)) data.provenance = existing?.provenance || "proposed";
          schema.fields.forEach(config => {
            if (immutableFields.includes(config.key)) return;
            const control = inputs[config.key]; let value;
            if (config.type === "evidence") { value = [...control.querySelectorAll("input:checked")].map(input => input.value); if (config.required && !value.length) throw new Error("请至少选择一条已有证据。"); }
            else if (config.records) value = parseRecords(control.value);
            else if (config.type === "number") { value = control.value === "" ? null : Number(control.value); if (value !== null && (!Number.isFinite(value) || config.integer && !Number.isInteger(value))) throw new Error(`${config.label}需要有效${config.integer ? "整数" : "数值"}。`); }
            else if (config.lines) value = lines(control.value);
            else value = control.value.trim();
            data[config.key] = value;
          });
          let result;
          if (kind === "project" && !existing) result = await operate(async () => apply(await api.researchCreateProject(data)), "研究课题已建立。");
          else result = await mutate(schema.action, data, kind === "plan" && existing ? "方案已保存为新版本。" : "记录已保存。");
          if (result) {
            dismissForm();
            if (kind === "project" && !existing) { for (const key of Object.keys(selected)) delete selected[key]; go("overview"); }
            else if (kind !== "project") {
              const entityCollection = { compound: "compounds", plan: "plans", run: "runs", batch: "batches", assay: "assays", claim: "claims", section: "sections" }[kind];
              if (["compound", "plan", "run", "assay"].includes(kind)) selected[entityCollection] = existing?.id || collection(entityCollection).at(-1)?.id;
              go({ compound: "compounds", plan: "plans", run: "runs", batch: "runs", assay: "assays", claim: "paper", section: "paper" }[kind]);
            }
          }
          else { formError.textContent = message; formError.hidden = false; }
        } catch (error) { formError.textContent = error.message || String(error); formError.hidden = false; }
      });
      requestAnimationFrame(() => form.querySelector("input, select, textarea")?.focus());
    }
    function recordsCSV(records) { return ["sampleId,concentration,value,replicate,group", ...records.map(row => [row.sampleId, row.concentration, row.value, row.replicate, row.group].map(value => `"${String(value ?? "").replace(/"/g, '""')}"`).join(","))].join("\n"); }
    function parseRecords(text) {
      const source = String(text || "").trim(); if (!source) throw new Error("请粘贴实际检测数据。");
      if (source.startsWith("[")) { const rows = JSON.parse(source); if (!Array.isArray(rows)) throw new Error("原始数据需要记录数组。"); return validateRecords(rows); }
      const delimiter = source.split(/\r?\n/)[0].includes("\t") ? "\t" : ",", parsed = []; let row = [], value = "", quoted = false;
      for (let index = 0; index < source.length; index++) { const char = source[index]; if (char === '"') { if (quoted && source[index + 1] === '"') { value += '"'; index++; } else quoted = !quoted; } else if (char === delimiter && !quoted) { row.push(value.trim()); value = ""; } else if ((char === "\n" || char === "\r") && !quoted) { if (char === "\r" && source[index + 1] === "\n") index++; row.push(value.trim()); if (row.some(Boolean)) parsed.push(row); row = []; value = ""; } else value += char; }
      if (quoted) throw new Error("CSV 引号没有闭合，请检查粘贴的数据。"); row.push(value.trim()); if (row.some(Boolean)) parsed.push(row);
      const headers = parsed.shift()?.map(item => item.replace(/^\uFEFF/, "").trim()) || [], aliases = { "样本": "sampleId", "样本编号": "sampleId", "浓度": "concentration", "读数": "value", "数值": "value", "重复": "replicate", "组别": "group" }, keys = headers.map(key => aliases[key] || key);
      if (!keys.includes("value") || !keys.includes("sampleId")) throw new Error("数据首行需要 sampleId（或“样本编号”）与 value（或“读数”）表头。每个独立样本必须保留实际编号。");
      return validateRecords(parsed.map((cells, index) => { if (cells.length !== keys.length) throw new Error(`第 ${index + 2} 行列数与表头不一致。`); return Object.fromEntries(keys.map((key, cellIndex) => [key, cells[cellIndex]])); }));
    }
    function validateRecords(rows) {
      if (!rows.length) throw new Error("没有检测数据行。");
      return rows.map((row, index) => {
        if (!row || !String(row.sampleId || "").trim()) throw new Error(`第 ${index + 1} 条记录缺少实际 sampleId。重复检测应使用同一实际样本编号。`);
        const missing = row.value === "" || row.value === null || row.value === undefined;
        if (!missing && !finite(row.value)) throw new Error(`第 ${index + 1} 条记录的 value 不是有效数值；缺失读数请留空。`);
        const output = { sampleId: String(row.sampleId).trim(), value: missing ? null : Number(row.value) };
        ["concentration", "replicate"].forEach(key => { if (row[key] !== "" && row[key] !== null && row[key] !== undefined) { if (!finite(row[key]) || key === "concentration" && Number(row[key]) < 0 || key === "replicate" && (!Number.isInteger(Number(row[key])) || Number(row[key]) < 1)) throw new Error(`第 ${index + 1} 条记录的 ${key} 数值不正确。`); output[key] = Number(row[key]); } });
        if (row.group) output.group = String(row.group); return output;
      });
    }
    function showImportForm() {
      if (!collection("batches").length) { announce("先登记实际使用的产物批次，再导入检测文件。"); go("runs"); return; }
      dismissForm(); const dialog = node("dialog", "research-form-dialog research-import-dialog"); formDialog = dialog;
      const form = node("form", "research-form"), header = node("header", "research-form-header"), copy = node("div"); copy.append(node("h2", "", "导入实验数据"), node("p", "", "CSV / TSV / Excel 导入后关联到选择的批次。原始文件同时归档。")); header.append(copy, button("关闭", dismissForm, "research-button")); form.append(header);
      const fields = node("div", "research-form-fields"), wrapper = node("div", "research-field research-field-wide"), label = node("label", "", "实际使用的产物批次"), picker = node("select"); picker.id = "research-import-batch"; label.htmlFor = picker.id;
      choices("batches").forEach(item => { const option = node("option", "", item.label); option.value = item.value; picker.append(option); }); wrapper.append(label, picker); fields.append(wrapper); form.append(fields);
      const error = node("p", "research-form-error"); error.hidden = true; error.setAttribute("role", "alert"); form.append(error);
      const footer = node("footer", "research-form-footer"), submit = node("button", "research-button research-primary", "选择文件并导入"); submit.type = "submit"; footer.append(button("取消", dismissForm), submit); form.append(footer); dialog.append(form); document.body.append(dialog); dialog.showModal();
      dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); else dismissForm(); });
      form.addEventListener("submit", async event => { event.preventDefault(); const result = await importFile("assay", { batchId: picker.value }); if (result) dismissForm(); else { error.textContent = message; error.hidden = false; } });
    }
    panel.addEventListener("keydown", event => {
      if (event.key === "Escape" && !formDialog) { event.preventDefault(); if (!modeMenu.hidden) closeModeMenu(true); else close(); }
      if (event.key !== "Tab" || formDialog) return;
      const focusable = [...panel.querySelectorAll("button:not(:disabled), select:not(:disabled), [tabindex='0']")].filter(item => !item.closest("[hidden]")), first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    render();
    return { open, close, refresh, openExamples: showExamples, isOpen: () => visible };
  };
})();
