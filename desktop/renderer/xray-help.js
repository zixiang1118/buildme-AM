(() => {
  let nextId = 0;
  const node = (tag, className, text) => {
    const result = document.createElement(tag);
    result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  };
  window.XrayHelp = (topic, capabilityId, label = "这是什么") => {
    const entry = window.XrayKnowledge.topics[topic];
    const capability = Object.hasOwn(window.XrayKnowledge.capabilities, capabilityId) ? window.XrayKnowledge.capabilities[capabilityId] : undefined;
    const extra = capability && capability !== entry ? capability : undefined;
    const wrapper = node("div", "xray-help"), button = node("button", "xray-help-toggle", label);
    const id = `xray-help-${++nextId}`;
    const title = `${entry.title}${extra ? ` · ${extra.title}` : ""}`;
    wrapper.dataset.topic = topic;
    button.type = "button";
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", `${label}：${title}`);
    let body;
    function close() {
      body.hidden = true;
      button.setAttribute("aria-expanded", "false");
      button.focus();
    }
    button.addEventListener("click", () => {
      if (body && !body.hidden) { close(); return; }
      if (!body) {
        body = node("section", "xray-help-card");
        body.id = id;
        button.setAttribute("aria-controls", id);
        body.setAttribute("aria-labelledby", `${id}-title`);
        const heading = node("strong", "xray-help-title", title);
        heading.id = `${id}-title`;
        body.append(heading, node("span", "xray-help-local", "本地讲解 · 不消耗 token"));
        for (const [key, label] of [["what", "这是什么"], ["why", "为什么要这样做"], ["correspondence", "在 Claude Code / Codex 中"]]) {
          const text = key === "correspondence" ? (extra || entry)[key] : `${entry[key]}${extra ? ` ${extra[key]}` : ""}`;
          body.append(node("h4", "", label), node("p", "", text));
        }
        const dismiss = node("button", "xray-help-dismiss", "收起讲解");
        dismiss.type = "button";
        dismiss.addEventListener("click", close);
        body.append(dismiss);
        wrapper.append(body);
        const turnId = wrapper.closest("[data-turn-id]")?.dataset.turnId;
        const eventId = wrapper.closest("[data-event-id]")?.dataset.eventId;
        const segment = wrapper.closest("[data-segment-index]")?.dataset.segmentIndex;
        if (turnId) window.addDeepExplanation?.(body, { kind: "event", turnId, ...(eventId ? { eventId } : segment !== undefined ? { segmentIndex: Number(segment) } : {}) });
      }
      window.recordLearningEvent?.("explain-clicked", { turnId: wrapper.closest("[data-turn-id]")?.dataset.turnId });
      body.hidden = false;
      button.setAttribute("aria-expanded", "true");
      body.scrollIntoView({ block: "nearest" });
    });
    wrapper.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !body || body.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    });
    wrapper.append(button);
    return wrapper;
  };
})();
