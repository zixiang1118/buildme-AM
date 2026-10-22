(() => {
  "use strict";

  const CAPABILITIES = {
    records: ["记录管理", "自定义表单与本地保存"], files: ["文件导入", "导入 CSV、TSV 和 Excel"],
    statistics: ["统计分析", "按样本和分组计算描述统计"], charts: ["数据绘图", "展示原始数值与分组均值"],
    notes: ["研究笔记", "积累想法与观察"], literature: ["文献助手", "组织检索任务，资料与检索工具需自行接入"], chemistry: ["化学研究助手", "整理研究任务，专业计算工具需自行接入"], simulation: ["仿真研究助手", "讨论模型与参数，仿真工具需自行接入"],
  };
  const TYPES = { text: "短文本", number: "数值", date: "日期", select: "选项", longtext: "多行文本" };
  const KINDS = { records: "记录页面", analysis: "分析页面", notes: "笔记页面" };
  const clone = value => JSON.parse(JSON.stringify(value));
  const uid = prefix => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
  const n = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined && text !== null) el.textContent = String(text); return el; };
  const num = value => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("zh-CN", { maximumFractionDigits: 5 }) : "—";
  const when = value => value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
  const blank = () => ({ schemaVersion: 1, name: "我的科研平台", description: "", pages: [{ id: "records", title: "研究记录", kind: "records", fields: [{ id: "title", label: "标题", type: "text", required: true }, { id: "note", label: "内容", type: "longtext" }] }], capabilities: ["records", "files", "notes"], assistant: { role: "科研助手", instructions: "依据本平台的资料回答；区分原始记录、计算结果与待验证建议。" }, workflows: [] });
  const moduleBlank = () => ({ ...blank(), pages: [], capabilities: [], modules: [] });

  window.createPlatforms = (api, { onPrompt = () => {}, onClose = () => {}, onState = () => {}, onReady = () => {}, onSwitchMode = async () => false } = {}) => {
    let state = { platforms: [], snapshot: null }, visible = false, busy = false, switching = false, priorFocus = null, priorInert = false;
    let view = "home", pageId = "", draft = null, editingId = null, editingVersion = null, builderPageId = "", builderTab = "pages", dialog = null, modeOpen = false, editingProposalId = null;
    const analysisChoices = new Map();
    const moduleCaches = new Map();
    let assemblyDraft = moduleBlank(), moduleFilter = "全部", moduleSearch = "", newestModule = "";
    let moduleEditing = null;
    let draggedModule = "";
    const shell = document.querySelector(".app-shell"), panel = n("section", "platform-panel");
    panel.hidden = true; panel.setAttribute("role", "dialog"); panel.setAttribute("aria-modal", "true"); panel.setAttribute("aria-label", "BuildMe 科研平台搭建");
    const header = n("header", "platform-top"), brand = n("div", "platform-brand"), mark = n("img", "platform-mark platform-module-brand-mark"), modeHost = n("div", "platform-mode-host");
    mark.src = "../assets/buildme-mark.png"; mark.alt = ""; mark.setAttribute("aria-hidden", "true");
    const modeButton = button("科研版 ⌄", () => { modeOpen = !modeOpen; modeMenu.hidden = !modeOpen; modeButton.setAttribute("aria-expanded", String(modeOpen)); if (modeOpen) modeMenu.querySelector("button")?.focus(); }, "platform-mode-trigger");
    modeButton.setAttribute("aria-haspopup", "menu"); modeButton.setAttribute("aria-expanded", "false");
    const modeMenu = n("div", "platform-mode-menu"); modeMenu.hidden = true; modeMenu.setAttribute("role", "menu");
    for (const [id, label, subtitle] of [["original", "原版", "创造、执行与自由探索"], ["learning", "学习版", "认识 Agent，观察工作过程"], ["research", "科研版", "搭建属于自己的科研平台"]]) {
      const item = button("", () => switchMode(id), "platform-mode-option"); item.dataset.mode = id; item.setAttribute("role", "menuitemradio"); item.setAttribute("aria-checked", String(id === "research"));
      const text = n("span"); text.append(n("strong", "", label), n("small", "", subtitle)); item.append(text, n("span", "", id === "research" ? "✓" : "")); modeMenu.append(item);
    }
    modeHost.append(modeButton, modeMenu); brand.append(mark, n("strong", "", "BuildMe"), modeHost);
    const topActions = n("div", "platform-actions"), saving = n("span", "platform-saving", "数据保存在本机");
    const usageGuide = window.createPlatformGuide?.();
    const guideButton = button("搭建与使用说明", () => usageGuide?.open(guideButton), "platform-button platform-guide-entry");
    guideButton.id = "platform-guide-open"; guideButton.setAttribute("aria-haspopup", "dialog"); guideButton.setAttribute("aria-controls", "platform-guide-dialog");
    const disableButton = button("不启用平台", () => selectPlatform(null));
    topActions.append(saving, guideButton, disableButton, button("我的平台", () => navigate("home")), button("返回聊天", close)); header.append(brand, topActions);
    const body = n("div", "platform-shell"), sidebar = n("aside", "platform-sidebar"), sidebarTop = n("div", "platform-sidebar-top"), nav = n("nav", "platform-nav"); nav.setAttribute("aria-label", "平台页面");
    sidebar.append(sidebarTop, nav, n("p", "platform-local", "●  自己搭建 · 持续改进"));
    const content = n("main", "platform-content"), notice = n("div", "platform-notice"), main = n("div", "platform-page"); notice.hidden = true; notice.setAttribute("role", "status"); notice.setAttribute("aria-live", "polite");
    const moduleStatus = n("span", "sr-only"); moduleStatus.setAttribute("role", "status"); moduleStatus.setAttribute("aria-live", "polite"); panel.append(moduleStatus);
    content.append(notice, main); body.append(sidebar, content); panel.append(header, body); document.body.append(panel);

    function button(label, action, cls = "platform-button") { const el = n("button", cls, label); el.type = "button"; el.addEventListener("click", action); return el; }
    function tag(text, cls = "") { return n("span", `platform-tag ${cls}`, text); }
    function heading(title, subtitle, actions = []) { const row = n("div", "platform-heading"), text = n("div"); text.append(n("p", "platform-eyebrow", "BUILD YOUR RESEARCH SPACE"), n("h1", "", title)); if (subtitle) text.append(n("p", "platform-subtitle", subtitle)); row.append(text); if (actions.length) { const a = n("div", "platform-actions"); a.append(...actions); row.append(a); } return row; }
    function card(title, description) { const el = n("section", "platform-card"); if (title) el.append(n("h3", "", title)); if (description) el.append(n("p", "platform-muted", description)); return el; }
    function empty(text) { return n("p", "platform-empty", text); }
    function announce(text, type = "info") { notice.textContent = text; notice.className = `platform-notice platform-notice-${type}`; notice.hidden = !text; }
    function updateBusy() { panel.setAttribute("aria-busy", String(busy)); for (const el of panel.querySelectorAll("button, input, textarea, select")) el.disabled = busy || el.dataset.disabled === "true"; for (const block of panel.querySelectorAll(".platform-assembly-block")) { block.setAttribute("aria-disabled", String(busy)); block.setAttribute("tabindex", busy ? "-1" : "0"); } if (dialog) for (const el of dialog.querySelectorAll("button, input, textarea, select")) el.disabled = busy || el.dataset.disabled === "true"; saving.textContent = busy ? "正在处理…" : "数据保存在本机"; }
    async function operate(action, message) { if (busy) return false; busy = true; updateBusy(); try { await action(); if (message) announce(message, "success"); return true; } catch (error) { announce(error?.message || String(error), "error"); if (dialog) { const e = dialog.querySelector(".platform-dialog-error"); if (e) { e.textContent = error?.message || String(error); e.hidden = false; } } return false; } finally { busy = false; updateBusy(); } }
    function resetWorkspace(next) { if (state.workspace && next.workspace && state.workspace !== next.workspace) { moduleEditing = null; draft = null; assemblyDraft = moduleBlank(); moduleCaches.clear(); moduleFilter = "全部"; moduleSearch = ""; newestModule = ""; view = "home"; } }
    async function apply(value) { const next = value?.platforms || Object.prototype.hasOwnProperty.call(value || {}, "snapshot") ? value : await api.platformState(); resetWorkspace(next); state = next; onState(state); render(); }
    async function refresh() { return operate(async () => { await apply(await api.platformState()); }); }
    async function selectPlatform(id) {
      const okay = await operate(async () => {
        const next = await api.platformSelect(id);
        view = id === null ? "home" : "overview"; pageId = "";
        await apply(next);
      }, id === null ? "已停用科研平台，聊天使用当前模型。可以随时重新选择平台。" : "");
      if (!okay) render();
    }
    async function open(next) { if (!visible) { priorFocus = document.activeElement; priorInert = shell?.inert || false; if (shell) shell.inert = true; } visible = true; panel.hidden = false; if (next?.platforms) { resetWorkspace(next); state = next; render(); } else await refresh(); modeButton.focus(); }
    function dismissDialog() { if (!dialog) return; dialog.close?.(); dialog.remove(); dialog = null; }
    function close() { if (!visible || busy && !switching) return; dismissDialog(); if (moduleEditing) returnFromModuleEditor(); modeOpen = false; modeMenu.hidden = true; modeButton.setAttribute("aria-expanded", "false"); visible = false; panel.hidden = true; if (shell) shell.inert = priorInert; onClose(); priorFocus?.focus?.(); }
    async function switchMode(id) { modeOpen = false; modeMenu.hidden = true; modeButton.setAttribute("aria-expanded", "false"); if (id === "research" || busy) return; busy = true; switching = true; updateBusy(); try { if (await onSwitchMode(id) === false) announce("版本尚未切换，请在当前任务结束后重试。"); } catch (error) { announce(error?.message || String(error), "error"); } finally { busy = false; switching = false; updateBusy(); } }
    function navigate(next, id = "") { if (busy) return; if (moduleEditing) returnFromModuleEditor(); view = next; pageId = id; announce(""); render(); content.scrollTop = 0; }
    function snap() { return state.snapshot || {}; }
    function def() { return snap().definition; }
    function rows(id) { return (snap().records || []).filter(item => item.pageId === id); }
    function enabled(cap) { return (def()?.capabilities || []).includes(cap); }
    function makeInput(type, value, label, onChange, options) { const wrap = n("label", "platform-field"); wrap.append(n("span", "", label)); let input;
      if (type === "select") { input = n("select", "platform-input"); for (const [val, text] of options || []) { const option = n("option", "", text); option.value = val; input.append(option); } }
      else if (type === "longtext") input = n("textarea", "platform-input");
      else { input = n("input", "platform-input"); input.type = type === "number" ? "number" : type === "date" ? "date" : "text"; if (type === "number") input.step = "any"; }
      input.value = value ?? ""; input.setAttribute("aria-label", label); if (onChange) input.addEventListener("input", () => onChange(input.value)); wrap.append(input); return { wrap, input };
    }
    function showDialog(title, build, submitLabel, submit) { dismissDialog(); const d = n("dialog", "platform-dialog"); dialog = d; const form = n("form"), h = n("div", "platform-dialog-heading"); h.append(n("h2", "", title), button("×", () => { if (!busy) dismissDialog(); }, "platform-close")); const fields = n("div", "platform-dialog-fields"), error = n("p", "platform-dialog-error"); error.hidden = true; const footer = n("div", "platform-dialog-footer"); const cancel = button("取消", () => { if (!busy) dismissDialog(); }), save = n("button", "platform-button platform-primary", submitLabel); save.type = "submit"; footer.append(cancel, save); form.append(h, fields, error, footer); d.append(form); document.body.append(d); const data = build(fields); form.addEventListener("submit", async event => { event.preventDefault(); const okay = await operate(() => submit(data)); if (okay) dismissDialog(); }); d.addEventListener("cancel", event => { event.preventDefault(); if (!busy) dismissDialog(); }); d.showModal(); fields.querySelector("input,textarea,select")?.focus(); return d; }
    async function taskPrompt(task, requirement) { return operate(async () => { const result = await api.platformPrompt({ task, ...(requirement ? { requirement } : {}) }); if (!result?.prompt) throw new Error("没有获得任务说明，请重试。"); busy = false; close(); onPrompt(result.prompt); }); }
    function render() {
      const current = def(); sidebarTop.replaceChildren(n("p", "platform-eyebrow", "MY RESEARCH PLATFORMS"));
      disableButton.hidden = !state.activePlatformId;
      disableButton.dataset.disabled = String(Boolean(moduleEditing));
      if (state.platforms?.length) { const select = n("select", "platform-picker"); select.setAttribute("aria-label", "选择科研平台"); select.dataset.disabled = String(Boolean(moduleEditing)); const none = n("option", "", "不启用平台"); none.value = ""; none.selected = !state.activePlatformId; select.append(none); for (const p of state.platforms) { const o = n("option", "", p.name); o.value = p.id; o.selected = p.id === state.activePlatformId; select.append(o); } select.addEventListener("change", () => selectPlatform(select.value || null)); sidebarTop.append(select); }
      else sidebarTop.append(n("strong", "", "从你的需求出发"));
      sidebarTop.append(button("＋ 搭建新平台", () => startBuilder(moduleBlank()), "platform-new"));
      nav.replaceChildren(); const navItem = (title, target, id) => { const el = button(title, () => navigate(target, id), "platform-nav-item"); if (view === target && (!id || id === pageId)) el.setAttribute("aria-current", "page"); nav.append(el); };
      navItem("我的科研平台", "home"); if (current && view !== "home" && view !== "builder") { navItem("平台总览", "overview"); for (const p of current.pages || []) navItem(p.title, "page", p.id); navItem("过程与版本", "history"); }
      if (view === "builder") navItem("平台搭建器", "builder");
      if (moduleEditing) { const item = n("span", "platform-nav-item", "自定义模块"); item.setAttribute("aria-current", "page"); nav.append(item); }
      main.replaceChildren(); if (view === "custom-module" && moduleEditing) renderModuleEditor(); else if (view === "builder" && draft) renderBuilder(); else if (view === "home" || !current) renderHome(); else if (view === "overview") renderOverview(); else if (view === "history") renderHistory(); else renderPage(); updateBusy();
    }
    function renderHome() {
      main.append(heading("我的科研平台", "选择需要的模块，像搭积木一样，拼出自己的科研工作台。"));
      {
        const basic = n("div", "platform-basic"); basic.append(makeInput("text", assemblyDraft.name, "平台名称", v => { assemblyDraft.name = v; }).wrap, makeInput("text", assemblyDraft.description, "平台用途", v => { assemblyDraft.description = v; }).wrap); main.append(basic);
        builderModules(assemblyDraft, true);
      }
      if (draft) { const resume = card("继续刚才的搭建", `${draft.name || "未命名平台"} · 本次修改还没有保存。`); resume.append(button("返回未保存的预览", () => navigate("builder"))); main.append(resume); }
      if (state.platforms?.length) { const list = n("div", "platform-platform-grid"); main.append(n("h2", "platform-section-title", "已经搭建的平台")); for (const p of state.platforms) { const c = card(p.name, p.description || "可以继续调整页面、字段与流程。"), a = n("div", "platform-actions"); c.dataset.platformId = p.id; c.append(tag(`版本 ${p.version || p.definitionVersion || 1}`), n("small", "platform-muted", when(p.updatedAt))); if (p.id === state.activePlatformId) c.append(tag("正在使用")); a.append(button("打开使用", () => selectPlatform(p.id), "platform-button platform-primary"), button("继续搭建", () => operate(async () => { await apply(await api.platformSelect(p.id)); startBuilder(def(), p.id); })), button("删除平台", () => deletePlatform(p), "platform-button platform-danger")); c.append(a); list.append(c); } main.append(list); }
      renderProposals();
      const foot = n("div", "platform-actions"); foot.append(button("导入平台模板", () => operate(async () => { const s = await api.platformTemplateImport(); if (!s?.canceled) { view = "overview"; await apply(s); } })), n("small", "platform-muted", "模板保存结构与设置；实际研究数据单独导出。")); main.append(foot);
    }
    function deletePlatform(platform) {
      const confirmation = showDialog("删除科研平台", fields => {
        fields.append(n("strong", "", platform.name), n("p", "platform-muted", "删除后，该平台将从已搭建的平台列表移除，平台配置、记录和附件会保留在本机归档中。"));
        if (platform.id === state.activePlatformId) fields.append(n("p", "platform-muted", "这个平台正在使用。删除后将停用平台，聊天使用当前模型。"));
      }, "确认删除", async () => {
        const next = await api.platformDelete(platform.id);
        if (editingId === platform.id) { draft = null; editingId = null; editingVersion = null; editingProposalId = null; }
        view = "home"; pageId = "";
        await apply(next);
        announce("平台已删除，研究数据已保留在本机归档中。", "success");
      });
      confirmation.querySelector('[type="submit"]').classList.remove("platform-primary");
      confirmation.querySelector('[type="submit"]').classList.add("platform-danger");
      confirmation.querySelector(".platform-dialog-footer button").focus();
    }
    function moduleCatalog() {
      const portable = [...(snap().definition?.customModules || []), ...(assemblyDraft.customModules || []), ...(draft?.customModules || []), ...(moduleEditing?.target.customModules || [])];
      return [...new Map([...(state.moduleCatalog || []), ...portable].map(spec => [spec.id, spec])).values()];
    }
    function selectedModules(target) { return target.modules || [...new Set(target.pages.map(p => p.moduleId).filter(Boolean))]; }
    function moduleTitle(id) { return moduleCatalog().find(m => m.id === id)?.title || id; }
    function applyModuleSelection(target, ids) {
      const previous = selectedModules(target), before = new Set(previous), next = new Set(ids);
      if (!moduleCaches.has(target)) moduleCaches.set(target, new Map());
      const cache = moduleCaches.get(target), removed = new Set();
      for (const id of previous.filter(id => !next.has(id))) {
        const pages = target.pages.filter(p => p.moduleId === id); cache.set(id, clone(pages));
        pages.forEach(p => removed.add(p.id));
      }
      target.pages = target.pages.filter(p => !removed.has(p.id));
      for (const entry of [...target.pages, ...target.workflows]) if (removed.has(entry.sourcePageId)) for (const key of ["sourcePageId", "valueField", "groupField", "sampleField"]) delete entry[key];
      for (const id of ids.filter(id => !before.has(id))) {
        const spec = moduleCatalog().find(m => m.id === id); if (!spec) continue;
        const archived = target === draft && editingId ? (snap().archivedPages || []).filter(p => p.moduleId === id) : [];
        const pages = clone(cache.get(id)?.length ? cache.get(id) : archived.length ? archived : spec.pages), remap = new Map();
        const occupied = new Set(target.pages.map(p => p.id));
        for (const page of pages) { const original = page.id; if (occupied.has(page.id)) page.id = uid(`module_${id}`); occupied.add(page.id); remap.set(original, page.id); page.moduleId = id; }
        for (const page of pages) if (page.sourcePageId && remap.has(page.sourcePageId)) page.sourcePageId = remap.get(page.sourcePageId);
        target.pages.push(...pages);
      }
      const oldCapabilities = new Set(moduleCatalog().filter(m => before.has(m.id)).flatMap(m => m.capabilities));
      const extraCapabilities = target.capabilities.filter(c => !oldCapabilities.has(c));
      const custom = target.pages.filter(p => !p.moduleId);
      if (custom.some(p => p.kind === "records")) extraCapabilities.push("records");
      if (custom.some(p => p.kind === "notes")) extraCapabilities.push("notes");
      if (custom.some(p => p.kind === "analysis")) extraCapabilities.push("statistics", "charts");
      target.capabilities = [...new Set([...extraCapabilities, ...moduleCatalog().filter(m => next.has(m.id)).flatMap(m => m.capabilities)])];
      target.modules = [...ids];
      const customModules = moduleCatalog().filter(spec => next.has(spec.id) && spec.id.startsWith("custom_"));
      if (customModules.length || target.customModules?.length) target.customModules = [...new Map([...(target.customModules || []), ...customModules].map(spec => [spec.id, clone(spec)])).values()];
      target.pages = [...ids.flatMap(id => target.pages.filter(p => p.moduleId === id)), ...custom];
    }
    function toggleModule(target, id) {
      if (busy) return;
      const ids = selectedModules(target), removing = ids.includes(id);
      applyModuleSelection(target, removing ? ids.filter(value => value !== id) : [...ids, id]);
      newestModule = removing ? "" : id;
      announce("");
      renderAssemblyChange(); panel.querySelector(`.platform-module-card[data-module-id="${id}"]`)?.focus();
      moduleStatus.textContent = `${moduleTitle(id)}${removing ? "已移出组合" : "已加入组合"}，当前 ${target.modules.length} 块积木。`;
    }
    // Keep keyed bricks alive so rapid selections continue from their current position.
    function renderAssemblyChange() {
      const previousSvg = main.querySelector(".platform-assembly-svg"), previousGrid = main.querySelector(".platform-module-grid");
      const listScroll = main.querySelector(".platform-assembly-list")?.scrollTop || 0;
      const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      const previousBlocks = new Map([...previousSvg?.querySelectorAll(".platform-assembly-block") || []].filter(el => el.dataset.leaving !== "true").map(el => { const style = window.getComputedStyle?.(el); return [el.dataset.moduleId, { el, transform: style?.transform || el.getAttribute("transform"), opacity: style?.opacity ?? 1 }]; }));
      const previousRows = new Map([...main.querySelectorAll(".platform-assembly-item")].map(el => [el.dataset.moduleId, el.getBoundingClientRect?.()]));
      render();
      const nextGrid = main.querySelector(".platform-module-grid"), nextSvg = main.querySelector(".platform-assembly-svg");
      if (previousGrid && nextGrid) for (const tile of [...nextGrid.querySelectorAll(".platform-module-card")]) {
        const old = [...previousGrid.querySelectorAll(".platform-module-card")].find(el => el.dataset.moduleId === tile.dataset.moduleId);
        if (!old) continue;
        for (const attr of ["aria-pressed", "aria-label"]) old.setAttribute(attr, tile.getAttribute(attr));
        old.querySelector(".platform-module-toggle").textContent = tile.querySelector(".platform-module-toggle").textContent;
        tile.replaceWith(old);
      }
      if (previousSvg && nextSvg) {
        for (const block of [...nextSvg.querySelectorAll(".platform-assembly-block")]) {
          const prior = previousBlocks.get(block.dataset.moduleId), destination = block.getAttribute("transform");
          const [x, y] = destination.match(/-?[\d.]+/g).map(Number), to = `translate(${x}px, ${y}px)`;
          const node = prior?.el || block;
          if (prior) {
            previousBlocks.delete(block.dataset.moduleId);
            node.getAnimations?.().forEach(animation => animation.cancel());
            node.setAttribute("transform", destination);
            node.replaceChildren(...block.childNodes);
            block.replaceWith(node);
          }
          node.dataset.new = "false";
          if (!reducedMotion && node.animate) node.animate([
            { transform: prior?.transform || `translate(${x}px, ${y - 64}px)`, opacity: prior?.opacity ?? 0 },
            { transform: to, opacity: 1 },
          ], { duration: prior ? 420 : 520, easing: "cubic-bezier(.22,1,.36,1)" });
        }
        previousSvg.setAttribute("viewBox", nextSvg.getAttribute("viewBox"));
        previousSvg.setAttribute("aria-label", nextSvg.getAttribute("aria-label"));
        previousSvg.replaceChildren(...nextSvg.childNodes); nextSvg.replaceWith(previousSvg);
        if (!reducedMotion) for (const { el, transform, opacity } of previousBlocks.values()) {
          if (!el.animate) continue;
          el.getAnimations?.().forEach(animation => animation.cancel());
          el.dataset.leaving = "true"; el.setAttribute("aria-hidden", "true"); el.setAttribute("tabindex", "-1"); el.style.pointerEvents = "none";
          previousSvg.append(el);
          const animation = el.animate([{ transform, opacity }, { transform, opacity: 0 }], { duration: 180, easing: "ease-out", fill: "forwards" });
          animation.onfinish = () => el.remove();
        }
      }
      const list = main.querySelector(".platform-assembly-list"); if (list) list.scrollTop = listScroll;
      if (!reducedMotion) for (const row of main.querySelectorAll(".platform-assembly-item")) {
        const before = previousRows.get(row.dataset.moduleId), after = row.getBoundingClientRect?.();
        if (!row.animate || !after) continue;
        const dy = before ? before.top - after.top : 14;
        if (dy || !before) row.animate([{ transform: `translateY(${dy}px)`, opacity: before ? 1 : 0 }, { transform: "translateY(0)", opacity: 1 }], { duration: 360, easing: "cubic-bezier(.22,1,.36,1)" });
      }
    }
    function moveModule(target, id, to) {
      if (busy) return;
      const ids = selectedModules(target), from = ids.indexOf(id);
      if (from < 0 || to < 0 || to >= ids.length || from === to) return;
      const next = [...ids]; next.splice(from, 1); next.splice(to, 0, id);
      applyModuleSelection(target, next); newestModule = ""; renderAssemblyChange();
      moduleStatus.textContent = `${moduleTitle(id)}已移至第 ${to + 1} 块，组合顺序已更新。`;
    }
    function svgNode(tag, attrs = {}, text) { const el = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value)); if (text !== undefined) el.textContent = text; return el; }
    function cubeIcon(color) {
      const icon = svgNode("svg", { viewBox: "0 0 48 54", "aria-hidden": "true", class: "platform-module-icon" }); icon.style.setProperty("--brick-color", color);
      icon.append(svgNode("polygon", { points: "24,3 45,15 24,27 3,15", class: "brick-top" }), svgNode("polygon", { points: "3,15 24,27 24,51 3,39", class: "brick-left" }), svgNode("polygon", { points: "24,27 45,15 45,39 24,51", class: "brick-right" })); return icon;
    }
    function assemblyGraphic(target) {
      const canvas = n("div", "platform-assembly-canvas"), svg = svgNode("svg", { viewBox: "0 0 420 330", class: "platform-assembly-svg", role: "group", "aria-label": `科研平台积木预览，已选择 ${selectedModules(target).length} 个模块` });
      svg.append(svgNode("polygon", { points: "210,159 362,244 210,327 58,244", class: "platform-assembly-base" }));
      const positions = [[0,0,0],[1,0,0],[0,0,1],[0,1,0],[1,1,0],[1,0,1],[0,1,1],[1,1,1],[0,0,2],[1,0,2],[0,1,2]];
      const ids = selectedModules(target);
      const highest = Math.min(0, ...ids.map((_, index) => { const [x,y,z] = positions[index] || [index % 2, Math.floor(index / 2) % 2, Math.floor(index / 4)]; return 164 + (x+y)*29 - z*51 - 12; }));
      svg.setAttribute("viewBox", `0 ${highest} 420 ${330 - highest}`);
      ids.map((id, index) => ({ id, index, position: positions[index] || [index % 2, Math.floor(index / 2) % 2, Math.floor(index / 4)] })).sort((a,b) => a.position[0] + a.position[1] - b.position[0] - b.position[1] || a.position[2] - b.position[2]).forEach(({ id, index, position: [x,y,z] }) => {
        const spec = moduleCatalog().find(m => m.id === id); if (!spec) return;
        const block = svgNode("g", { class: "platform-assembly-block", transform: `translate(${210 + (x-y)*52} ${164 + (x+y)*29 - z*51})`, tabindex: 0, role: "button", "aria-label": `移除${spec.title}`, "data-module-id": id, "data-new": id === newestModule }); block.style.setProperty("--brick-color", spec.color);
        block.append(svgNode("title", {}, `${index + 1}. ${spec.title} · 点击移除`), svgNode("polygon", { points: "0,0 52,29 0,58 -52,29", class: "brick-top" }), svgNode("polygon", { points: "-52,29 0,58 0,109 -52,80", class: "brick-left" }), svgNode("polygon", { points: "0,58 52,29 52,80 0,109", class: "brick-right" }), svgNode("text", { x: 0, y: 34, "text-anchor": "middle", class: "brick-number" }, String(index+1).padStart(2,"0")));
        block.addEventListener("click", () => toggleModule(target, id));
        block.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleModule(target, id); } }); svg.append(block);
      });
      canvas.append(svg); if (!ids.length) { const empty = n("div", "platform-assembly-empty"); empty.append(n("strong", "", "从第一块积木开始"), n("span", "", "选择左侧模块，搭建你的科研平台")); canvas.append(empty); } return canvas;
    }
    function renderModuleCards(grid, target) {
      grid.replaceChildren(); const ids = selectedModules(target), query = moduleSearch.trim().toLowerCase();
      const matches = moduleCatalog().filter(m => (moduleFilter === "全部" || m.group === moduleFilter) && (!query || `${m.title} ${m.description}`.toLowerCase().includes(query)));
      for (const spec of matches) {
        const selected = ids.includes(spec.id), tile = button("", () => toggleModule(target, spec.id), "platform-module-card"); tile.dataset.moduleId = spec.id; tile.style.setProperty("--module-color", spec.color); tile.setAttribute("aria-pressed", String(selected)); tile.setAttribute("aria-label", `${selected ? "移除" : "添加"}${spec.title}`);
        const copy = n("span", "platform-module-copy"); copy.append(n("strong", "", spec.title), n("small", "", spec.description)); tile.append(cubeIcon(spec.color), copy, n("span", "platform-module-toggle", selected ? "✓" : "+")); grid.append(tile);
      }
      if (!matches.length) grid.append(empty("没有找到对应模块，试试其他关键词。"));
      const custom = button("", () => createCustomModule(target), "platform-custom-module-card"); custom.id = "platform-custom-module"; custom.setAttribute("aria-label", "添加自定义模块"); custom.setAttribute("aria-haspopup", "dialog");
      const plus = n("span", "platform-custom-module-plus", "+"); plus.setAttribute("aria-hidden", "true"); custom.append(plus, n("strong", "", "自定义模块"), n("small", "", "自己设计，或描述需求让 AI 生成")); grid.append(custom);
    }
    function createCustomModule(target) {
      showDialog("创建自定义模块", fields => {
        const manual = button("自己设计", () => { dismissDialog(); startModuleEditor(target); }, "platform-button platform-custom-manual");
        fields.append(n("p", "platform-muted", "把你的记录、笔记或数据分析设计成一块可复用的科研积木。"), manual, n("p", "platform-muted", "也可以说出你的需求，让 AI 生成可修改的模块预览。"));
        const requirement = makeInput("longtext", "", "描述模块需求"); requirement.input.required = true; requirement.input.rows = 5;
        requirement.input.placeholder = "例如：记录设备校准日期、设备编号和偏差，按设备分组分析数值，并保留校准备注。";
        fields.append(requirement.wrap, n("small", "platform-muted", "使用当前配置的模型。生成后先检查页面、字段和能力，保存后才加入模块库。"));
        return requirement.input;
      }, "让 AI 生成", async input => {
        const requirement = input.value.trim(); if (!requirement) throw new Error("请先描述你想要的模块。");
        const result = await api.platformModuleGenerate({ requirement });
        if (!result?.module) throw new Error("AI 没有返回可用的模块预览，请重试。");
        startModuleEditor(target, result.module, result.explanation);
        announce("AI 模块预览已生成。可以继续调整，保存后才会加入模块库和当前组合。", "success");
      });
    }
    function startModuleEditor(target, spec = null, explanation = "") {
      moduleEditing = { target, id: spec?.id, explanation, color: spec?.color || "#83b6a2", group: spec?.group || "自定义", previous: { draft, editingId, editingVersion, editingProposalId, builderPageId, builderTab, view, pageId, moduleFilter, moduleSearch, newestModule } };
      draft = { ...blank(), name: spec?.title || "我的模块", description: spec?.description || "", capabilities: clone(spec?.capabilities || ["records", "files"]), pages: clone(spec?.pages || [{ id: "records", title: "模块记录", kind: "records", fields: [{ id: "title", label: "名称", type: "text", required: true }, { id: "notes", label: "备注", type: "longtext" }] }]) };
      for (const page of draft.pages) delete page.moduleId;
      editingId = null; editingVersion = null; editingProposalId = null; builderPageId = draft.pages[0]?.id || ""; builderTab = "pages"; view = "custom-module";
      render(); content.scrollTop = 0; main.querySelector('[aria-label="模块名称"]')?.focus();
    }
    function returnFromModuleEditor() {
      if (!moduleEditing) return;
      const previous = moduleEditing.previous;
      ({ draft, editingId, editingVersion, editingProposalId, builderPageId, builderTab, view, pageId, moduleFilter, moduleSearch, newestModule } = previous);
      moduleEditing = null;
    }
    async function saveCustomModule() {
      return operate(async () => {
        if (!draft.name.trim()) throw new Error("请填写模块名称。");
        if (!draft.pages.length) throw new Error("模块至少需要一个工作页面。");
        const target = moduleEditing.target;
        const next = await api.platformModuleSave({ ...(moduleEditing.id ? { id: moduleEditing.id } : {}), title: draft.name, description: draft.description, group: moduleEditing.group, color: moduleEditing.color, pages: clone(draft.pages), capabilities: clone(draft.capabilities) });
        if (!next?.savedModule?.id) throw new Error("模块保存结果不完整，请刷新后重试。");
        state = next; onState(state);
        const spec = next.savedModule;
        returnFromModuleEditor();
        target.customModules = [...new Map([...(target.customModules || []), spec].map(item => [item.id, clone(item)])).values()];
        applyModuleSelection(target, [...selectedModules(target), spec.id]); newestModule = spec.id;
        moduleFilter = "全部"; moduleSearch = "";
        render(); content.scrollTop = 0;
        announce(`${spec.title}已保存为自定义模块，并加入当前组合。保存平台后即可使用。`, "success");
        moduleStatus.textContent = `${spec.title}已加入组合。`;
      });
    }
    function renderModuleEditor() {
      main.append(heading("设计你的自定义模块", "定义工作页面、记录字段与分析能力，检查预览后保存为可复用的积木。", [button("返回模块组合", () => { returnFromModuleEditor(); render(); content.scrollTop = 0; }), button("保存模块并加入组合", saveCustomModule, "platform-button platform-primary")]));
      if (moduleEditing.explanation) main.append(n("p", "platform-muted platform-module-design-note", moduleEditing.explanation));
      const colors = [["#83b6a2", "绿色"], ["#4d79d8", "蓝色"], ["#8b70cf", "紫色"], ["#d6924e", "橙色"], ["#cb6b86", "粉色"]];
      if (!colors.some(([color]) => color === moduleEditing.color)) colors.unshift([moduleEditing.color, "生成的颜色"]);
      const basic = n("div", "platform-basic"); basic.append(makeInput("text", draft.name, "模块名称", value => { draft.name = value; }).wrap, makeInput("text", draft.description, "模块用途", value => { draft.description = value; }).wrap,
        makeInput("text", moduleEditing.group, "模块分类", value => { moduleEditing.group = value; }).wrap,
        makeInput("select", moduleEditing.color, "积木颜色", value => { moduleEditing.color = value; }, colors).wrap); main.append(basic);
      const tabs = n("div", "platform-builder-tabs"); for (const [id, title] of [["pages", "页面与字段"], ["capabilities", "模块能力"], ["preview", "使用预览"]]) { const tab = button(title, () => { builderTab = id; render(); }, "platform-tab"); tab.setAttribute("aria-selected", String(builderTab === id)); tabs.append(tab); } main.append(tabs);
      if (builderTab === "pages") builderPages(); else if (builderTab === "capabilities") main.append(capabilityGrid()); else builderPreview();
      main.append(n("p", "platform-muted", "模块保存到当前工作区，可以在其他平台中复用。模块库中的新积木不会自动修改已保存的平台。"));
    }
    function builderModules(target = draft, home = false) {
      const layout = n("div", "platform-module-builder"), library = n("section", "platform-module-library"), toolbar = n("div", "platform-module-toolbar"), text = n("div");
      text.append(n("h2", "", "科研积木搭建"), n("p", "platform-muted", "选择需要的积木，组合成能在对话中使用的科研能力。")); toolbar.append(text, n("span", "platform-module-count", `${moduleCatalog().length} 个可选模块`)); library.append(toolbar);
      const chatNote = n("div", "platform-module-chat-note"); chatNote.append(n("strong", "", "搭好积木，直接对话"), n("span", "", "保存后回到聊天，告诉助手你要记录、导入或分析什么，助手会调用当前平台的模块完成任务。")); library.append(chatNote);
      const filters = n("div", "platform-module-filters"); filters.setAttribute("role", "group"); filters.setAttribute("aria-label", "筛选科研模块");
      for (const group of ["全部", ...new Set(moduleCatalog().map(m => m.group))]) { const filter = button(group, () => { moduleFilter = group; render(); [...panel.querySelectorAll(".platform-module-filter")].find(b => b.textContent === group)?.focus(); }, "platform-module-filter"); filter.setAttribute("aria-pressed", String(group === moduleFilter)); filters.append(filter); } library.append(filters);
      const search = n("input", "platform-input platform-module-search"); search.type = "search"; search.placeholder = "搜索模块，例如：数据、实验、文献"; search.setAttribute("aria-label", "搜索科研模块"); search.value = moduleSearch;
      const grid = n("div", "platform-module-grid"); search.addEventListener("input", () => { moduleSearch = search.value; renderModuleCards(grid, target); updateBusy(); }); library.append(search, grid); renderModuleCards(grid, target);
      const assembly = n("section", "platform-assembly"), head = n("div", "platform-assembly-header"), title = n("div"), ids = selectedModules(target);
      title.append(n("strong", "", "我的科研积木"), n("small", "", "组合能力 · 在对话中使用")); const count = n("span", "platform-module-count", `${ids.length} / ${moduleCatalog().length}`); count.setAttribute("aria-live", "polite"); head.append(title, count); assembly.append(head, assemblyGraphic(target));
      const legend = n("p", "platform-module-legend", ids.length ? "拖动下方积木可排序 · 点击立方体可移除" : "选择左侧积木，逐块搭建你的科研能力"); assembly.append(legend);
      const list = n("ol", "platform-assembly-list"); list.setAttribute("aria-label", "已选择的科研模块");
      ids.forEach((id, index) => {
        const spec = moduleCatalog().find(m => m.id === id); if (!spec) return;
        const item = n("li", "platform-assembly-item"); item.dataset.moduleId = id; item.style.setProperty("--module-color", spec.color); item.draggable = true;
        item.addEventListener("dragstart", event => { if (busy) { event.preventDefault(); return; } draggedModule = id; item.classList.add("is-dragging"); event.dataTransfer?.setData("text/plain", id); if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"; });
        item.addEventListener("dragover", event => { if (!busy && draggedModule && draggedModule !== id) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "move"; item.classList.add("is-drop-target"); } });
        item.addEventListener("dragleave", event => { if (!item.contains(event.relatedTarget)) item.classList.remove("is-drop-target"); });
        item.addEventListener("drop", event => { event.preventDefault(); item.classList.remove("is-drop-target"); if (draggedModule) moveModule(target, draggedModule, index); draggedModule = ""; });
        item.addEventListener("dragend", () => { draggedModule = ""; for (const row of main.querySelectorAll(".platform-assembly-item")) row.classList.remove("is-dragging", "is-drop-target"); });
        const copy = n("span", "platform-assembly-copy"); copy.append(n("strong", "", spec.title), n("small", "", `${target.pages.filter(p => p.moduleId === id).length} 个工作页面`));
        const actions = n("div", "platform-assembly-actions");
        for (const [direction, label, delta] of [["↑", "上移", -1], ["↓", "下移", 1]]) { const move = button(direction, () => { moveModule(target, id, index + delta); panel.querySelector(`.platform-assembly-item[data-module-id="${id}"] button[aria-label="${label}${spec.title}"]`)?.focus(); }, "platform-mini"); move.setAttribute("aria-label", `${label}${spec.title}`); move.dataset.disabled = String(index + delta < 0 || index + delta >= ids.length); actions.append(move); }
        const remove = button("×", () => toggleModule(target, id), "platform-mini"); remove.setAttribute("aria-label", `移除${spec.title}`); actions.append(remove); const grip = n("span", "platform-assembly-grip", "⠿"); grip.setAttribute("aria-hidden", "true"); item.append(grip, n("span", "platform-assembly-index", String(index+1).padStart(2,"0")), copy, actions); list.append(item);
      }); assembly.append(list);
      const footer = n("div", "platform-assembly-footer"), clear = button("清空积木", () => { applyModuleSelection(target, []); newestModule = ""; renderAssemblyChange(); moduleStatus.textContent = "已清空本次模块组合。"; }); clear.dataset.disabled = String(!ids.length);
      const save = button(home || !editingId ? "保存并进入对话" : "保存变更并进入对话", () => { if (home) { startBuilder(target); reviewSave(); } else reviewSave(); }, "platform-button platform-primary"); save.dataset.disabled = String(!ids.length && !target.pages.some(p => !p.moduleId)); footer.append(clear, save); assembly.append(footer);
      layout.append(library, assembly); main.append(layout);
    }
    function startBuilder(definition, id = null, version, proposalId = null) { if (moduleEditing) returnFromModuleEditor(); editingProposalId = proposalId; draft = clone(definition || moduleBlank()); draft.assistant ||= { role: "科研助手", instructions: "" }; draft.workflows ||= []; draft.capabilities ||= ["records"]; draft.pages ||= []; editingId = id; editingVersion = id ? version || definition.version || snap().definitionVersion : null; builderPageId = draft.pages[0]?.id || ""; builderTab = Array.isArray(draft.modules) ? "modules" : "pages"; moduleFilter = "全部"; moduleSearch = ""; newestModule = ""; view = "builder"; render(); content.scrollTop = 0; }
    function renderProposals() { const proposals = (state.proposals || []).filter(p => (!p.status || p.status === "draft") && (view === "home" || !p.platformId || p.platformId === state.activePlatformId)); if (!proposals.length) return; const section = card("Agent 提交的平台草案", "草案尚未应用到你的平台。打开后检查页面、字段和能力，再决定是否保存。"); for (const proposal of proposals) { const row = n("div", "platform-history-row"), text = n("div"); text.append(n("strong", "", proposal.definition?.name || "平台草案"), n("small", "platform-muted", proposal.reason || "根据你的需求生成")); row.append(text, button("查看并继续搭建", () => operate(async () => { if (proposal.platformId && state.activePlatformId !== proposal.platformId) await apply(await api.platformSelect(proposal.platformId)); startBuilder(proposal.definition, proposal.platformId || null, proposal.expectedVersion, proposal.id); }), "platform-button platform-primary")); section.append(row); } main.append(section); }
    function draftDiff() { const old = editingId ? def() : null; if (!old) return "新建平台：保存后可以填写记录、导入文件，并继续搭建。"; const removedPages = old.pages.filter(p => !draft.pages.some(q => q.id === p.id)); const removedFields = old.pages.flatMap(p => (p.fields || []).filter(f => !draft.pages.find(q => q.id === p.id)?.fields?.some(g => g.id === f.id)).map(f => `${p.title} / ${f.label}`)); const changed = old.pages.flatMap(p => (p.fields || []).filter(f => { const after = draft.pages.find(q => q.id === p.id)?.fields?.find(g => g.id === f.id); return after && after.type !== f.type; }).map(f => `${p.title} / ${f.label}`)); return [`将从版本 ${editingVersion} 保存为新版本。`, removedPages.length ? `移除页面：${removedPages.map(p => p.title).join("、")}。` : "", removedFields.length ? `移除字段：${removedFields.join("、")}。旧值仍保留在记录和版本历史中。` : "", changed.length ? `类型变更：${changed.join("、")}。旧值不会自动转换，请检查后续分析。` : ""].filter(Boolean).join(" "); }
    function clearPageRefs(id) { for (const entry of [...draft.pages, ...draft.workflows]) if (entry.sourcePageId === id) for (const key of ["sourcePageId", "valueField", "groupField", "sampleField"]) delete entry[key]; }
    function clearFieldRefs(id, fieldId, valueOnly = false) { for (const entry of [...draft.pages, ...draft.workflows]) if (entry.sourcePageId === id) for (const key of valueOnly ? ["valueField"] : ["valueField", "groupField", "sampleField"]) if (entry[key] === fieldId) delete entry[key]; }
    function renderBuilder() {
      main.append(heading(editingId ? "继续搭建你的平台" : "搭建你的科研平台", "组合科研积木，保存后直接在对话中使用。", [button("放弃本次修改", () => { draft = null; navigate(editingId ? "overview" : "home"); }), button("让 Agent 继续设计", () => taskPrompt(editingId ? "revise" : "build", `请根据下面的平台预览，先与我讨论需要调整的设计，再通过 platform_propose 提交可审阅草案。当前预览：\n${JSON.stringify(draft, null, 2)}`)), button(editingId ? "保存变更并进入对话" : "保存并进入对话", reviewSave, "platform-button platform-primary")]));
      main.querySelector(".platform-heading .platform-primary").dataset.disabled = String(Array.isArray(draft.modules) && !draft.modules.length && !draft.pages.some(p => !p.moduleId));
      const tabs = n("div", "platform-builder-tabs"); for (const [id, title] of [["modules", "积木模块"], ["pages", "页面与字段"], ["capabilities", "能力与助手"], ["workflow", "工作流程"], ["preview", "使用预览"], ["json", "高级配置"]]) { const b = button(title, () => { builderTab = id; render(); }, "platform-tab"); b.setAttribute("aria-selected", String(builderTab === id)); tabs.append(b); } main.append(tabs);
      const basic = n("div", "platform-basic"); basic.append(makeInput("text", draft.name, "平台名称", v => { draft.name = v; }).wrap, makeInput("text", draft.description, "平台用途", v => { draft.description = v; }).wrap); main.append(basic);
      if (builderTab === "modules") builderModules(); else if (builderTab === "pages") builderPages(); else if (builderTab === "capabilities") builderCapabilities(); else if (builderTab === "workflow") builderWorkflows(); else if (builderTab === "preview") builderPreview(); else builderJson();
      main.append(n("p", "platform-muted platform-edit-note", draftDiff()));
    }
    function builderPages() {
      const layout = n("div", "platform-editor-layout"), list = n("div", "platform-editor-list"), edit = n("section", "platform-card platform-page-editor");
      for (let index = 0; index < draft.pages.length; index++) { const p = draft.pages[index], item = n("div", "platform-editor-page-row"), b = button(p.title || "未命名页面", () => { builderPageId = p.id; render(); }, "platform-page-select"); b.setAttribute("aria-pressed", String(p.id === builderPageId)); item.append(b, button("↑", () => { if (index > 0) { [draft.pages[index - 1], draft.pages[index]] = [draft.pages[index], draft.pages[index - 1]]; render(); } }, "platform-mini"), button("↓", () => { if (index < draft.pages.length - 1) { [draft.pages[index + 1], draft.pages[index]] = [draft.pages[index], draft.pages[index + 1]]; render(); } }, "platform-mini")); item.querySelectorAll(".platform-mini")[0].dataset.disabled = String(index === 0); item.querySelectorAll(".platform-mini")[1].dataset.disabled = String(index === draft.pages.length - 1); list.append(item); }
      list.append(button("＋ 添加页面", () => { const p = { id: uid("page"), title: "新页面", kind: "records", fields: [] }; draft.pages.push(p); builderPageId = p.id; render(); }));
      const p = draft.pages.find(x => x.id === builderPageId) || draft.pages[0]; if (!p) edit.append(empty("添加第一个页面，定义你的研究记录。")); else { builderPageId = p.id; const h = n("div", "platform-section-row"); h.append(n("h3", "", "页面设置"), button("移除页面", () => { clearPageRefs(p.id); draft.pages = draft.pages.filter(x => x.id !== p.id); if (draft.modules) draft.modules = draft.modules.filter(id => draft.pages.some(page => page.moduleId === id)); builderPageId = draft.pages[0]?.id || ""; announce("页面已从预览中移除。保存前会展示变更，历史数据保留。"); render(); }, "platform-button platform-danger")); edit.append(h);
        const pg = n("div", "platform-basic"); pg.append(makeInput("text", p.title, "页面名称", v => { p.title = v; }).wrap, makeInput("select", p.kind, "页面类型", v => { p.kind = v; if (v !== "records") clearPageRefs(p.id); if (v === "analysis") p.fields = []; else p.fields ||= []; if (v === "notes" && !p.fields.length) p.fields = [{ id: uid("field"), label: "标题", type: "text", required: true }, { id: uid("field"), label: "笔记内容", type: "longtext" }]; render(); }, Object.entries(KINDS)).wrap); edit.append(pg);
        if (p.kind === "analysis") { const candidates = draft.pages.filter(x => x.kind === "records"), source = draft.pages.find(x => x.id === p.sourcePageId); edit.append(makeInput("select", p.sourcePageId, "来源页面", v => { p.sourcePageId = v; p.valueField = ""; p.groupField = ""; p.sampleField = ""; render(); }, [["", "请选择记录来源"], ...candidates.map(x => [x.id, x.title])]).wrap); if (source) { for (const [key, label, onlyNumber] of [["valueField", "默认分析数值", true], ["groupField", "默认分组字段", false], ["sampleField", "样本编号字段", false]]) edit.append(makeInput("select", p[key], label, v => { p[key] = v; }, [["", key === "valueField" ? "请选择" : "不指定"], ...source.fields.filter(f => !onlyNumber || f.type === "number").map(f => [f.id, f.label])]).wrap); } edit.append(n("p", "platform-muted", "分析按钮读取来源页面的真实记录。统计能力需在“能力与助手”中启用。")); }
        else { edit.append(n("h4", "platform-section-title", "记录字段")); const fields = n("div", "platform-fields-editor"); for (const f of p.fields) { const row = n("div", "platform-field-editor"); row.append(makeInput("text", f.label, "字段名称", v => { f.label = v; }).wrap, makeInput("select", f.type, "数据类型", v => { f.type = v; if (v !== "number") clearFieldRefs(p.id, f.id, true); render(); }, Object.entries(TYPES)).wrap, makeInput("text", f.unit, "单位（可选）", v => { f.unit = v; }).wrap); const required = n("label", "platform-check"), checkbox = n("input"); checkbox.type = "checkbox"; checkbox.checked = !!f.required; checkbox.addEventListener("change", () => { f.required = checkbox.checked; }); required.append(checkbox, n("span", "", "必填")); row.append(required, button("移除", () => { clearFieldRefs(p.id, f.id); p.fields = p.fields.filter(x => x.id !== f.id); announce("字段已从预览中移除。历史记录中的旧值会保留。"); render(); }, "platform-mini platform-danger")); if (f.type === "select") { const opt = makeInput("text", (f.options || []).join("，"), "选项（逗号分隔）", v => { f.options = v.split(/[,，]/).map(x => x.trim()).filter(Boolean); }); opt.wrap.classList.add("platform-field-options"); row.append(opt.wrap); } fields.append(row); } edit.append(fields, button("＋ 添加字段", () => { p.fields.push({ id: uid("field"), label: "新字段", type: "text" }); render(); })); }
      }
      layout.append(list, edit); main.append(layout);
    }
    function capabilityGrid() {
      const grid = n("div", "platform-capability-grid"); for (const [id, [title, description]] of Object.entries(CAPABILITIES)) { const label = n("label", "platform-capability"), checkbox = n("input"); checkbox.type = "checkbox"; checkbox.checked = draft.capabilities.includes(id); checkbox.addEventListener("change", () => { draft.capabilities = checkbox.checked ? [...new Set([...draft.capabilities, id])] : draft.capabilities.filter(x => x !== id); }); const text = n("span"); text.append(n("strong", "", title), n("small", "", description)); label.append(checkbox, text); grid.append(label); } return grid;
    }
    function builderCapabilities() {
      main.append(capabilityGrid());
      const assistant = card("研究助手", "这里设置的是这个平台的助手职责。需要模型的任务交给当前已配置的 Agent 执行，点击助手按钮后会先填入聊天框。"); assistant.append(makeInput("text", draft.assistant.role, "助手名称或职责", v => { draft.assistant.role = v; }).wrap, makeInput("longtext", draft.assistant.instructions, "工作要求", v => { draft.assistant.instructions = v; }).wrap);
      const models = state.modelConnections || []; assistant.append(makeInput("select", draft.assistant.modelConnectionId, "助手模型", v => { if (v.trim()) draft.assistant.modelConnectionId = v.trim(); else delete draft.assistant.modelConnectionId; }, [["", "使用当前模型"], ...models.map(m => [m.id, m.name || m.modelId || m.id])]).wrap); main.append(assistant);
    }
    function builderWorkflows() {
      const c = card("连接你的工作步骤", "流程保存你希望执行的顺序。导入与分析会使用真实文件和记录；报告步骤将已有结果交给助手解释。");
      for (const w of draft.workflows) { const row = n("div", "platform-workflow-editor"); row.append(makeInput("text", w.title, "流程名称", v => { w.title = v; }).wrap, makeInput("text", w.steps.join(" → "), "步骤：import → analyze → report", v => { w.steps = v.split(/\s*(?:→|,|，|>|\n)\s*/).filter(Boolean); }).wrap, button("移除", () => { draft.workflows = draft.workflows.filter(x => x.id !== w.id); render(); }, "platform-mini")); const settings = n("div", "platform-workflow-settings"), source = draft.pages.find(p => p.id === w.sourcePageId); settings.append(makeInput("select", w.sourcePageId || "", "数据来源", v => { if (v) w.sourcePageId = v; else delete w.sourcePageId; delete w.valueField; delete w.groupField; delete w.sampleField; render(); }, [["", "使用分析页面的配置"], ...draft.pages.filter(p => p.kind === "records").map(p => [p.id, p.title])]).wrap); if (source) for (const [key, label, numeric] of [["valueField", "数值字段", true], ["groupField", "分组字段", false], ["sampleField", "样本编号字段", false]]) settings.append(makeInput("select", w[key] || "", label, v => { if (v) w[key] = v; else delete w[key]; }, [["", "使用默认配置"], ...source.fields.filter(f => !numeric || f.type === "number").map(f => [f.id, f.label])]).wrap); row.append(settings); c.append(row); }
      c.append(button("＋ 添加流程", () => { draft.workflows.push({ id: uid("flow"), title: "我的数据分析流程", steps: ["import", "analyze", "report"] }); render(); }), n("p", "platform-muted", "目前可用步骤：import（选择文件导入）、analyze（运行统计）、report（准备助手解读）。每一步都可单独运行和查看结果。")); main.append(c);
    }
    function builderPreview() { const c = card("使用预览", "这是当前配置生成的页面。预览不会保存实验记录；保存平台后这些表单和动作即可使用。"); const tabs = n("div", "platform-builder-tabs"); let p = draft.pages.find(x => x.id === builderPageId) || draft.pages[0]; for (const item of draft.pages) { const b = button(item.title, () => { builderPageId = item.id; render(); }, "platform-tab"); b.setAttribute("aria-selected", String(p?.id === item.id)); tabs.append(b); } c.append(tabs); if (!p) c.append(empty("还没有页面，请先添加。")); else { c.append(n("h3", "", p.title)); if (p.kind === "analysis") c.append(n("p", "platform-muted", `读取“${draft.pages.find(x => x.id === p.sourcePageId)?.title || "待选择的来源页面"}”中的记录，运行统计并绘图。`), tag("等待真实数据")); else { const form = n("div", "platform-record-form"); for (const f of p.fields) { const input = fieldControl(f, ""); input.input.disabled = true; input.input.dataset.disabled = "true"; form.append(input.wrap); } c.append(form, n("p", "platform-muted", `${p.fields.length} 个自定义字段 · 保存后可新增记录${draft.capabilities.includes("files") ? "和导入数据文件" : ""}`)); } } main.append(c); }
    function builderJson() { const c = card("高级配置", "直接编辑平台结构。字段 id 用于关联已有数据，修改名称时保留 id；有错误时不会保存。"); const text = n("textarea", "platform-input platform-json"); text.value = JSON.stringify(draft, null, 2); text.setAttribute("aria-label", "平台 JSON 配置"); c.append(text, button("应用配置到预览", () => { try { const next = JSON.parse(text.value); if (!next || !Array.isArray(next.pages) || !Array.isArray(next.capabilities) || !next.assistant || !Array.isArray(next.workflows)) throw new Error("配置需要 pages、capabilities、assistant 和 workflows。"); draft = next; render(); announce("高级配置已应用。保存时还会校验字段与关联。", "success"); } catch (error) { announce(error.message, "error"); } })); main.append(c); }
    function reviewSave() {
      if (!draft || Array.isArray(draft.modules) && !draft.modules.length && !draft.pages.some(p => !p.moduleId)) { announce("请先选择至少一个科研模块。", "error"); return; }
      showDialog(editingId ? "确认平台变更" : "保存你的科研平台", fields => {
        fields.append(n("strong", "", draft.name || "未命名平台"), n("p", "platform-muted", draftDiff()), n("p", "platform-muted", `${selectedModules(draft).length} 块积木 · ${draft.pages.length} 个页面 · ${draft.workflows.length} 个流程`));
        if (draft.modules?.length) fields.append(n("p", "platform-muted", draft.modules.map(moduleTitle).join(" → ")));
        const list = n("ul", "platform-review-list"); for (const p of draft.pages) list.append(n("li", "", `${p.title}：${KINDS[p.kind] || p.kind}，${p.fields?.length || 0} 个字段`));
        fields.append(list, n("p", "platform-muted", "保存后进入对话，发送任务即可使用这些积木。研究记录、分析结果与运行过程会保存在当前平台。")); return clone(draft);
      }, "保存并进入对话", async definition => {
        const result = editingId ? await api.platformRevise({ id: editingId, definition, expectedVersion: editingVersion, ...(editingProposalId ? { proposalId: editingProposalId } : {}) }) : await api.platformCreate(editingProposalId ? { definition, proposalId: editingProposalId } : definition);
        draft = null; assemblyDraft = moduleBlank(); moduleCaches.clear(); view = "overview";
        await apply(result); dismissDialog(); busy = false; close(); onReady(snap());
      });
    }
    function renderOverview() {
      const d = def(); main.append(heading(d.name, d.description || "你的平台已经就绪。从记录、数据或研究笔记开始。", [button("继续搭建", () => startBuilder(d, state.activePlatformId), "platform-button platform-primary"), button("导出课题资料", () => exportData()), button("另存为模板", () => exportData(true))]));
      if (d.modules?.length) { const section = card("我的模块组合", `${d.modules.length} 块科研积木 · 继续搭建可调整组合`), modules = n("div", "platform-module-summary"); for (const id of d.modules) { const spec = moduleCatalog().find(m => m.id === id), page = d.pages.find(p => p.moduleId === id); if (!spec) continue; const tile = button("", () => { if (page) navigate("page", page.id); }, "platform-module-summary-card"); tile.style.setProperty("--module-color", spec.color); tile.append(cubeIcon(spec.color), n("strong", "", spec.title)); modules.append(tile); } section.append(modules); main.append(section); }
      const stats = n("div", "platform-stats"); for (const [label, count] of [["自定义页面", d.pages.length], ["研究记录", (snap().records || []).length], ["运行过程", (snap().runs || []).length], ["原始文件", (snap().assets || []).length]]) { const box = n("div", "platform-stat"); box.append(n("span", "", label), n("strong", "", count)); stats.append(box); } main.append(stats);
      const pages = n("div", "platform-platform-grid"); for (const p of d.pages) { const c = card(p.title, p.kind === "analysis" ? `从 ${d.pages.find(x => x.id === p.sourcePageId)?.title || "待配置来源"} 读取数据。` : `${p.fields.length} 个字段 · ${rows(p.id).length} 条记录`); c.append(tag(KINDS[p.kind]), button("打开页面 →", () => navigate("page", p.id))); pages.append(c); } main.append(pages);
      const cap = card("平台能力", "这些能力由你选择；继续搭建可以调整配置。"); const tags = n("div", "platform-tags"); for (const id of d.capabilities) tags.append(tag(CAPABILITIES[id]?.[0] || id)); cap.append(tags); const tasks = n("div", "platform-actions"); if (enabled("literature")) tasks.append(button("准备文献检索任务", () => taskPrompt("literature"))); if (enabled("chemistry")) tasks.append(button("准备化学研究任务", () => taskPrompt("interpret", "围绕本平台的课题准备化学研究任务。先检查当前 Agent 已配置的工具和用户资料；未接入专业计算工具时说明缺少哪些能力，提供待验证的研究思路，不假称完成结构计算或实验。"))); if (enabled("simulation")) tasks.append(button("准备仿真研究任务", () => taskPrompt("interpret", "围绕本平台的课题讨论仿真模型、参数、输入和验证方法。先检查当前 Agent 已配置的工具；没有仿真软件和必要数据时给出接入需求与待验证设计，不编造已运行的仿真结果。"))); if (tasks.children.length) cap.append(tasks, n("p", "platform-muted", "助手任务会先填入聊天框，由你发送。专业工具和资料需自行接入，指导建议会与已执行的计算结果区分。")); main.append(cap);
      renderProposals();
      if (d.workflows.length) { const flow = card("我的工作流程", "按你配置的顺序导入、分析和生成摘要。每次执行保存输入、参数与结果。"); for (const w of d.workflows) { const row = n("div", "platform-flow"), title = n("div", "platform-section-row"); title.append(n("strong", "", w.title), button("运行流程", () => operate(async () => { view = "history"; try { const result = await api.platformRunWorkflow({ workflowId: w.id }); if (!result?.canceled) { await apply(result); announce("流程执行已记录，请查看运行输入和报告。", "success"); } } catch (error) { await apply(await api.platformState()); throw error; } }), "platform-button platform-primary")); row.append(title, n("p", "platform-muted", workflowDescription(w))); const steps = n("div", "platform-actions"); for (const [i, step] of w.steps.entries()) steps.append(button(`${i + 1}. ${{ import: "导入文件", analyze: "运行分析", report: "准备结果解读" }[step] || step}`, () => runStep(step, w))); row.append(steps); flow.append(row); } main.append(flow); }
    }
    async function exportData(template = false) { return operate(async () => { const result = template ? await api.platformTemplateExport() : await api.platformExport(); if (!result?.canceled) announce(`${template ? "平台模板" : "课题资料"}已导出${result.path ? `：${result.path}` : ""}`, "success"); }); }
    function workflowBinding(workflow = {}) {
      const d = def(), firstAnalysis = d.pages.find(p => p.kind === "analysis");
      const sourceId = workflow.sourcePageId || firstAnalysis?.sourcePageId || d.pages.find(p => p.kind === "records")?.id;
      const source = d.pages.find(p => p.id === sourceId && p.kind === "records");
      const analysisPage = d.pages.find(p => p.kind === "analysis" && p.sourcePageId === source?.id);
      const config = { pageId: source?.id, valueField: workflow.valueField || analysisPage?.valueField || source?.fields.find(f => f.type === "number")?.id,
        ...(workflow.groupField || analysisPage?.groupField ? { groupField: workflow.groupField || analysisPage.groupField } : {}),
        ...(workflow.sampleField || analysisPage?.sampleField ? { sampleField: workflow.sampleField || analysisPage.sampleField } : {}) };
      return { source, analysisPage, config };
    }
    function workflowDescription(workflow) {
      const { source, config } = workflowBinding(workflow);
      if (!source) return "数据来源：待配置。请继续搭建并选择记录页面。";
      const field = id => source.fields.find(f => f.id === id)?.label;
      return `数据来源：${source.title} · 数值：${field(config.valueField) || "没有数值字段"} · 分组：${field(config.groupField) || "全部记录"} · 样本：${field(config.sampleField) || "每条记录为一个统计单位"}`;
    }
    function runStep(step, workflow = {}) {
      const { source, analysisPage, config } = workflowBinding(workflow);
      if (!source) { announce("这个流程缺少有效的记录来源，请继续搭建并配置数据来源。", "error"); return; }
      if (step === "import") {
        if (!enabled("files")) { announce("请先启用文件导入能力。", "error"); return; }
        navigate("page", source.id); return importPage(source);
      }
      if (step === "analyze") {
        if (!enabled("statistics")) { announce("请先启用统计能力。", "error"); return; }
        if (!source.fields.some(f => f.id === config.valueField && f.type === "number")) { announce("这个流程没有有效的数值字段。请配置流程字段，或设置同一来源分析页面的默认字段。", "error"); return; }
        return operate(async () => {
          const result = await api.platformAnalyze(config), target = analysisPage || source;
          analysisChoices.set(`${state.activePlatformId}:${target.id}`, { valueField: config.valueField, groupField: config.groupField || "", sampleField: config.sampleField || "" });
          view = "page"; pageId = target.id; await apply(result);
          announce(`“${workflow.title || "当前流程"}”分析已完成，来源：${source.title}。`, "success");
        });
      }
      if (step === "report") {
        const run = [...(snap().runs || [])].reverse().find(r => r.kind === "descriptive-statistics" && r.config?.pageId === source.id
          && (!config.valueField || r.config.valueField === config.valueField)
          && (r.config.groupField || "") === (config.groupField || "") && (r.config.sampleField || "") === (config.sampleField || ""));
        if (!run) { announce("这个流程的来源与参数还没有对应分析记录。请先运行分析，或运行完整流程生成报告。", "error"); return; }
        return taskPrompt("interpret", `仅解读流程“${workflow.title || "当前流程"}”绑定的来源页面“${source.title}”（${source.id}）及其分析记录 ${run.id}。参数：${JSON.stringify(config)}。请读取该记录的原始输入、计算结果与限制，不引用其他页面的分析作为本流程结果。`);
      }
      announce("当前流程步骤尚未支持，请继续搭建修改。", "error");
    }
    function fieldControl(f, value) { const label = `${f.label}${f.unit ? ` (${f.unit})` : ""}${f.required ? " *" : ""}`, options = f.type === "select" ? [["", "请选择"], ...(f.options || []).map(v => [v, v])] : null; const control = makeInput(f.type, value, label, null, options); control.input.required = !!f.required; control.input.name = f.id; return control; }
    function addRecord(p, record) { showDialog(record ? `编辑 ${p.title}` : `新增 ${p.title}`, fields => { const controls = new Map(); for (const f of p.fields) { const c = fieldControl(f, record?.values?.[f.id]); controls.set(f.id, c.input); fields.append(c.wrap); } const source = makeInput("select", record?.source || "user", "数据来源", null, [["user", "用户录入"], ["imported", "文件导入"], ["example", "教学示例"]]); fields.append(source.wrap); return { controls, source: source.input }; }, "保存记录", async ({ controls, source }) => { const values = record ? clone(record.values) : {}; for (const f of p.fields) { const value = controls.get(f.id).value; values[f.id] = f.type === "number" ? value.trim() === "" ? null : Number(value) : value; } await apply(await api.platformRecord({ pageId: p.id, ...(record ? { id: record.id } : {}), values, source: source.value })); announce("记录已保存。", "success"); }); }
    async function importPage(p) { return operate(async () => { const result = await api.platformImport({ pageId: p.id }); if (!result?.canceled) { await apply(result); announce(result.importMessage || "文件已归档并导入。请检查字段、单位和数据来源。", "success"); } }); }
    function renderPage() {
      const p = def().pages.find(x => x.id === pageId); if (!p) { view = "overview"; renderOverview(); return; }
      const a = []; if (p.kind !== "analysis") { if (enabled("records") || p.kind === "notes" && enabled("notes")) a.push(button("＋ 新增记录", () => addRecord(p), "platform-button platform-primary")); if (enabled("files")) a.push(button("导入 CSV / Excel", () => importPage(p))); }
      if (p.moduleId === "code") a.push(button("准备代码运行", () => taskPrompt("code", `请读取代码运行页面 ${p.id} 的记录，核对脚本、参数和运行环境后使用已配置工具执行。记录：${JSON.stringify(rows(p.id))}`)));
      if (p.moduleId === "search" || p.moduleId === "screening") a.push(button(p.moduleId === "search" ? "准备文献检索" : "辅助筛选文献", () => taskPrompt("literature", `围绕${p.title}页面 ${p.id} 的真实记录开展工作，保留检索条件、来源与筛选依据。记录：${JSON.stringify(rows(p.id))}`)));
      if (p.moduleId === "writing" || p.moduleId === "reports" || p.moduleId === "protocols") a.push(button({ writing: "准备综合写作", reports: "准备研究报告", protocols: "完善实验方案" }[p.moduleId], () => taskPrompt("interpret", `围绕${p.title}页面 ${p.id} 的已有资料开展工作，追溯证据，明确区分方案与实际结果。记录：${JSON.stringify(rows(p.id))}`)));
      a.push(button("改造这个页面", () => { startBuilder(def(), state.activePlatformId); builderPageId = p.id; builderTab = "pages"; render(); })); main.append(heading(p.title, moduleCatalog().find(m => m.id === p.moduleId)?.description || (p.kind === "analysis" ? "使用来源页面的记录进行分析，保留输入、参数和结果。" : "字段来自你自己的平台配置，记录保存在本机。"), a));
      if (p.kind === "analysis") { analysisControls(p); return; }
      renderRecords(p); if (p.kind === "records" && p.fields.some(f => f.type === "number") && enabled("statistics")) analysisControls(p);
      if (p.moduleId === "reports") { const analyses = (snap().runs || []).filter(r => r.kind === "descriptive-statistics"); for (const run of analyses.slice(-3)) renderAnalysis(run); for (const run of (snap().runs || []).filter(r => r.kind === "report").slice(-3)) { const report = card(run.title || "数据报告", when(run.createdAt)); report.append(n("pre", "platform-report-text", run.result?.body || run.result?.markdown || run.result?.summary || "")); main.append(report); } }
    }
    function renderRecords(p) { const data = rows(p.id); if (!data.length) { main.append(empty("这个页面还没有记录。添加第一条记录，或导入真实数据文件。")); return; }
      if (p.kind === "notes") { const grid = n("div", "platform-platform-grid"); for (const r of [...data].reverse()) { const c = card(), title = p.fields.find(f => f.type === "text") || p.fields[0]; c.append(n("h3", "", r.values[title?.id] || "未命名笔记")); for (const f of p.fields.filter(f => f.id !== title?.id)) { c.append(n("small", "platform-muted", f.label), n("p", "platform-note-body", r.values[f.id] ?? "")); } c.append(tag(sourceLabel(r.source)), n("small", "platform-muted", when(r.updatedAt)), button("编辑", () => addRecord(p, r))); grid.append(c); } main.append(grid); return; }
      const wrap = n("div", "platform-table-wrap"), table = n("table", "platform-table"), head = n("thead"), tr = n("tr"); for (const f of p.fields) tr.append(n("th", "", `${f.label}${f.unit ? ` (${f.unit})` : ""}`)); tr.append(n("th", "", "来源 / 操作")); head.append(tr); const tbody = n("tbody"); for (const r of data) { const row = n("tr"); for (const f of p.fields) row.append(n("td", f.type === "number" ? "platform-number" : "", r.values?.[f.id] ?? "—")); const action = n("td", "platform-row-actions"); action.append(tag(sourceLabel(r.source)), button("编辑", () => addRecord(p, r), "platform-mini")); row.append(action); tbody.append(row); } table.append(head, tbody); wrap.append(table); main.append(wrap, n("small", "platform-muted", `${data.length} 条记录。空值以 — 显示，分析时不会作为 0。`)); }
    function sourceLabel(source) { return { user: "用户录入", imported: "文件导入", example: "教学示例" }[typeof source === "object" ? source.kind || source.type || source.provenance : source] || (typeof source === "string" ? source : "记录"); }
    function analysisControls(p) {
      const source = p.kind === "analysis" ? def().pages.find(x => x.id === p.sourcePageId) : p, cardEl = card("分析你的数据", "按样本编号合并同一样本的读数，再按分组计算描述统计。没有指定样本编号时，每条记录分别计入。");
      if (!enabled("statistics")) { cardEl.append(empty("统计能力尚未启用。进入“继续搭建 → 能力与助手”启用后可使用。")); main.append(cardEl); return; }
      if (!source) { cardEl.append(empty("请在搭建器中为这个分析页面选择记录来源。")); main.append(cardEl); return; }
      const numeric = source.fields.filter(f => f.type === "number"); if (!numeric.length) { cardEl.append(empty("来源页面没有数值字段，请先添加数值字段。")); main.append(cardEl); return; }
      const choiceKey = `${state.activePlatformId}:${p.id}`, choice = analysisChoices.get(choiceKey) || {}, selectedValue = numeric.some(f => f.id === choice.valueField) ? choice.valueField : p.valueField || numeric[0].id;
      const settings = n("div", "platform-analysis-settings"), value = makeInput("select", selectedValue, "数值字段", null, numeric.map(f => [f.id, `${f.label}${f.unit ? ` (${f.unit})` : ""}`])), group = makeInput("select", Object.hasOwn(choice, "groupField") && (!choice.groupField || source.fields.some(f => f.id === choice.groupField)) ? choice.groupField : p.groupField || "", "分组字段", null, [["", "全部作为一组"], ...source.fields.map(f => [f.id, f.label])]), sample = makeInput("select", Object.hasOwn(choice, "sampleField") && (!choice.sampleField || source.fields.some(f => f.id === choice.sampleField)) ? choice.sampleField : p.sampleField || "", "样本编号字段", null, [["", "每条记录为一个样本"], ...source.fields.map(f => [f.id, f.label])]); settings.append(value.wrap, group.wrap, sample.wrap); cardEl.append(n("p", "platform-muted", `来源：${source.title} · ${rows(source.id).length} 条记录`), settings, button("运行分析", () => operate(async () => { analysisChoices.set(choiceKey, { valueField: value.input.value, groupField: group.input.value, sampleField: sample.input.value }); await apply(await api.platformAnalyze({ pageId: source.id, valueField: value.input.value, ...(group.input.value ? { groupField: group.input.value } : {}), ...(sample.input.value ? { sampleField: sample.input.value } : {}) })); announce("分析已完成，输入与结果已保存到运行历史。", "success"); }), "platform-button platform-primary")); main.append(cardEl);
      const runs = (snap().runs || []).filter(r => (r.pageId || r.config?.pageId || r.input?.pageId || r.parameters?.pageId) === source.id && (r.kind === "descriptive-statistics" || r.kind === "analysis" || r.type === "analysis" || r.result?.groups || r.result?.rows)); const latest = runs.at(-1); if (latest) renderAnalysis(latest); else main.append(empty("运行后这里会显示统计表、图和数据处理说明。"));
    }
    function renderAnalysis(run) { const result = run.result || {}, groups = result.groups || result.rows || result.statistics || run.rows || [], warnings = result.warnings || run.warnings || [], summary = result.summary || run.summary || {}, c = card("最近一次分析", `${summary.field || ""}${summary.unit ? ` (${summary.unit})` : ""} · ${when(run.createdAt)} · ${run.id || ""}`); c.append(tag("数据计算")); const changed = (run.inputs || []).some(input => { const current = (snap().records || []).find(r => r.id === input.id); return !current || current.updatedAt !== input.updatedAt || JSON.stringify(current.values) !== JSON.stringify(input.values) || current.source !== input.source; }); if (result.stale || run.stale || changed) c.append(tag("输入数据已改变，请重新运行", "platform-warning")); for (const warning of warnings) c.append(n("p", "platform-warning-message", typeof warning === "string" ? warning : JSON.stringify(warning)));
      if (Array.isArray(groups) && groups.length) { const wrap = n("div", "platform-table-wrap"), table = n("table", "platform-table"), head = n("tr"); for (const label of ["分组", "样本 n", "有效读数", "均值", "标准差", "中位数", "范围"]) head.append(n("th", "", label)); const thead = n("thead"); thead.append(head); const body = n("tbody"); for (const g of groups) { const row = n("tr"), label = g.group ?? g.label ?? g.name ?? "全部"; for (const value of [label, g.n ?? g.sampleCount ?? "—", g.readings ?? g.readingCount ?? g.count ?? "—", num(g.mean), num(g.sd ?? g.standardDeviation), num(g.median), `${num(g.min)} – ${num(g.max)}`]) row.append(n("td", "", value)); body.append(row); } table.append(thead, body); wrap.append(table); c.append(wrap); if (enabled("charts")) c.append(chart(groups, result.points || run.points || [])); }
      else c.append(n("pre", "platform-result-json", JSON.stringify(result, null, 2)));
      c.append(n("p", "platform-muted", "图表与统计仅描述这批记录。原始文件、输入记录和处理参数保存在过程与版本中。"), button("让助手解读这个结果", () => taskPrompt("interpret")), button("查看输入与运行过程", () => navigate("history"))); main.append(c);
    }
    function chart(groups, points = []) { const wrap = n("div", "platform-chart"), svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 700 245"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "分组均值与原始读数图，纵轴保留零基线"); const valid = groups.filter(g => Number.isFinite(g.mean)), raw = points.filter(p => Number.isFinite(p.value)); if (!valid.length) return empty("没有可绘制的数值。"); const min = Math.min(0, ...valid.map(g => g.mean), ...raw.map(p => p.value)), max = Math.max(0, ...valid.map(g => g.mean), ...raw.map(p => p.value)), range = max - min || 1, y = value => 185 - (value - min) / range * 150, width = 590 / valid.length;
      const shape = (tagName, attrs, text) => { const el = document.createElementNS("http://www.w3.org/2000/svg", tagName); for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value)); if (text !== undefined) el.textContent = text; svg.append(el); return el; };
      shape("line", { x1: 70, x2: 660, y1: y(0), y2: y(0), class: "platform-chart-axis" }); shape("line", { x1: 70, x2: 70, y1: 35, y2: 185, class: "platform-chart-axis" });
      for (const tick of [min, (min + max) / 2, max]) shape("text", { x: 60, y: y(tick) + 4, "text-anchor": "end", class: "platform-chart-label" }, num(tick));
      valid.forEach((g, i) => { const x = 70 + i * width + width * .19, barWidth = width * .62, label = String(g.group ?? g.label ?? g.name ?? "全部"); shape("rect", { x, y: Math.min(y(g.mean), y(0)), width: barWidth, height: Math.max(1, Math.abs(y(g.mean) - y(0))), rx: 3, class: "platform-chart-bar" }); raw.filter(p => String(p.group) === label).forEach((point, j) => { const circle = shape("circle", { cx: x + barWidth / 2 + ((j % 7) - 3) * Math.min(7, barWidth / 9), cy: y(point.value), r: 3, class: point.source === "example" ? "platform-chart-point platform-chart-example" : "platform-chart-point" }); const title = document.createElementNS("http://www.w3.org/2000/svg", "title"); title.textContent = `${point.sampleId || point.recordId || "读数"} · ${num(point.value)} · ${sourceLabel(point.source)}`; circle.append(title); }); shape("text", { x: x + barWidth / 2, y: 210, "text-anchor": "middle", class: "platform-chart-label" }, label.slice(0, 15)); shape("text", { x: x + barWidth / 2, y: g.mean >= 0 ? y(g.mean) - 7 : y(g.mean) + 16, "text-anchor": "middle", class: "platform-chart-value" }, num(g.mean)); }); wrap.append(n("p", "platform-muted", "柱：样本均值的分组平均 · 点：原始数值读数 · 橙色点：教学示例"), svg); return wrap;
    }
    function renderHistory() { const d = def(); main.append(heading("过程与版本", "回看输入、处理参数和结果。平台结构的每次保存都保留版本。", [button("导出全部资料", () => exportData())]));
      const history = snap().history || snap().versions || [], versions = card("平台版本", `当前版本 ${snap().definitionVersion || d.version || 1}。恢复结构会创建新版本，保留记录与运行历史。`); if (history.length) for (const item of [...history].reverse()) { const v = item.version || item.definition?.version, row = n("div", "platform-history-row"); row.append(n("strong", "", `版本 ${v}`), n("span", "platform-muted", when(item.createdAt || item.savedAt)), button("恢复此结构", () => showDialog(`恢复版本 ${v}`, fields => { fields.append(n("p", "platform-muted", "恢复页面、字段和能力设置，并保存为新版本。现有研究记录和文件仍会保留。")); }, "恢复并保存", async () => { await apply(await api.platformRestore({ version: v })); announce("平台结构已恢复并保存为新版本。", "success"); }))); versions.append(row); } else versions.append(empty("继续搭建并保存后，可以在这里查看历史版本。")); main.append(versions);
      const runs = card("运行记录", "每次统计保留输入和参数；原始记录修改后，历史运行仍可追溯。"), runItems = snap().runs || []; if (!runItems.length) runs.append(empty("暂时没有运行记录。导入数据或运行分析后会显示。")); for (const run of [...runItems].reverse()) { const details = n("details", "platform-run"), summary = n("summary"); summary.append(n("strong", "", run.title || ({ "descriptive-statistics": "描述统计", workflow: "工作流程", report: "数据报告", "data-report": "数据报告", import: "数据导入" })[run.kind] || run.kind || run.type || "数据处理"), tag(run.status || "completed"), n("small", "platform-muted", when(run.createdAt))); details.append(summary); const reportText = run.result?.body || run.result?.markdown; if (reportText) details.append(n("pre", "platform-report-text", reportText)); details.append(n("pre", "platform-result-json", JSON.stringify({ id: run.id, definitionVersion: run.definitionVersion, config: run.config, input: run.input, parameters: run.parameters, inputs: run.inputs, inputHashes: run.inputHashes, sourceRunIds: run.sourceRunIds, assetIds: run.assetIds, result: run.result, warnings: run.warnings }, null, 2))); runs.append(details); } main.append(runs);
      const assets = card("归档文件", "导入文件保留副本，导出课题资料时一并包含。"), files = snap().assets || []; if (!files.length) assets.append(empty("还没有导入文件。")); for (const file of files) { const row = n("div", "platform-history-row"), text = n("div"); text.append(n("strong", "", file.name || file.originalName || file.filename || file.id), n("small", "platform-muted", `${file.sha256 ? `SHA256 ${file.sha256.slice(0, 18)}…` : ""} ${when(file.createdAt)}`)); row.append(text); if (api.platformOpenAsset) row.append(button("查看原文件", () => operate(() => api.platformOpenAsset(file.id)))); assets.append(row); } main.append(assets);
    }
    panel.addEventListener("pointerdown", event => { if (!modeHost.contains(event.target)) { modeOpen = false; modeMenu.hidden = true; modeButton.setAttribute("aria-expanded", "false"); } });
    panel.addEventListener("keydown", event => { if (event.key === "Escape" && !dialog) { event.preventDefault(); event.stopPropagation(); if (modeOpen) { modeOpen = false; modeMenu.hidden = true; modeButton.setAttribute("aria-expanded", "false"); modeButton.focus(); } else close(); } if (event.key === "Tab" && !dialog && !modeOpen) { const all = [...panel.querySelectorAll("button:not(:disabled),select:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex='0']")].filter(el => !el.closest("[hidden]")); const first = all[0], last = all.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } } });
    modeMenu.addEventListener("keydown", event => { const options = [...modeMenu.querySelectorAll("button")], i = options.indexOf(document.activeElement); if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); options[(i + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus(); } });
    return { open, close, isOpen: () => visible, refresh, openBuilder: definition => { startBuilder(definition || blank()); return visible ? Promise.resolve() : open(); } };
  };
})();
