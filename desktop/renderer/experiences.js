(() => {
  const ICONS = {
    original: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
    learning: '<path d="m3 9 9-5 9 5-9 5-9-5Z"/><path d="M7 11.3v5.2c3 2 7 2 10 0v-5.2M21 9v7"/>',
    research: '<circle cx="10" cy="10" r="6"/><path d="m14.5 14.5 5 5M7 10h6M10 7v6"/>',
    code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>',
    document: '<path d="M14 3H6v18h12V7l-4-4Z"/><path d="M14 3v5h4M9 12h6m-6 4h6"/>',
    spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
    input: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 10h10M7 14h6"/>',
    brain: '<path d="M12 5a3 3 0 0 0-5.5-1.5A4 4 0 0 0 4 10a4 4 0 0 0 1 7 3.5 3.5 0 0 0 7 1V5Zm0 0a3 3 0 0 1 5.5-1.5A4 4 0 0 1 20 10a4 4 0 0 1-1 7 3.5 3.5 0 0 1-7 1M8 8l4 2m4 3-4 2"/>',
    tool: '<path d="m15 5 4-2a6 6 0 0 1-7 8L5 18a2 2 0 0 1-3-3l7-7a6 6 0 0 1 8-7l-2 4Z" transform="translate(1 2) scale(.9)"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    layers: '<path d="m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5"/>',
    chart: '<path d="M4 3v17h17M8 16v-5m5 5V7m5 9V4"/>',
    book: '<path d="M12 5c-3-2-6-2-10-1v15c4-1 7-1 10 1 3-2 6-2 10-1V4c-4-1-7-1-10 1Zm0 0v15"/>',
    eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  };
  const MODES = {
    original: {
      name: "原版工作台", short: "原版", eyebrow: "MAKE SOMETHING REAL", index: "01 / CREATE",
      tagline: "从一个想法，开始创造。", title: "接下来，", highlight: "创造什么？",
      description: "把想法交给 Agent，一起写代码、整理资料，让事情向前一步。",
      placeholder: "描述你想完成的任务，或提出一个问题…",
      footnote: "想法从这里开始，作品在你的工作区生长。",
      cards: [
        { icon: "code", title: "一起构建", description: "读懂项目，解决问题，实现想法。", prompt: "请先查看当前工作区，说明项目结构和启动方式，再帮我梳理值得改进的地方。修改前先给出计划。" },
        { icon: "document", title: "整理与提炼", description: "把零散资料变成清晰、有用的内容。", prompt: "请帮我整理工作区里的资料，先列出文件和主题，再提出整理方案。不要直接覆盖原文件。" },
        { icon: "spark", title: "探索一个想法", description: "从模糊的灵感，到可以动手的第一步。", prompt: "我想把一个想法做成可以使用的作品。请先询问我的目标、使用者和约束，再一起拆出最小可行方案。" },
      ],
    },
    learning: {
      name: "学习版", short: "学习版", eyebrow: "LEARN BY EXPLORING", index: "02 / UNDERSTAND",
      tagline: "每一次动手，都多懂一点。", title: "看懂 Agent 的", highlight: "每一步。",
      description: "不需要先懂技术。从一个小任务开始，认识模型、工具与上下文。",
      placeholder: "提出一个小任务，或问「Agent 是怎么工作的？」…",
      footnote: "先做一次，再看过程。理解会在实践中发生。",
      cards: [
        { icon: "learning", title: "认识我的第一个 Agent", description: "用一个生活中的例子，理解它如何行动。", prompt: "我是完全不懂 Agent 的新手。请用一个日常例子，解释模型、Agent、工具和上下文分别是什么，再带我完成一个不修改文件的小任务。每次只讲一个关键概念。" },
        { icon: "tool", title: "观察一次工具调用", description: "看见模型如何借助工具获取信息。", prompt: "请带我观察一次真实工具调用：先说明准备使用什么工具、为什么需要它，再用只读工具查看工作区信息。最后解释工具返回了什么，以及它如何帮助回答。没有可用工具时请直说。" },
        { icon: "layers", title: "理解 Token 与上下文", description: "弄清楚模型读了什么，为什么会有开销。", prompt: "请用初学者能懂的语言解释 Token、上下文和缓存的区别，再告诉我如何在 BuildMe 的 X 光与 Token 账单中观察它们。没有本回合真实用量数据时不要编造数字。" },
      ],
    },
    research: {
      name: "科研版", short: "科研版", eyebrow: "RESEARCH WITH CLARITY", index: "03 / DISCOVER",
      tagline: "研究方式，由你搭建。", title: "你的研究，", highlight: "你的工作台。",
      description: "从自己的科研任务出发，搭建页面、选择能力、连接数据与流程，再观察和调整。",
      placeholder: "描述你想搭建的平台、已有数据或需要改进的流程…",
      footnote: "搭建 → 使用 → 看见过程 → 调整与比较。",
    },
  };
  const LEARNING_STEPS = [
    { icon: "input", title: "接收任务", description: "你描述目标。Agent 会结合你的问题、已有对话和系统说明，准备交给模型的输入。" },
    { icon: "brain", title: "模型判断", description: "模型根据当前信息生成回答或工具调用。界面中的思考内容取决于模型是否提供，不能当作完整内部思维。" },
    { icon: "tool", title: "工具行动", description: "需要外部信息或实际操作时，Agent 执行工具，再把返回结果交给模型。工具使用受权限和能力设置约束。" },
    { icon: "check", title: "检查结果", description: "模型根据结果继续下一步，或给出回答。你可以在 X 光里查看真实记录，再检查任务是否完成。这个循环可能重复多次。" },
  ];
  const RESEARCH_STAGES = [
    { name: "搭建", cards: [
      { icon: "layers", title: "描述我的平台", description: "把研究需要变成可以预览的页面和能力。", prompt: "请先用platform_catalog查看已有平台，再协助我描述使用者、科研任务、已有数据和希望执行的动作。用platform_propose提出具体页面、字段、能力与流程配置，保存为待确认草案。" },
      { icon: "document", title: "从模板开始改", description: "用一个起点，搭出适合自己的研究方式。", prompt: "请用platform_catalog读取当前平台，说明页面和能力如何配合。根据我的需求修改配置，使用platform_propose保存具体草案供界面预览，不直接修改真实记录。" },
    ] },
    { name: "使用", cards: [
      { icon: "input", title: "连接我的数据", description: "在对话中导入表格，保存原始数据与来源。", prompt: "请用 platform_catalog 读取当前平台的记录字段。如果我已经提供表格附件，用其中完整原件的 sourcePath，通过 platform_execute 导入到对应记录页面；有多个页面时先确认目标。没有文件时请告诉我需要提供什么。检查单位与缺失值，保留数据来源。" },
      { icon: "tool", title: "使用我的科研积木", description: "直接发送任务，调用已搭建的分析与流程。", prompt: "请用 platform_catalog 读取当前平台，说明已经搭建的积木可以处理哪些任务。根据我的具体要求，通过 platform_execute 执行已有分析或工作流程并返回真实结果；必要输入缺失时询问我。代码、检索及专业计算使用已接入的工具。" },
    ] },
    { name: "观察", cards: [
      { icon: "eye", title: "看见过程与依据", description: "检查输入、处理步骤、输出和原始证据。", prompt: "请读取当前平台及真实运行记录，解释输入、处理步骤、参数、输出和来源之间的关系。明确未执行或缺失的部分，不编造工具调用和统计结论。" },
      { icon: "chart", title: "理解分析结果", description: "检查重复关系、缺失值与结论范围。", prompt: "请读取当前平台的真实数据和分析记录，检查样品与技术重复、单位、缺失值和异常，解释描述统计能支持什么结论。没有证据的部分标为待验证。" },
    ] },
    { name: "改造", cards: [
      { icon: "spark", title: "改进我的平台", description: "从实际使用中的困难出发，调整页面与流程。", prompt: "请读取当前平台，依据我使用中的问题提出具体改进。使用platform_propose保存包含expectedVersion的配置草案，说明变化及对已有数据的影响，让我先预览再应用。" },
      { icon: "check", title: "比较不同方案", description: "对比能力与流程选择，找出适合自己的配置。", prompt: "请读取当前平台，针对我的任务提出两种可执行配置，对比输入、步骤、输出、工具需求和限制。不要虚构执行效果；我选择后再用platform_propose保存草案。" },
    ] },
  ];

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: "24", height: "24", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(key, value);
    svg.innerHTML = ICONS[name] || ICONS.spark;
    return svg;
  }

  window.createExperiences = (api, { onState, onCommit, onPrompt, onAction, isBusy }) => {
    const trigger = document.querySelector("#experience-trigger"), menu = document.querySelector("#experience-menu");
    const options = [...menu.querySelectorAll("[data-mode]")];
    const transition = document.querySelector("#experience-transition"), toast = document.querySelector("#experience-toast");
    let mode = "original", initialized = false, switching = false, toastTimer, transitionTimer, learningStep = 0, researchStage = 0, activePlatformId = "";
    const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const busy = () => switching || isBusy();

    function announce(text) {
      clearTimeout(toastTimer);
      toast.textContent = text; toast.hidden = false;
      toastTimer = setTimeout(() => { toast.hidden = true; }, 3200);
    }
    function closeMenu(restoreFocus = false) {
      menu.hidden = true; trigger.setAttribute("aria-expanded", "false");
      if (restoreFocus) trigger.focus();
    }
    function openMenu() {
      if (!initialized || switching) return;
      const blocked = busy();
      for (const option of options) option.disabled = blocked;
      document.querySelector("#experience-menu-note").textContent = blocked ? "任务正在运行，结束后即可切换版本。" : "切换后开启新对话，历史会话仍保留。";
      menu.hidden = false; trigger.setAttribute("aria-expanded", "true");
      (blocked ? trigger : options.find(option => option.dataset.mode === mode)).focus();
    }
    function card(data) {
      const button = node("button", "experience-card"); button.type = "button";
      const mark = node("span", "experience-card-icon"); mark.append(icon(data.icon));
      const arrow = node("span", "experience-card-arrow"); arrow.append(icon("arrow"));
      button.append(mark, node("strong", "", data.title), node("p", "", data.description), arrow);
      button.addEventListener("click", () => { if (!busy()) onPrompt(data.prompt); });
      return button;
    }
    function tool(label, name, action) {
      const button = node("button", "experience-tool"); button.type = "button"; button.dataset.action = action;
      button.append(icon(name), node("span", "", label));
      button.addEventListener("click", () => onAction(action));
      return button;
    }
    function createWelcome() {
      const data = MODES[mode], home = node("section", "welcome experience-home");
      home.setAttribute("aria-label", `${data.name}首页`); home.setAttribute("aria-live", "off");
      const eyebrow = node("div", "experience-eyebrow");
      eyebrow.append(node("span", "experience-dot"), node("span", "", data.eyebrow), node("span", "experience-index", data.index));
      const hero = node("div", "experience-hero"), emblem = node("div", "experience-emblem"); emblem.append(icon(mode));
      const heading = node("h1", "", data.title); heading.append(node("strong", "", data.highlight));
      hero.append(emblem, heading, node("p", "experience-description", mode === "research" && activePlatformId ? "科研积木已就绪。在下方直接描述任务，助手会使用当前平台记录、导入和分析数据。" : data.description));
      const body = node("div", "experience-body"), cards = node("div", "experience-cards");
      if (mode === "learning") {
        const loop = node("div", "learning-loop"), explanation = node("p", "learning-explanation", LEARNING_STEPS[learningStep].description);
        explanation.id = "learning-explanation"; explanation.setAttribute("aria-live", "polite");
        LEARNING_STEPS.forEach((step, index) => {
          const button = node("button", "learning-node"); button.type = "button"; button.dataset.step = String(index);
          button.setAttribute("aria-pressed", String(index === learningStep)); button.setAttribute("aria-controls", explanation.id);
          button.append(icon(step.icon), node("span", "", step.title), node("small", "", `0${index + 1}`));
          button.addEventListener("click", () => {
            learningStep = index; explanation.textContent = step.description;
            for (const item of loop.children) item.setAttribute("aria-pressed", String(item === button));
          });
          loop.append(button);
        });
        body.append(loop, explanation);
      }
      if (mode === "research") {
        const path = node("div", "research-path"); path.setAttribute("role", "group"); path.setAttribute("aria-label", "选择研究阶段");
        RESEARCH_STAGES.forEach((stage, index) => {
          const button = node("button", "research-stage"); button.type = "button"; button.dataset.stage = String(index);
          button.setAttribute("aria-pressed", String(index === researchStage));
          button.append(node("span", "", `0${index + 1}`), node("strong", "", stage.name));
          button.addEventListener("click", () => {
            researchStage = index;
            for (const item of path.children) item.setAttribute("aria-pressed", String(item === button));
            cards.replaceChildren(...stage.cards.map(card));
          });
          path.append(button);
        });
        body.append(path); cards.append(...RESEARCH_STAGES[researchStage].cards.map(card));
      } else cards.append(...data.cards.map(card));
      body.append(cards);
      if (mode === "research") {
        const tools = node("div", "experience-tools");
        tools.append(tool("我的科研平台 · 搭建与使用", "layers", "platforms"));
        body.append(tools);
      }
      if (mode === "learning") {
        const tools = node("div", "experience-tools");
        tools.append(tool("打开 X 光，看真实过程", "eye", "xray"), tool("探索 Agent 能力", "layers", "capabilities"));
        body.append(tools);
      }
      const footer = node("footer", "experience-home-footer"); footer.append(node("span", "", data.footnote));
      home.append(eyebrow, hero, body, footer);
      return home;
    }
    function sync(state) {
      const next = MODES[state.experienceMode] ? state.experienceMode : "original";
      const nextPlatformId = state.activeResearchPlatform?.id || "", platformChanged = nextPlatformId !== activePlatformId;
      if (platformChanged) { activePlatformId = nextPlatformId; researchStage = activePlatformId ? 1 : 0; }
      const changed = next !== mode || !initialized || platformChanged; mode = next; initialized = true;
      document.body.dataset.experience = mode;
      trigger.dataset.ready = "true";
      trigger.setAttribute("aria-label", `BuildMe · ${MODES[mode].name} · 切换版本`);
      document.querySelector("#experience-current").textContent = MODES[mode].name;
      document.querySelector("#experience-tagline").textContent = MODES[mode].tagline;
      document.querySelector("#experience-header-badge").textContent = MODES[mode].short;
      document.querySelector("#prompt").placeholder = MODES[mode].placeholder;
      for (const option of options) option.setAttribute("aria-checked", String(option.dataset.mode === mode));
      if (changed) document.querySelector("#messages .welcome")?.replaceWith(createWelcome());
    }
    async function selectMode(next) {
      if (!MODES[next] || switching) return false;
      if (isBusy()) { closeMenu(true); announce("任务正在运行，结束后即可切换版本。"); return false; }
      if (next === mode) { closeMenu(true); return true; }
      switching = true; trigger.dataset.switching = "true"; closeMenu();
      // Hide native community content before the transition; it renders above HTML.
      onAction("hide-community");
      const workspace = document.querySelector(".workspace");
      workspace.inert = true;
      const emblem = transition.querySelector(".experience-transition-emblem"); emblem.replaceChildren(icon(next));
      transition.querySelector("strong").textContent = `进入${MODES[next].name}`;
      transition.dataset.target = next; transition.hidden = false; transition.classList.add("is-active");
      const started = performance.now();
      try {
        const state = await api.setExperienceMode(next);
        if (!reducedMotion()) await new Promise(resolve => setTimeout(resolve, Math.max(0, 210 - (performance.now() - started))));
        onState(state); onCommit();
        workspace.classList.remove("experience-arriving");
        if (!reducedMotion()) { void workspace.offsetWidth; workspace.classList.add("experience-arriving"); }
        announce(`已切换到${MODES[mode].name} · 新对话已准备好`);
        return true;
      } catch (error) {
        announce(`切换失败：${error.message || String(error)}`);
        return false;
      } finally {
        clearTimeout(transitionTimer);
        transitionTimer = setTimeout(() => {
          transition.hidden = true; transition.classList.remove("is-active"); switching = false;
          trigger.dataset.switching = "false"; workspace.inert = false;
          workspace.classList.remove("experience-arriving"); document.querySelector("#prompt").focus();
        }, reducedMotion() ? 0 : Math.max(0, 700 - (performance.now() - started)));
      }
    }
    for (const option of options) {
      option.querySelector(".experience-option-icon").append(icon(option.dataset.mode));
      option.addEventListener("click", () => void selectMode(option.dataset.mode));
    }
    trigger.addEventListener("click", () => menu.hidden ? openMenu() : closeMenu());
    trigger.addEventListener("keydown", event => {
      if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); openMenu(); }
    });
    menu.addEventListener("keydown", event => {
      const available = options.filter(option => !option.disabled), index = available.indexOf(document.activeElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && available.length) {
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? available.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + available.length) % available.length;
        available[next].focus();
      } else if (event.key === "Tab") closeMenu();
    });
    document.addEventListener("click", event => { if (!menu.hidden && !menu.contains(event.target) && !trigger.contains(event.target)) closeMenu(); });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !menu.hidden) { event.preventDefault(); event.stopImmediatePropagation(); closeMenu(true); }
    });
    document.addEventListener("focusin", event => { if (!menu.hidden && !menu.contains(event.target) && !trigger.contains(event.target)) closeMenu(); });
    return { sync, createWelcome, closeMenu, selectMode, get switching() { return switching; } };
  };
})();
