const { contextBridge, ipcRenderer } = require("electron");
const methods = ["platformState", "platformCreate", "platformRevise", "platformSelect", "platformRecord", "platformAnalyze", "platformModuleSave", "platformModuleGenerate"];
contextBridge.exposeInMainWorld("moduleFixture", Object.fromEntries(methods.map(method => [method, input => ipcRenderer.invoke(`module-fixture:${method}`, input)])));
