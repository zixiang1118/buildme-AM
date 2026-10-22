const api = window.personalAgent;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const PROVIDERS = {
  deepseek: { baseUrl: "https://api.deepseek.com", model: "deepseek-chat", name: "DeepSeek" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-5", name: "OpenAI" },
  anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5", name: "Anthropic" },
  google: { baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-2.5-pro", name: "Google Gemini" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-5", name: "OpenRouter" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b", name: "Groq" },
  mistral: { baseUrl: "https://api.mistral.ai/v1", model: "mistral-large-latest", name: "Mistral AI" },
  xai: { baseUrl: "https://api.x.ai/v1", model: "grok-4", name: "xAI" },
  dashscope: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3-coder-plus", name: "通义千问" },
  ark: { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seed-1-6", name: "火山方舟" },
  moonshot: { baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2", name: "月之暗面" },
  zhipu: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.5", name: "智谱 GLM" },
  minimax: { baseUrl: "https://api.minimax.chat/v1", model: "MiniMax-M2", name: "MiniMax" },
  siliconflow: { baseUrl: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3.1", name: "硅基流动" },
  ollama: { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3", name: "Ollama" },
  lmstudio: { baseUrl: "http://127.0.0.1:1234/v1", model: "local-model", name: "LM Studio" },
  "openai-compatible": { baseUrl: "", model: "", name: "中转站" },
};

const PERMISSIONS = {
  ask: "每次询问",
  "workspace-write": "工作区内自动执行",
  bypass: "完全访问（不审批）",
};

const elements = {
  apiKey: $("#api-key"),
  pasteApiKey: $("#paste-api-key"),
  baseUrl: $("#base-url"),
  chatTitle: $("#chat-title"),
  composer: $("#composer"),
  attachFiles: $("#attach-files"),
  attachmentList: $("#attachment-list"),
  attachmentPreview: $("#attachment-preview"),
  attachmentPreviewTitle: $("#attachment-preview-title"),
  attachmentPreviewNote: $("#attachment-preview-note"),
  attachmentPreviewContent: $("#attachment-preview-content"),
  connectionName: $("#connection-name"),
  connectionProfile: $("#connection-profile"),
  connectionState: $("#connection-state"),
  messages: $("#messages"),
  model: $("#model"),
  modelLabel: $("#model-label"),
  permissionChip: $("#permission-chip"),
  permissionLabel: $("#permission-label"),
  permissionMenu: $("#permission-menu"),
  pluginMarketDialog: $("#plugin-market-dialog"),
  platformEntry: $("#platform-entry"),
  platformMenu: $("#platform-menu"),
  platformMenuOptions: $("#platform-menu-options"),
  platformManage: $("#platform-manage"),
  prompt: $("#prompt"),
  provider: $("#provider"),
  send: $("#send"),
  sessionList: $("#session-list"),
  settingsDialog: $("#settings-dialog"),
  status: $("#status"),
  workspaceLabel: $("#workspace-label"),
  approvalDialog: $("#approval-dialog"),
  approvalTool: $("#approval-tool"),
  approvalArguments: $("#approval-arguments"),
  apiKeyLabel: $("#api-key-label"),
  connectionAuthCopy: $("#connection-auth-copy"),
  fullEdition: $("#full-edition"),
  editionChip: $("#edition-chip"),
};

let appState = {
  configured: false,
  connections: [],
  catalog: [],
  activeConnectionId: null,
  platformModelConnectionId: null,
  activeResearchPlatform: null,
  permissionMode: "ask",
  theme: "system",
  recordRawRequests: true,
  edition: "standard",
  experienceMode: "original",
  fullTools: [],
  workspace: null,
};
let editingConnectionId = null;
let previousProvider = "deepseek";
let selectedSession;
let activeSession;
let isRunning = false;
let pendingAttachments = [];
let attachmentsBusy = false;
let attachmentSelection = 0;
let attachmentPreviewGeneration = 0;
let attachmentPreviewFocus;
let experiences;
let cancelRequested = false;
let streamingNode;
let streamingText = "";
let streamingThought;
let streamingReasoning = "";
let responseBoundary = false, reasoningBoundary = false;
const chatScroller = window.createChatScroller(elements.messages);
const streamBatcher = window.createStreamBatcher(() => {
  if (!streamingNode) return;
  if (streamingReasoning) {
    if (!streamingThought) { streamingThought = reasoningNode("", true); streamingNode.before(streamingThought.details); }
    window.renderStreamText(streamingThought.content, streamingReasoning);
    streamingThought.summary.textContent = streamingText ? "思考过程 · 模型返回" : "正在思考 · 模型返回";
  }
  window.renderMarkdown(streamingNode, streamingText);
  chatScroller.follow();
}, { size: () => streamingText.length + streamingReasoning.length });
let currentApproval;
const approvalQueue = [];
const communityPanel = window.createCommunityPanel(api);
const xray = window.createXray(api, { onExperiment: (turn, usage) => comparisons.openReading(turn, usage) });
const explanations = window.createExplanations(api);
let sessionSelection = 0;
let researchPlatforms = [];
let platformMenuItems = [];
let platformMenuGeneration = 0;
let platformMenuLoading = false;
let platformMenuBusy = false;
window.createAchievements(api, { onTurn: (turn) => xray.openTurn(turn) });
const comparisons = window.createComparisons(api, {
  onTurn: (turn, tab) => xray.openTurn(turn, tab),
  onShow: () => { communityPanel.hide(); $("#xray-close").click(); closeSidebar(); },
  onClose: () => { $("#xray-close").click(); void xray.setSession(selectedSession, appState.edition); },
  onState: (state) => { mergeState(state); syncWorkspace(); },
});
$("#community-entry").addEventListener("click", () => comparisons.close());
const capabilities = window.createCapabilities(api, {
  onCompare: (example) => comparisons.open(example),
  onChange: mergeState,
  onExample: (text) => { comparisons.close(); elements.prompt.value = text; autoSizePrompt(); elements.prompt.focus(); },
});
const platforms = window.createPlatforms?.(api, {
  onPrompt: (text) => { comparisons.close(); communityPanel.hide(); elements.prompt.value = text; autoSizePrompt(); elements.prompt.focus(); },
  onClose: () => elements.prompt.focus(),
  onState: syncPlatformState,
  onReady: (snapshot) => {
    comparisons.close(); communityPanel.hide();
    setStatus(`${snapshot.definition.name}已就绪，直接发送科研任务即可使用。`);
    elements.prompt.focus();
  },
  onSwitchMode: async (next) => {
    if (next === "research") return true;
    if (isRunning || platformMenuBusy || elements.fullEdition.disabled || comparisons.isBusy?.() || experiences?.switching) return false;
    platforms.close();
    const switched = await experiences.selectMode(next);
    if (!switched) await platforms.open();
    return switched;
  },
});
async function openPlatforms() {
  if (isRunning || platformMenuBusy || comparisons.isBusy?.()) { setStatus("当前任务结束后即可进入科研平台。"); return; }
  if (appState.experienceMode !== "research") return;
  try {
    closePlatformMenu();
    comparisons.close(); communityPanel.hide(); closeSidebar();
    await platforms?.open();
    for (const dialog of [elements.settingsDialog, elements.pluginMarketDialog, $("#capabilities-dialog"), $("#capability-onboarding")]) if (dialog?.open) dialog.close();
  } catch (error) { setStatus(errorText(error), "error"); }
}
elements.platformEntry.addEventListener("click", () => elements.platformMenu.hidden ? void openPlatformMenu() : closePlatformMenu());
elements.platformEntry.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  void openPlatformMenu({ focusLast: event.key === "ArrowUp" });
});
elements.platformManage.addEventListener("click", () => void openPlatforms());
elements.platformMenu.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault(); event.stopPropagation?.();
    closePlatformMenu({ restoreFocus: true });
    return;
  }
  if (event.key === "Tab") { closePlatformMenu(); return; }
  const items = platformMenuItems.filter((button) => !button.disabled);
  if (!items.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const current = items.findIndex((button) => button.contains(event.target));
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
    : current < 0 ? (event.key === "ArrowUp" ? items.length - 1 : 0)
      : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
  items[next].focus();
});
experiences = window.createExperiences?.(api, {
  onState: mergeState,
  isBusy: () => isRunning || attachmentsBusy || platformMenuBusy || elements.fullEdition.disabled || Boolean(comparisons.isBusy?.()),
  onCommit: () => { closePlatformMenu(); platforms?.close(); comparisons.close(); communityPanel.hide(); $("#xray-close").click(); startNewChat(); },
  onPrompt: (text) => { elements.prompt.value = text; autoSizePrompt(); elements.prompt.focus(); },
  onAction: (action) => {
    if (action === "hide-community") communityPanel.hide();
    else if (action === "xray" && $("#xray-toggle").getAttribute("aria-expanded") !== "true") $("#xray-toggle").click();
    else if (action === "capabilities") $("#my-agent").click();
    else if (action === "platforms") void openPlatforms();
  },
});

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function setStatus(text = "", kind = "normal") {
  if (elements.status.textContent !== text) elements.status.textContent = text;
  if (elements.status.classList.contains("error") !== (kind === "error")) elements.status.classList.toggle("error", kind === "error");
}

function mergeState(result) {
  const value = result?.state || result;
  if (!value || typeof value !== "object") return;
  const patch = {};
  for (const key of ["communityUrl", "name", "configured", "connections", "activeConnectionId", "platformModelConnectionId", "activeResearchPlatform", "catalog", "workspace", "permissionMode", "theme", "edition", "experienceMode", "launchView", "fullTools", "recordRawRequests", "capabilities", "capabilityRegistry", "capabilityOnboarding", "capabilityUsage"]) {
    if (value[key] !== undefined) patch[key] = value[key];
  }
  appState = { ...appState, ...patch };
  communityPanel.sync(appState);
  capabilities.sync(appState);
  explanations.sync(appState);
  experiences?.sync(appState);
  syncPlatformSummary();
  syncConnectionSummary();
}

function syncPlatformState(state) {
  const snapshot = state?.snapshot;
  if (Array.isArray(state?.platforms)) researchPlatforms = state.platforms;
  appState.platformModelConnectionId = snapshot?.definition.assistant?.modelConnectionId ?? null;
  appState.activeResearchPlatform = snapshot
    ? { id: snapshot.definition.id, name: snapshot.definition.name, version: snapshot.definitionVersion,
      moduleTitles: (snapshot.definition.modules || []).map(id => (state.moduleCatalog || snapshot.definition.customModules || []).find(module => module.id === id)?.title || snapshot.definition.pages.find(page => page.moduleId === id)?.title || id) }
    : null;
  experiences?.sync(appState);
  syncPlatformSummary();
  syncConnectionSummary();
  if (!elements.platformMenu.hidden) renderPlatformMenu();
}

function syncPlatformSummary() {
  const button = elements.platformEntry, active = appState.activeResearchPlatform;
  button.hidden = appState.experienceMode !== "research";
  button.disabled = platformMenuBusy;
  if (button.hidden) closePlatformMenu();
  $("#platform-current-name").textContent = active ? `当前：${active.name}` : "未启用平台";
  button.classList.toggle("has-platform", Boolean(active));
  button.title = active ? `正在使用：${active.name} · 配置 v${active.version}\n点击切换、不启用平台或继续搭建` : "未启用科研平台，点击选择已有平台或搭建";
  button.setAttribute("aria-label", active ? `我的科研平台，正在使用${active.name}，点击选择或不启用平台` : "我的科研平台，未启用平台，点击选择平台或搭建");
  const context = $("#platform-chat-context");
  if (context) {
    context.hidden = button.hidden || !active;
    $("#platform-chat-name").textContent = active?.name || "";
    $("#platform-chat-modules").textContent = active?.moduleTitles?.join(" · ") || "已加载平台配置，按需使用已启用能力";
    $("#platform-chat-modules").title = $("#platform-chat-modules").textContent;
  }
  if (!button.hidden) elements.prompt.placeholder = active ? "告诉科研助手要记录、导入或分析什么…" : "描述任务或提出问题";
}

function closePlatformMenu({ restoreFocus = false } = {}) {
  platformMenuGeneration += 1;
  elements.platformMenu.hidden = true;
  elements.platformEntry.setAttribute("aria-expanded", "false");
  if (restoreFocus) elements.platformEntry.focus();
}

function renderPlatformMenu() {
  const activeId = appState.activeResearchPlatform?.id || "";
  const options = [{ id: "", name: "不启用平台", description: "使用全局模型，不附加平台配置" },
    ...researchPlatforms.map((platform) => ({ ...platform, description: platform.description || `配置 v${platform.version || platform.definitionVersion || 1}` }))];
  platformMenuItems = options.map((platform) => {
    const button = document.createElement("button"), copy = document.createElement("span"), name = document.createElement("strong"), detail = document.createElement("small"), check = document.createElement("i");
    button.type = "button";
    button.dataset.platformId = platform.id;
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", String(activeId === platform.id));
    button.disabled = platformMenuLoading || platformMenuBusy;
    name.textContent = platform.name; detail.textContent = platform.description;
    check.textContent = "✓"; check.setAttribute("aria-hidden", "true");
    copy.append(name, detail); button.append(copy, check);
    button.addEventListener("click", () => void selectResearchPlatform(platform.id || null));
    return button;
  });
  elements.platformMenuOptions.replaceChildren(...platformMenuItems);
  if (platformMenuLoading) {
    const loading = document.createElement("div"); loading.className = "header-platform-menu-loading"; loading.textContent = "正在读取平台…";
    elements.platformMenuOptions.append(loading);
  }
  elements.platformManage.disabled = platformMenuBusy;
  platformMenuItems.push(elements.platformManage);
}

async function openPlatformMenu({ focusLast = false } = {}) {
  if (isRunning || platformMenuBusy || elements.fullEdition.disabled || comparisons.isBusy?.() || experiences?.switching) {
    setStatus("当前任务结束后即可切换科研平台。"); return;
  }
  if (appState.experienceMode !== "research") return;
  closePermissionMenu(); experiences?.closeMenu();
  elements.platformMenu.hidden = false;
  elements.platformEntry.setAttribute("aria-expanded", "true");
  platformMenuLoading = true; renderPlatformMenu();
  const generation = ++platformMenuGeneration;
  try {
    const state = await api.platformState();
    if (generation !== platformMenuGeneration || elements.platformMenu.hidden) return;
    platformMenuLoading = false; syncPlatformState(state);
    const selected = platformMenuItems.find((button) => button.dataset.platformId === (appState.activeResearchPlatform?.id || ""));
    (focusLast ? platformMenuItems.at(-1) : selected || platformMenuItems[0])?.focus();
  } catch (error) {
    if (generation !== platformMenuGeneration) return;
    closePlatformMenu({ restoreFocus: true });
    setStatus(errorText(error), "error");
  }
}

async function selectResearchPlatform(id) {
  if (platformMenuLoading || platformMenuBusy || isRunning || elements.fullEdition.disabled || comparisons.isBusy?.() || experiences?.switching) return;
  platformMenuBusy = true; syncPlatformSummary(); renderPlatformMenu();
  let switched = false;
  try {
    syncPlatformState(await api.platformSelect(id));
    if (platforms?.isOpen?.()) await platforms.refresh?.();
    closePlatformMenu(); switched = true;
    setStatus(id ? `已启用${appState.activeResearchPlatform?.name || "科研平台"}` : "已停用科研平台，使用全局模型。");
  } catch (error) { setStatus(errorText(error), "error"); }
  finally {
    platformMenuBusy = false; syncPlatformSummary();
    if (switched) elements.platformEntry.focus();
    if (!elements.platformMenu.hidden) {
      renderPlatformMenu();
      platformMenuItems.find((button) => button.dataset.platformId === (id || ""))?.focus();
    }
  }
}

function activeConnection() {
  const selectedId = appState.experienceMode === "research" && appState.platformModelConnectionId
    ? appState.platformModelConnectionId : appState.activeConnectionId;
  return appState.connections.find((connection) => connection.id === selectedId) || null;
}

function appendMessage(role, text, { streaming = false, reasoning, attachments = [], scroll = true } = {}) {
  const node = document.createElement("article");
  const safeRole = ["user", "assistant", "tool"].includes(role) ? role : "assistant";
  node.className = `message ${safeRole}${streaming ? " streaming" : ""}`;
  if (safeRole === "assistant") window.renderMarkdown(node, text);
  else node.textContent = text;
  if (attachments.length) {
    const files = document.createElement("div"); files.className = "message-attachments";
    for (const attachment of attachments) files.append(attachmentCard(attachment));
    node.append(files);
  }
  if (reasoning) elements.messages.append(reasoningNode(reasoning).details);
  elements.messages.append(node);
  if (scroll) chatScroller.pin();
  return node;
}

function reasoningNode(text = "", streaming = false) {
  const details = document.createElement("details"), summary = document.createElement("summary"), content = document.createElement("div");
  details.className = "message-reasoning";
  summary.textContent = streaming ? "正在思考 · 模型返回" : "思考过程 · 模型返回";
  content.className = "reasoning-content"; content.textContent = text;
  details.append(summary, content); details.open = streaming;
  return { details, summary, content };
}

function createWelcome() {
  if (experiences) return experiences.createWelcome();
  const welcome = document.createElement("div");
  welcome.className = "welcome";
  const mark = document.createElement("img");
  mark.className = "welcome-mark";
  mark.src = "../assets/buildme-mark.png";
  mark.alt = "";
  mark.setAttribute("aria-hidden", "true");
  const title = document.createElement("h1");
  title.textContent = "接下来做什么？";
  welcome.append(mark, title);
  return welcome;
}

function resetWelcome() {
  streamBatcher.cancel(); chatScroller.reset();
  elements.messages.replaceChildren(createWelcome());
}

function displayMessages(items) {
  streamBatcher.cancel(); chatScroller.reset();
  elements.messages.replaceChildren();
  if (!items.length) return resetWelcome();
  xray.bindHistory(items.map((item) => ({ ...item, node: appendMessage(item.role, item.text, { reasoning: item.reasoning, attachments: item.attachments, scroll: false }) })));
  chatScroller.pin();
}

function readableSize(size) {
  const bytes = Number(size) || 0;
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

function imageDataUrl(value) {
  return typeof value === "string" && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/u.test(value) ? value : null;
}

function attachmentCard(attachment, removable = false) {
  const card = document.createElement("div"); card.className = "attachment-card"; card.dataset.attachmentId = attachment.id;
  const preview = document.createElement("button"); preview.type = "button"; preview.className = "attachment-open";
  preview.setAttribute("aria-label", `预览 ${attachment.name}`); preview.title = attachment.warning || `预览 ${attachment.name}`;
  if (imageDataUrl(attachment.previewDataUrl)) {
    const thumbnail = document.createElement("img"); thumbnail.src = attachment.previewDataUrl; thumbnail.alt = ""; preview.append(thumbnail);
  } else {
    const icon = document.createElement("span"); icon.className = "attachment-kind"; icon.textContent = attachment.kind === "image" ? "▧" : "▤"; icon.setAttribute("aria-hidden", "true"); preview.append(icon);
  }
  const copy = document.createElement("span"), name = document.createElement("strong"), details = document.createElement("small");
  name.textContent = attachment.name; details.textContent = `${readableSize(attachment.size)}${attachment.warning ? " · 注意读取范围" : attachment.kind === "image" ? " · 图片" : " · 文字已读取"}`;
  copy.append(name, details); preview.append(copy); preview.addEventListener("click", () => void previewAttachment(attachment.id, preview));
  card.append(preview);
  if (removable) {
    preview.disabled = isRunning || attachmentsBusy;
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "attachment-remove"; remove.textContent = "×";
    remove.setAttribute("aria-label", `移除 ${attachment.name}`); remove.title = "移除附件"; remove.disabled = isRunning || attachmentsBusy;
    remove.addEventListener("click", () => { if (isRunning || attachmentsBusy) return; pendingAttachments = pendingAttachments.filter(file => file.id !== attachment.id); renderPendingAttachments(); elements.prompt.focus(); });
    card.append(remove);
  }
  return card;
}

function renderPendingAttachments() {
  elements.attachmentList.replaceChildren(...pendingAttachments.map(file => attachmentCard(file, true)));
  elements.attachmentList.hidden = !pendingAttachments.length;
  elements.attachFiles.disabled = isRunning || attachmentsBusy;
  elements.attachFiles.setAttribute("aria-busy", String(attachmentsBusy));
}

function clearPendingAttachments() {
  attachmentSelection += 1; pendingAttachments = []; renderPendingAttachments();
}

async function chooseAttachments() {
  if (isRunning || attachmentsBusy || experiences?.switching) return;
  if (pendingAttachments.length >= 8) { setStatus("一次最多发送 8 个文件，请先移除部分附件。", "error"); return; }
  attachmentsBusy = true; renderPendingAttachments(); elements.send.disabled = true;
  const selection = ++attachmentSelection;
  setStatus("正在读取文件…");
  try {
    const result = await api.chooseAttachments();
    if (selection !== attachmentSelection) return;
    if (result?.canceled) { setStatus(""); return; }
    const files = Array.isArray(result?.attachments) ? result.attachments : [];
    const available = 8 - pendingAttachments.length;
    pendingAttachments.push(...files.slice(0, available));
    const errors = (result?.errors || []).map(error => `${error.name}：${error.message}`);
    if (files.length > available) errors.push("一次最多发送 8 个文件，其余文件未加入本次消息。");
    const warnings = files.slice(0, available).filter(file => file.warning).map(file => `${file.name}：${file.warning}`);
    setStatus([...errors, ...warnings].join("；") || (files.length ? `已添加 ${files.slice(0, available).length} 个文件，发送消息时交给 AI。` : "未添加文件。"), errors.length ? "error" : "");
  } catch (error) { if (selection === attachmentSelection) setStatus(errorText(error), "error"); }
  finally { attachmentsBusy = false; renderPendingAttachments(); elements.send.disabled = false; elements.prompt.focus(); }
}

async function previewAttachment(id, focus) {
  const generation = ++attachmentPreviewGeneration;
  attachmentPreviewFocus = focus;
  elements.attachmentPreviewTitle.textContent = "正在读取文件…";
  elements.attachmentPreviewNote.textContent = ""; elements.attachmentPreviewContent.replaceChildren();
  if (!elements.attachmentPreview.open) elements.attachmentPreview.showModal();
  try {
    const file = await api.previewAttachment(id);
    if (generation !== attachmentPreviewGeneration || !elements.attachmentPreview.open) return;
    elements.attachmentPreviewTitle.textContent = file.name;
    elements.attachmentPreviewNote.textContent = file.warning || (file.kind === "image" ? "图片将在发送时交给支持视觉的模型。" : "以下文字将在发送时提供给 AI。");
    const data = imageDataUrl(file.dataUrl);
    if (file.kind === "image" && data) { const image = document.createElement("img"); image.src = data; image.alt = file.name; elements.attachmentPreviewContent.append(image); }
    else { const text = document.createElement("pre"); text.textContent = file.text || "没有可读取的文字。"; elements.attachmentPreviewContent.append(text); }
  } catch (error) { if (generation === attachmentPreviewGeneration) elements.attachmentPreviewNote.textContent = errorText(error); }
}

function closeAttachmentPreview() {
  attachmentPreviewGeneration += 1; elements.attachmentPreview.close(); attachmentPreviewFocus?.focus();
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function sessionTitle(item) {
  if (typeof item.title === "string" && item.title.trim()) return item.title.trim();
  if (typeof item.preview === "string" && item.preview.trim()) return item.preview.trim();
  return "对话";
}

function renderEmptySessions() {
  elements.sessionList.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "empty-sessions";
  empty.textContent = "还没有会话。开始一个任务后会显示在这里。";
  elements.sessionList.append(empty);
}

async function refreshSessions() {
  try {
    const items = await api.sessions();
    elements.sessionList.replaceChildren();
    if (!items.length) {
      renderEmptySessions();
      setStatus();
      return;
    }
    for (const item of items) {
      const button = document.createElement("button");
      button.className = `session${item.id === selectedSession ? " selected" : ""}`;
      button.type = "button";
      button.dataset.id = item.id;
      button.setAttribute("aria-current", item.id === selectedSession ? "page" : "false");
      const title = document.createElement("strong");
      title.textContent = sessionTitle(item);
      const time = document.createElement("time");
      time.textContent = formatDate(item.updatedAt);
      const meta = document.createElement("small");
      const count = Number.isFinite(item.turnCount)
        ? item.turnCount > 0 ? `${item.turnCount} 轮对话` : "尚未开始"
        : "";
      meta.textContent = item.health === "healthy" || !item.health ? count : "需要检查";
      if (item.health && item.health !== "healthy") meta.className = "warning";
      button.append(title, time, meta);
      button.addEventListener("click", () => selectSession(item.id, sessionTitle(item)));
      elements.sessionList.append(button);
    }
    setStatus();
  } catch (error) {
    renderEmptySessions();
    const message = errorText(error);
    if (!message.includes("运行时服务尚未就绪") && !message.includes("desktop:sessions")) setStatus(message, "error");
  }
}

async function selectSession(sessionId, title = "会话") {
  if (isRunning) return;
  comparisons.close();
  const selection = ++sessionSelection;
  try {
    selectedSession = sessionId;
    clearPendingAttachments();
    elements.chatTitle.textContent = title;
    void xray.setSession(sessionId, appState.edition);
    const items = await api.messages(sessionId);
    if (selection !== sessionSelection) return;
    displayMessages(items);
    await refreshSessions();
    closeSidebar();
  } catch (error) {
    setStatus(errorText(error), "error");
  }
}

function startNewChat() {
  if (comparisons.isOpen()) { void comparisons.newConversation(); return; }
  if (isRunning) return;
  sessionSelection += 1;
  clearPendingAttachments();
  selectedSession = undefined;
  void xray.setSession(undefined, appState.edition);
  elements.chatTitle.textContent = "新对话";
  resetWelcome();
  void refreshSessions();
  closeSidebar();
  elements.prompt.focus();
}

function syncRunning(next) {
  experiences?.closeMenu();
  closePlatformMenu();
  isRunning = next;
  cancelRequested = false;
  elements.send.disabled = false;
  elements.send.type = next ? "button" : "submit";
  elements.send.textContent = next ? "■" : "↑";
  elements.send.dataset.running = String(next);
  elements.send.setAttribute("aria-label", next ? "取消生成" : "发送消息");
  elements.send.title = next ? "取消生成" : "发送（Enter）";
  elements.prompt.disabled = next;
  renderPendingAttachments();
  $("#new-chat").disabled = next;
  setStatus(next ? "正在回应" : "");
}

async function cancelActiveRun() {
  if (!isRunning || cancelRequested) return;
  cancelRequested = true;
  elements.send.disabled = true;
  setStatus("正在取消");
  try {
    const aborted = await api.abort(activeSession);
    if (!aborted) {
      cancelRequested = false;
      elements.send.disabled = false;
      setStatus("正在回应");
    }
  } catch (error) {
    cancelRequested = false;
    elements.send.disabled = false;
    setStatus(errorText(error), "error");
  }
}

function autoSizePrompt() {
  if (!elements.prompt.style) return;
  elements.prompt.style.height = "auto";
  elements.prompt.style.height = `${Math.min(elements.prompt.scrollHeight || 28, 200)}px`;
}

function workspaceName(workspace) {
  if (!workspace) return "选择工作空间";
  if (workspace.name) return workspace.name;
  const path = workspace.path || String(workspace);
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

function syncWorkspace() {
  elements.workspaceLabel.textContent = workspaceName(appState.workspace);
  $("#workspace-chip").title = appState.workspace?.path || "选择工作空间";
}

function syncEdition() {
  const full = appState.edition === "full";
  elements.fullEdition.classList.toggle("active", full);
  elements.fullEdition.setAttribute("aria-pressed", String(full));
  elements.fullEdition.textContent = full ? "DSH 引擎" : "Pi 引擎";
  elements.fullEdition.title = full
    ? "当前执行引擎为 DeepSeek Harness。点击切换为 Pi；工作台版本保持不变。"
    : "当前执行引擎为 Pi。点击切换为 DeepSeek Harness；工作台版本保持不变。";
  if (elements.editionChip) {
    elements.editionChip.hidden = !full;
    const count = appState.fullTools.length ? `${appState.fullTools.length} 个工具 · ` : "";
    elements.editionChip.textContent = full
      ? `DSH 引擎 · ${count}子 Agent / 工作流 / 网页搜索 / 沙箱 bash / 长期目标`
      : "";
  }
  document.body.dataset.edition = full ? "full" : "standard";
}

async function chooseWorkspace() {
  if (isRunning || platformMenuBusy) return;
  closePlatformMenu();
  try {
    const result = await api.chooseWorkspace();
    if (!result) return;
    if (typeof result === "string") appState.workspace = { path: result, name: workspaceName(result) };
    else if (result.workspace !== undefined) mergeState(result);
    else if (result.path) appState.workspace = result;
    if (appState.experienceMode === "research" && typeof api.platformState === "function") {
      syncPlatformState(await api.platformState());
    }
    syncWorkspace();
    setStatus("工作区已更新");
  } catch (error) {
    setStatus(errorText(error), "error");
  }
}

function closePermissionMenu({ restoreFocus = false } = {}) {
  elements.permissionMenu.hidden = true;
  elements.permissionChip.setAttribute("aria-expanded", "false");
  if (restoreFocus) elements.permissionChip.focus();
}

function positionPermissionMenu() {
  if (elements.permissionMenu.hidden) return;
  const anchor = elements.permissionChip.getBoundingClientRect();
  const margin = 12, gap = 8, viewWidth = window.innerWidth, viewHeight = window.innerHeight;
  const width = Math.min(290, Math.max(0, viewWidth - margin * 2));
  const menu = elements.permissionMenu;
  menu.style.width = `${width}px`;
  menu.style.maxHeight = `${Math.max(0, viewHeight - margin * 2)}px`;
  const height = menu.getBoundingClientRect().height;
  const above = Math.max(0, anchor.top - gap - margin), below = Math.max(0, viewHeight - anchor.bottom - gap - margin);
  const openAbove = height <= above || above >= below;
  const available = openAbove ? above : below;
  menu.style.maxHeight = `${available}px`;
  menu.style.left = `${Math.max(margin, Math.min(anchor.left, viewWidth - margin - width))}px`;
  menu.style.top = `${openAbove ? anchor.top - gap - Math.min(height, available) : anchor.bottom + gap}px`;
}

function openPermissionMenu({ focusLast = false } = {}) {
  closePlatformMenu();
  elements.permissionMenu.hidden = false;
  elements.permissionChip.setAttribute("aria-expanded", "true");
  positionPermissionMenu();
  const buttons = $$('[data-permission]');
  (focusLast ? buttons.at(-1) : buttons.find((button) => button.dataset.permission === appState.permissionMode))?.focus();
}

function syncPermission() {
  const mode = PERMISSIONS[appState.permissionMode] ? appState.permissionMode : "ask";
  appState.permissionMode = mode;
  elements.permissionLabel.textContent = PERMISSIONS[mode];
  for (const button of $$('[data-permission]')) button.setAttribute("aria-checked", String(button.dataset.permission === mode));
}

async function selectPermission(mode) {
  if (!PERMISSIONS[mode]) return;
  try {
    const result = await api.setPermissionMode(mode);
    mergeState(result);
    appState.permissionMode = typeof result === "string" ? result : (result?.permissionMode ?? mode);
    if (!PERMISSIONS[appState.permissionMode]) appState.permissionMode = mode;
    syncPermission();
    closePermissionMenu({ restoreFocus: true });
    setStatus(`权限模式：${PERMISSIONS[appState.permissionMode]}`);
  } catch (error) {
    setStatus(errorText(error), "error");
  }
}

function systemTheme() {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(mode) {
  const safeMode = ["system", "light", "dark"].includes(mode) ? mode : "system";
  appState.theme = safeMode;
  document.documentElement.dataset.themeMode = safeMode;
  document.documentElement.dataset.theme = safeMode === "system" ? systemTheme() : safeMode;
  for (const button of $$('[data-theme-option]')) button.setAttribute("aria-checked", String(button.dataset.themeOption === safeMode));
}

async function selectTheme(mode) {
  const previous = appState.theme;
  applyTheme(mode);
  try {
    const result = await api.setTheme(mode);
    mergeState(result);
    applyTheme(typeof result === "string" ? result : (result?.theme ?? mode));
  } catch (error) {
    applyTheme(previous);
    setStatus(errorText(error), "error");
  }
}

function connectionDisplayName(connection) {
  return connection.name || `${PROVIDERS[connection.provider]?.name || connection.provider} · ${connection.model}`;
}

function catalogProviderId(item) {
  return item?.provider || item?.id || "";
}

function renderModelSuggestions(provider) {
  const datalist = $("#model-suggestions");
  const catalogItem = appState.catalog.find((item) => catalogProviderId(item) === provider);
  if (!catalogItem?.models?.length) {
    if (appState.catalog.length) datalist.replaceChildren();
    return;
  }
  datalist.replaceChildren();
  for (const model of catalogItem.models) {
    const option = document.createElement("option");
    option.value = typeof model === "string" ? model : model.id;
    if (typeof model === "object" && model.name) option.label = model.name;
    datalist.append(option);
  }
}

function renderProviderCatalog(selectedProvider) {
  if (!appState.catalog.length) return;
  elements.provider.replaceChildren();
  for (const item of appState.catalog) {
    const id = catalogProviderId(item);
    if (!id) continue;
    const option = document.createElement("option");
    option.value = id;
    option.textContent = item.label || item.name || PROVIDERS[id]?.name || id;
    elements.provider.append(option);
  }
  if (!appState.catalog.some((item) => catalogProviderId(item) === "openai-compatible")) {
    const custom = document.createElement("option");
    custom.value = "openai-compatible";
    custom.textContent = "OpenAI 兼容 / 中转站";
    elements.provider.append(custom);
  }
  if (selectedProvider && !appState.catalog.some((item) => catalogProviderId(item) === selectedProvider)) {
    const current = document.createElement("option");
    current.value = selectedProvider;
    current.textContent = PROVIDERS[selectedProvider]?.name || selectedProvider;
    elements.provider.append(current);
  }
  elements.provider.value = selectedProvider || catalogProviderId(appState.catalog[0]) || "openai-compatible";
  renderModelSuggestions(elements.provider.value);
}

function syncCredentialHint(provider) {
  if (provider === "anthropic") {
    elements.apiKeyLabel.innerHTML = "Anthropic API Key / Claude Code Token <em>留空即保留当前密钥</em>";
    elements.apiKey.placeholder = "sk-ant-api… 或 sk-ant-oat…";
    elements.connectionAuthCopy.textContent = "Claude Code 的 sk-ant-oat… Token 可直接粘贴；Pi 会使用 Claude Code 的 Bearer / OAuth 请求格式。";
    return;
  }
  if (provider === "openai-compatible") {
    elements.apiKeyLabel.innerHTML = "中转站 API Key <em>留空即保留当前密钥</em>";
    elements.apiKey.placeholder = "输入中转站 API Key";
    elements.connectionAuthCopy.textContent = "中转站使用 OpenAI Chat Completions；Base URL 填服务商给出的完整 /v1 地址。";
    return;
  }
  elements.apiKeyLabel.innerHTML = "API Key <em>留空即保留当前密钥</em>";
  elements.apiKey.placeholder = "输入 API Key";
  elements.connectionAuthCopy.textContent = "连接信息仅保存在这台设备上，密钥不会显示在界面中。";
}

function renderConnectionProfiles() {
  elements.connectionProfile.replaceChildren();
  if (!appState.connections.length) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "新连接";
    elements.connectionProfile.append(empty);
    elements.connectionProfile.disabled = true;
  } else {
    elements.connectionProfile.disabled = false;
    for (const connection of appState.connections) {
      const option = document.createElement("option");
      option.value = connection.id;
      option.textContent = connectionDisplayName(connection);
      elements.connectionProfile.append(option);
    }
  }
  elements.connectionProfile.value = editingConnectionId || appState.activeConnectionId || "";
  $("#delete-connection").disabled = !editingConnectionId;
}

function loadConnectionForm(connection) {
  const catalogDefault = appState.catalog.find((item) => catalogProviderId(item) === "deepseek") || appState.catalog[0];
  const defaultProvider = catalogProviderId(catalogDefault) || "deepseek";
  const value = connection || {
    provider: defaultProvider,
    model: catalogDefault?.models?.[0]?.id || PROVIDERS[defaultProvider]?.model || "",
    baseUrl: catalogDefault ? "" : (PROVIDERS[defaultProvider]?.baseUrl || ""),
  };
  editingConnectionId = connection?.id || null;
  elements.connectionName.value = connection?.name || "";
  renderProviderCatalog(value.provider || defaultProvider);
  elements.provider.value = value.provider || defaultProvider;
  elements.model.value = value.model || "";
  elements.baseUrl.value = value.baseUrl || "";
  elements.apiKey.value = "";
  previousProvider = elements.provider.value;
  renderModelSuggestions(elements.provider.value);
  syncCredentialHint(elements.provider.value);
  renderConnectionProfiles();
}

function syncConnectionSummary() {
  const connection = activeConnection();
  elements.modelLabel.textContent = connection?.model || "选择模型";
  const connected = Boolean(connection?.configured ?? (appState.configured && connection));
  $(".connection-dot").classList.toggle("connected", connected);
  elements.connectionState.textContent = connected ? "已连接" : "尚未连接";
  elements.connectionState.classList.toggle("connected", connected);
}

function openSettings() {
  $("#record-raw-requests").checked = appState.recordRawRequests;
  const connection = activeConnection();
  loadConnectionForm(connection);
  syncConnectionSummary();
  elements.settingsDialog.showModal();
}

function closeSettings() {
  elements.apiKey.value = "";
  elements.settingsDialog.close();
}

function openPluginMarket() {
  elements.pluginMarketDialog.showModal();
}

function closePluginMarket() {
  elements.pluginMarketDialog.close();
}

async function openMarket(source) {
  try {
    await api.openMarket(source);
  } catch (error) {
    setStatus(errorText(error), "error");
  }
}

function onProviderChange() {
  const catalogItem = appState.catalog.find((item) => catalogProviderId(item) === elements.provider.value);
  if (catalogItem) {
    elements.baseUrl.value = "";
    elements.model.value = catalogItem.models?.[0]?.id || "";
  } else {
    const oldPreset = PROVIDERS[previousProvider];
    const nextPreset = PROVIDERS[elements.provider.value];
    const baseWasPreset = !elements.baseUrl.value || elements.baseUrl.value === oldPreset?.baseUrl;
    const modelWasPreset = !elements.model.value || elements.model.value === oldPreset?.model;
    if (nextPreset && baseWasPreset) elements.baseUrl.value = nextPreset.baseUrl;
    if (nextPreset && modelWasPreset) elements.model.value = nextPreset.model;
  }
  previousProvider = elements.provider.value;
  renderModelSuggestions(elements.provider.value);
  syncCredentialHint(elements.provider.value);
}

function openSidebar() {
  document.body.classList.add("sidebar-open");
  $("#open-sidebar").setAttribute("aria-expanded", "true");
}

function closeSidebar() {
  document.body.classList.remove("sidebar-open");
  $("#open-sidebar").setAttribute("aria-expanded", "false");
}

function approvalSummary(request) {
  const value = request.arguments ?? request.input ?? request.args ?? {};
  if (typeof value === "string") return value.slice(0, 12000);
  try { return JSON.stringify(value, null, 2).slice(0, 12000); }
  catch { return String(value).slice(0, 12000); }
}

function showNextApproval() {
  if (currentApproval || !approvalQueue.length) return;
  currentApproval = approvalQueue.shift();
  elements.approvalTool.textContent = `${currentApproval.source ? `[${currentApproval.source}] ` : ""}${currentApproval.toolName || currentApproval.name || "工具"}`;
  elements.approvalArguments.textContent = approvalSummary(currentApproval);
  elements.approvalDialog.showModal();
  $("#allow-approval").focus();
}

async function respondToApproval(approved) {
  if (!currentApproval) return;
  const request = currentApproval;
  currentApproval = undefined;
  elements.approvalDialog.close();
  try {
    await api.respondApproval(request.requestId || request.id, approved);
  } catch (error) {
    setStatus(errorText(error), "error");
  } finally {
    showNextApproval();
  }
}

elements.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = elements.prompt.value.trim();
  const text = question || (pendingAttachments.length ? "请阅读并分析所附文件。" : "");
  if (!text || isRunning || attachmentsBusy || platformMenuBusy || experiences?.switching) return;
  if (appState.capabilityOnboarding && appState.edition !== "full") { capabilities.guide(); return; }
  if (!activeConnection()) {
    openSettings();
    setStatus("请先添加并选择模型连接", "error");
    return;
  }
  const requestedSession = selectedSession;
  const files = [...pendingAttachments];
  streamBatcher.cancel(); chatScroller.reset();
  activeSession = requestedSession;
  if (!requestedSession) elements.messages.replaceChildren();
  appendMessage("user", text, { attachments: files });
  elements.prompt.value = "";
  autoSizePrompt();
  streamingNode = appendMessage("assistant", "", { streaming: true });
  streamingText = "";
  streamingReasoning = "";
  streamingThought = undefined; responseBoundary = false; reasoningBoundary = false;
  xray.beginRun(streamingNode);
  syncRunning(true);
  try {
    const result = await api.send({ sessionId: requestedSession, prompt: text, ...(files.length ? { attachmentIds: files.map(file => file.id) } : {}) });
    clearPendingAttachments();
    selectedSession = result.sessionId;
    if (!streamingText) streamingText = result.text || "已完成。";
    streamBatcher.schedule(); streamBatcher.flush();
    streamingNode.classList.remove("streaming");
    elements.chatTitle.textContent = "会话";
  } catch (error) {
    if (!cancelRequested) { elements.prompt.value = question; autoSizePrompt(); }
    streamingText += `${streamingText ? "\n\n" : ""}${cancelRequested ? "已取消。" : errorText(error)}`;
    streamBatcher.schedule(); streamBatcher.flush();
    streamingNode.classList.remove("streaming");
    if (!cancelRequested) streamingNode.classList.add("error");
  } finally {
    xray.endRun();
    if (appState.experienceMode === "research" && typeof api.platformState === "function") {
      try { syncPlatformState(await api.platformState()); } catch { /* Keep the conversation available if the platform refresh fails. */ }
    }
    await refreshSessions();
    // IPC deltas already in flight can arrive while the session list refreshes.
    // Keep the current nodes alive until their last scheduled paint is flushed.
    streamBatcher.flush(); streamBatcher.cancel();
    if (streamingThought) streamingThought.summary.textContent = cancelRequested ? "思考过程 · 已取消，保留已收到内容" : "思考过程 · 模型返回";
    streamingThought = undefined;
    activeSession = undefined;
    streamingNode = undefined;
    syncRunning(false);
    elements.prompt.focus();
  }
});

elements.prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});
elements.prompt.addEventListener("input", autoSizePrompt);
elements.attachFiles.addEventListener("click", () => void chooseAttachments());
$("#attachment-preview-close").addEventListener("click", closeAttachmentPreview);
elements.attachmentPreview.addEventListener("cancel", (event) => { event.preventDefault(); closeAttachmentPreview(); });
elements.send.addEventListener("click", (event) => {
  if (!isRunning) return;
  event.preventDefault();
  void cancelActiveRun();
});

$("#new-chat").addEventListener("click", startNewChat);
$("#refresh-sessions").addEventListener("click", () => void refreshSessions());
$("#workspace-chip").addEventListener("click", () => void chooseWorkspace());
elements.permissionChip.addEventListener("click", () => elements.permissionMenu.hidden ? openPermissionMenu() : closePermissionMenu());
elements.permissionChip.addEventListener("keydown", (event) => {
  if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
  event.preventDefault(); openPermissionMenu({ focusLast: event.key === "ArrowUp" });
});
elements.permissionMenu.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault(); event.stopPropagation?.(); closePermissionMenu({ restoreFocus: true }); return;
  }
  if (event.key === "Tab") { closePermissionMenu(); return; }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const buttons = $$('[data-permission]').filter((button) => !button.disabled);
  const current = buttons.findIndex((button) => button.contains(event.target));
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
    : current < 0 ? (event.key === "ArrowUp" ? buttons.length - 1 : 0)
      : (current + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
  buttons[next]?.focus();
});
window.addEventListener("resize", positionPermissionMenu);
$(".composer-dock > .context-bar").addEventListener("scroll", positionPermissionMenu, { passive: true });
for (const button of $$('[data-permission]')) button.addEventListener("click", () => void selectPermission(button.dataset.permission));
for (const selector of ["#settings", "#header-settings", "#model-chip"]) $(selector).addEventListener("click", openSettings);
elements.fullEdition.addEventListener("click", async () => {
  if (isRunning || platformMenuBusy || experiences?.switching) return;
  elements.fullEdition.disabled = true;
  try {
    const next = appState.edition === "full" ? "standard" : "full";
    if (next === "full") setStatus("正在启动 DSH 引擎…");
    const result = typeof api.setEdition === "function"
      ? await api.setEdition(next)
      : await api.openFullEdition();
    mergeState(result);
    syncEdition();
    startNewChat();
    setStatus(next === "full" ? "已切换到 DSH 引擎" : "已切换到 Pi 引擎");
  } catch (error) {
    setStatus(errorText(error), "error");
  } finally {
    elements.fullEdition.disabled = false;
  }
});
$("#plugin-market").addEventListener("click", openPluginMarket);
$("#close-plugin-market").addEventListener("click", closePluginMarket);
$("#open-pi-community-popular").addEventListener("click", () => void openMarket("pi-community-popular"));
$("#open-pi-community-github").addEventListener("click", () => void openMarket("pi-community-github"));
$("#open-pi-community-reddit").addEventListener("click", () => void openMarket("pi-community-reddit"));
$("#close-settings").addEventListener("click", closeSettings);
$("#cancel-settings").addEventListener("click", closeSettings);
elements.pasteApiKey.addEventListener("click", async () => {
  try {
    const value = await api.readClipboardText();
    if (typeof value !== "string" || !value) {
      setStatus("剪贴板中没有可粘贴的文本", "error");
      return;
    }
    const start = elements.apiKey.selectionStart ?? elements.apiKey.value.length;
    const end = elements.apiKey.selectionEnd ?? elements.apiKey.value.length;
    if (typeof elements.apiKey.setRangeText === "function") elements.apiKey.setRangeText(value, start, end, "end");
    else elements.apiKey.value = `${elements.apiKey.value.slice(0, start)}${value}${elements.apiKey.value.slice(end)}`;
    elements.apiKey.focus();
  } catch (error) {
    setStatus(errorText(error), "error");
  }
});
elements.provider.addEventListener("change", onProviderChange);
for (const button of $$('[data-theme-option]')) button.addEventListener("click", () => void selectTheme(button.dataset.themeOption));
$("#record-raw-requests").addEventListener("change", async (event) => {
  const checkbox = event.target;
  checkbox.disabled = true;
  try {
    appState.recordRawRequests = await api.setRecordRawRequests(checkbox.checked);
    setStatus("X 光记录设置已保存，下一回合生效。");
  } catch (error) {
    checkbox.checked = appState.recordRawRequests;
    setStatus(errorText(error), "error");
  } finally {
    checkbox.disabled = false;
  }
});

elements.connectionProfile.addEventListener("change", async () => {
  const id = elements.connectionProfile.value;
  if (!id) return;
  try {
    const result = await api.selectConnection(id);
    mergeState(result);
    appState.activeConnectionId = result?.activeConnectionId || appState.activeConnectionId || id;
    loadConnectionForm(appState.connections.find((item) => item.id === id));
    syncConnectionSummary();
  } catch (error) { setStatus(errorText(error), "error"); }
});

$("#new-connection").addEventListener("click", () => loadConnectionForm(null));
$("#delete-connection").addEventListener("click", async () => {
  if (!editingConnectionId) return;
  try {
    const id = editingConnectionId;
    const result = await api.deleteConnection(id);
    mergeState(result);
    if (!result?.connections) appState.connections = appState.connections.filter((item) => item.id !== id);
    if (appState.activeConnectionId === id) appState.activeConnectionId = appState.connections[0]?.id || null;
    loadConnectionForm(activeConnection());
    syncConnectionSummary();
    setStatus("连接已删除");
  } catch (error) { setStatus(errorText(error), "error"); }
});

elements.settingsDialog.addEventListener("click", (event) => { if (event.target === elements.settingsDialog) closeSettings(); });
elements.pluginMarketDialog.addEventListener("click", (event) => { if (event.target === elements.pluginMarketDialog) closePluginMarket(); });
$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const connection = {
    ...(editingConnectionId ? { id: editingConnectionId } : {}),
    ...(elements.connectionName.value.trim() ? { name: elements.connectionName.value.trim() } : {}),
    provider: elements.provider.value,
    model: elements.model.value.trim(),
    baseUrl: elements.baseUrl.value.trim() || undefined,
    ...(elements.apiKey.value.trim() ? { apiKey: elements.apiKey.value.trim() } : {}),
  };
  if (!connection.model) {
    elements.model.focus();
    setStatus("请输入模型 ID", "error");
    return;
  }
  try {
    const result = await api.saveConnection(connection);
    mergeState(result);
    const saved = result?.connection || (result?.id ? result : null);
    if (!result?.connections && saved?.id) {
      appState.connections = [...appState.connections.filter((item) => item.id !== saved.id), saved];
      appState.activeConnectionId = saved.id;
    }
    appState.configured = result?.configured ?? true;
    editingConnectionId = result?.activeConnectionId || saved?.id || editingConnectionId;
    loadConnectionForm(activeConnection() || saved);
    syncConnectionSummary();
    closeSettings();
    setStatus("模型连接已保存");
  } catch (error) { setStatus(errorText(error), "error"); }
});

$("#open-sidebar").addEventListener("click", openSidebar);
$("#close-sidebar").addEventListener("click", closeSidebar);
$("#sidebar-backdrop").addEventListener("click", closeSidebar);
$("#allow-approval").addEventListener("click", () => void respondToApproval(true));
$("#deny-approval").addEventListener("click", () => void respondToApproval(false));
elements.approvalDialog.addEventListener("cancel", (event) => event.preventDefault());

document.addEventListener("click", (event) => {
  if (!elements.permissionMenu.hidden && !elements.permissionMenu.contains(event.target) && !elements.permissionChip.contains(event.target)) closePermissionMenu();
  if (!elements.platformMenu.hidden && !elements.platformMenu.contains(event.target) && !elements.platformEntry.contains(event.target)) closePlatformMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!elements.platformMenu.hidden) closePlatformMenu({ restoreFocus: true });
    else if (!elements.permissionMenu.hidden) closePermissionMenu({ restoreFocus: true });
    else closeSidebar();
    return;
  }
  if (!(event.metaKey || event.ctrlKey)) return;
  if (event.key.toLowerCase() === "n") { event.preventDefault(); startNewChat(); }
  else if (event.key === ",") { event.preventDefault(); openSettings(); }
  else if (event.key.toLowerCase() === "o" && event.shiftKey) { event.preventDefault(); void chooseWorkspace(); }
  else if (event.key.toLowerCase() === "k") { event.preventDefault(); elements.prompt.focus(); }
});

const colorScheme = window.matchMedia?.("(prefers-color-scheme: dark)");
colorScheme?.addEventListener?.("change", () => { if (appState.theme === "system") applyTheme("system"); });

api.onStream((event) => {
  // Turns started by a scheduled reminder, not by the composer.
  if (event.type === "background-done" || event.type === "open-session") {
    void refreshSessions();
    if (event.type === "open-session" && !isRunning) void selectSession(event.sessionId);
    else if (!isRunning && event.sessionId === selectedSession) {
      void selectSession(event.sessionId);
      setStatus("定时任务有新的回复");
    }
    return;
  }
  if (!isRunning) return;
  if (!activeSession) {
    activeSession = event.sessionId;
    if (!selectedSession) selectedSession = event.sessionId;
  }
  if (event.sessionId !== activeSession) return;
  if (event.type === "response-start") { responseBoundary = true; reasoningBoundary = true; }
  if (event.type === "reasoning" && streamingNode) {
    streamingReasoning += `${reasoningBoundary && streamingReasoning ? "\n\n" : ""}${event.delta}`;
    reasoningBoundary = false; setStatus("正在思考"); streamBatcher.schedule();
  }
  if (event.type === "text" && streamingNode) {
    streamingText += `${responseBoundary && streamingText ? "\n\n" : ""}${event.delta}`;
    responseBoundary = false;
    streamBatcher.schedule();
  }
  if (event.type === "tool") setStatus(`正在使用 ${event.name}`);
});

if (typeof api.onApproval === "function" && typeof api.respondApproval === "function") {
  api.onApproval((request) => { approvalQueue.push(request); showNextApproval(); });
}

if (api.onApprovalClosed) api.onApprovalClosed(({ requestId }) => {
  const index = approvalQueue.findIndex((request) => request.requestId === requestId);
  if (index >= 0) approvalQueue.splice(index, 1);
  if (currentApproval?.requestId === requestId) { currentApproval = undefined; elements.approvalDialog.close(); showNextApproval(); }
});

(async () => {
  try {
    mergeState(await api.state());
    void xray.setSession(undefined, appState.edition);
    $("#agent-name").textContent = "BuildMe";
    applyTheme(appState.theme);
    syncWorkspace();
    syncEdition();
    syncPermission();
    syncConnectionSummary();
    if (appState.launchView === "platforms" && appState.experienceMode === "research") await openPlatforms();
    if ((!appState.configured || !activeConnection()) && !platforms?.isOpen()) openSettings();
    await refreshSessions();
    if (!platforms?.isOpen()) capabilities.guide();
  } catch (error) { setStatus(errorText(error), "error"); }
})();
