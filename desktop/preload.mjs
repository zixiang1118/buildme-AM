import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("personalAgent", {
  communityOpen: () => ipcRenderer.invoke('desktop:community-open'),
  communityHide: () => ipcRenderer.invoke('desktop:community-hide'),
  communityBounds: (bounds) => ipcRenderer.invoke('desktop:community-bounds', bounds),
  communityConfig: (url) => ipcRenderer.invoke('desktop:community-config', url),
  communityShare: (type, id) => ipcRenderer.invoke('desktop:community-share', type, id),
  onCommunity: (listener) => { const handler = (_event, value) => listener(value); ipcRenderer.on('desktop:community-state', handler); return () => ipcRenderer.removeListener('desktop:community-state', handler); },
  state: () => ipcRenderer.invoke("desktop:state"),
  setExperienceMode: (mode) => ipcRenderer.invoke("desktop:set-experience-mode", mode),
  platformState: () => ipcRenderer.invoke("desktop:platform-state"),
  platformPreview: (data) => ipcRenderer.invoke("desktop:platform-preview", data),
  platformCreate: (data) => ipcRenderer.invoke("desktop:platform-create", data),
  platformSelect: (id) => ipcRenderer.invoke("desktop:platform-select", id),
  platformDelete: (id) => ipcRenderer.invoke("desktop:platform-delete", id),
  platformModuleSave: (data) => ipcRenderer.invoke("desktop:platform-module-save", data),
  platformModuleGenerate: (data) => ipcRenderer.invoke("desktop:platform-module-generate", data),
  platformRevise: (data) => ipcRenderer.invoke("desktop:platform-revise", data),
  platformRecord: (data) => ipcRenderer.invoke("desktop:platform-record", data),
  platformImport: (data) => ipcRenderer.invoke("desktop:platform-import", data),
  platformAttach: (data) => ipcRenderer.invoke("desktop:platform-attach", data),
  platformAnalyze: (data) => ipcRenderer.invoke("desktop:platform-analyze", data),
  platformRunWorkflow: (data) => ipcRenderer.invoke("desktop:platform-run-workflow", data),
  platformRestore: (data) => ipcRenderer.invoke("desktop:platform-restore", data),
  platformPrompt: (data) => ipcRenderer.invoke("desktop:platform-prompt", data),
  platformExport: () => ipcRenderer.invoke("desktop:platform-export"),
  platformTemplateExport: () => ipcRenderer.invoke("desktop:platform-template-export"),
  platformTemplateImport: () => ipcRenderer.invoke("desktop:platform-template-import"),
  platformOpenAsset: (id) => ipcRenderer.invoke("desktop:platform-open-asset", id),
  setCapability: (id, enabled) => ipcRenderer.invoke("desktop:set-capability", id, enabled),
  chooseCapabilities: (choice) => ipcRenderer.invoke("desktop:choose-capabilities", choice),
  onCapabilityUsage: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("desktop:capability-usage", handler);
    return () => ipcRenderer.removeListener("desktop:capability-usage", handler);
  },
  achievements: () => ipcRenderer.invoke("desktop:achievements"),
  learningEvent: (event) => ipcRenderer.invoke("desktop:learning-event", event),
  exportLearning: () => ipcRenderer.invoke("desktop:export-learning"),
  onAchievements: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("desktop:achievements", handler);
    return () => ipcRenderer.removeListener("desktop:achievements", handler);
  },
  catalog: () => ipcRenderer.invoke("desktop:catalog"),
  sessions: () => ipcRenderer.invoke("desktop:sessions"),
  messages: (sessionId) => ipcRenderer.invoke("desktop:messages", sessionId),
  explain: (requestId, target) => ipcRenderer.invoke("desktop:explain", requestId, target),
  cancelExplanation: (requestId) => ipcRenderer.invoke("desktop:explain-cancel", requestId),
  onExplanation: (callback) => { const listener = (_event, data) => callback(data); ipcRenderer.on("desktop:explanation", listener); return () => ipcRenderer.removeListener("desktop:explanation", listener); },
  compareList: () => ipcRenderer.invoke("desktop:compare-list"),
  compareCreate: (payload) => ipcRenderer.invoke("desktop:compare-create", payload),
  compareGet: (id) => ipcRenderer.invoke("desktop:compare-get", id),
  compareSend: (id, prompt) => ipcRenderer.invoke("desktop:compare-send", id, prompt),
  compareStop: (id) => ipcRenderer.invoke("desktop:compare-stop", id),
  compareDelete: (id) => ipcRenderer.invoke("desktop:compare-delete", id),
  compareAdopt: (id, side, token) => ipcRenderer.invoke("desktop:compare-adopt", id, side, token),
  compareXrayOpened: (id) => ipcRenderer.invoke("desktop:compare-xray-opened", id),
  onCompare: (callback) => { const listener = (_event, data) => callback(data); ipcRenderer.on("desktop:compare", listener); return () => ipcRenderer.removeListener("desktop:compare", listener); },
  xrayTurns: (sessionId, engine) => ipcRenderer.invoke("desktop:xray-turns", sessionId, engine),
  xrayTurn: (turnId) => ipcRenderer.invoke("desktop:xray-turn", turnId),
  xrayLedger: (turnId) => ipcRenderer.invoke("desktop:xray-ledger", turnId),
  xrayPromptSource: (turnId, segmentIndex, open) => ipcRenderer.invoke("desktop:xray-prompt-source", turnId, segmentIndex, open),
  setRecordRawRequests: (enabled) => ipcRenderer.invoke("desktop:set-record-raw-requests", enabled),
  onXray: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("desktop:xray", handler);
    return () => ipcRenderer.removeListener("desktop:xray", handler);
  },
  send: (payload) => ipcRenderer.invoke("desktop:send", payload),
  chooseAttachments: () => ipcRenderer.invoke("desktop:attachments-choose"),
  previewAttachment: (id) => ipcRenderer.invoke("desktop:attachment-preview", id),
  abort: (sessionId) => ipcRenderer.invoke("desktop:abort", sessionId),
  saveKey: (key) => ipcRenderer.invoke("desktop:save-key", key),
  readClipboardText: () => ipcRenderer.invoke("desktop:read-clipboard-text"),
  writeClipboardText: (text) => ipcRenderer.invoke("desktop:write-clipboard-text", text),
  openMarket: (market) => ipcRenderer.invoke("desktop:open-market", market),
  openFullEdition: () => ipcRenderer.invoke("desktop:open-full-edition"),
  setEdition: (edition) => ipcRenderer.invoke("desktop:set-edition", edition),
  saveConnection: (connection) => ipcRenderer.invoke("desktop:save-connection", connection),
  deleteConnection: (connectionId) => ipcRenderer.invoke("desktop:delete-connection", connectionId),
  selectConnection: (connectionId) => ipcRenderer.invoke("desktop:select-connection", connectionId),
  chooseWorkspace: () => ipcRenderer.invoke("desktop:choose-workspace"),
  setWorkspace: (path) => ipcRenderer.invoke("desktop:set-workspace", path),
  setPermissionMode: (mode) => ipcRenderer.invoke("desktop:set-permission-mode", mode),
  setTheme: (theme) => ipcRenderer.invoke("desktop:set-theme", theme),
  respondApproval: (requestId, allow) => ipcRenderer.invoke("desktop:approval-response", requestId, allow),
  onStream: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("desktop:stream", handler);
    return () => ipcRenderer.removeListener("desktop:stream", handler);
  },
  onApprovalClosed: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("desktop:approval-closed", handler);
    return () => ipcRenderer.removeListener("desktop:approval-closed", handler);
  },
  onApproval: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("desktop:approval", handler);
    return () => ipcRenderer.removeListener("desktop:approval", handler);
  },
});
