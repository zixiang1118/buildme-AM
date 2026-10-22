(() => {
  const node = (tag, cls, text) => { const el = document.createElement(tag); el.className = cls; if (text !== undefined) el.textContent = text; return el; };
  window.createExplanations = (api) => {
    let state;
    const panels = new Set(), requests = new Map();
    function connection(panel) {
      const selected = state?.connections.find((c) => c.id === state.activeConnectionId);
      panel.start.disabled = panel.running || !state?.configured;
      panel.note.textContent = state?.configured ? `使用当前连接：${selected.name || selected.provider} · ${selected.model}。点击后调用模型，最多 900 输出 tokens。` : "需要先在设置里添加并配置模型。";
    }
    window.addDeepExplanation = (host, target, label = "结合这一步详细讲讲") => {
      const box = node("section", "deep-explanation"), start = node("button", "secondary-button deep-start", label), cancel = node("button", "secondary-button deep-cancel", "停止讲解"), note = node("p", "deep-note"), status = node("p", "deep-status"), output = node("pre", "deep-output");
      start.type = cancel.type = "button"; cancel.hidden = true; output.hidden = true; status.setAttribute("role", "status");
      box.append(start, cancel, note, status, output); host.append(box);
      const panel = { box, start, cancel, note, status, output, running: false }; panels.add(panel); connection(panel);
      start.onclick = async () => {
        if (panel.running) return;
        const id = crypto.randomUUID(); panel.id = id; panel.running = true; requests.set(id, panel); connection(panel);
        cancel.hidden = false; status.textContent = "正在读取脱敏记录…"; output.textContent = ""; output.hidden = true;
        try { await api.explain(id, target); } catch (error) { finish(panel, `讲解失败：${error.message}`); requests.delete(id); }
      };
      cancel.onclick = async () => { cancel.disabled = true; status.textContent = "正在停止…"; try { await api.cancelExplanation(panel.id); } catch (error) { status.textContent = error.message; } finally { cancel.disabled = false; } };
      return box;
    };
    function finish(panel, message) { panel.running = false; panel.cancel.hidden = true; panel.status.textContent = message; connection(panel); }
    api.onExplanation((event) => {
      const panel = requests.get(event.requestId); if (!panel) return;
      if (event.type === "start") panel.status.textContent = `正在用 ${event.model} 讲解…`;
      if (event.type === "text" || event.type === "done") { panel.output.hidden = false; panel.output.textContent = event.text; }
      if (event.type === "done") finish(panel, event.cached ? "已读取本地缓存，本次没有调用模型。" : "讲解完成 · 未写入聊天历史。");
      if (event.type === "error") finish(panel, `讲解失败：${event.message}`);
      if (event.type === "cancelled") finish(panel, "已取消讲解，未缓存未完成的结果。");
      if (["done", "error", "cancelled"].includes(event.type)) requests.delete(event.requestId);
    });
    const observer = new MutationObserver(() => {
      for (const panel of panels) if (!panel.box.isConnected) { panels.delete(panel); if (panel.running) { requests.delete(panel.id); void api.cancelExplanation(panel.id); } }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return { sync(next) { state = next; for (const panel of panels) connection(panel); } };
  };
})();
