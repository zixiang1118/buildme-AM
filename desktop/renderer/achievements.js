(() => {
  window.createAchievements = (api, { onTurn }) => {
    const $ = (selector) => document.querySelector(selector);
    const dialog = $("#achievements-dialog"), grid = $("#achievement-grid"), status = $("#achievement-status"), toast = $("#achievement-toast");
    const seen = new Set(), queue = [];
    let definitions = [], showing = false, consecutive = 0;
    window.recordLearningEvent = (type, details = {}) => {
      void api.learningEvent({ id: window.crypto.randomUUID(), type, ...details }).then((result) => {
        if (!result.accepted) status.textContent = "学习记录暂时无法保存，对话可继续。";
      }).catch(() => { status.textContent = "学习记录暂时无法保存，对话可继续。"; });
    };
    function shareButton(id) {
      const button=document.createElement('button');button.type='button';button.className='secondary-button';button.textContent='分享到社区';button.disabled=!window.communityAvailable();button.onclick=()=>void window.shareToCommunity('achievement',id);return button;
    }
    function play() {
      if (showing || !queue.length) { if (!queue.length) consecutive = 0; return; }
      showing = true;
      let shareId;
      const button = document.createElement("button"); button.type = "button";
      if (consecutive === 3) {
        const count = queue.length; queue.splice(0); consecutive = 0;
        button.textContent = `还解锁了 ${count} 个成就 · 查看全部`;
        button.addEventListener("click", () => void open());
      } else {
        const unlock = queue.shift(); shareId=unlock.id; const definition = definitions.find((item) => item.id === unlock.id);
        button.textContent = `${definition.icon} ${definition.name} · 你刚刚解锁了一项成就`;
        button.addEventListener("click", () => void open(unlock.id)); consecutive++;
      }
      toast.replaceChildren(button); if(shareId)toast.append(shareButton(shareId)); toast.hidden = false;
      setTimeout(() => { toast.hidden = true; toast.replaceChildren(); setTimeout(() => { showing = false; play(); }, 1000); }, 3000);
    }
    async function render(focusId) {
      const data = await api.achievements(); definitions = data.definitions;
      $("#achievement-count").textContent = `已解锁 ${data.achievements.length} / ${definitions.length}`;
      grid.replaceChildren();
      for (const definition of definitions) {
        const unlock = data.achievements.find((item) => item.id === definition.id);
        const card = document.createElement("button"); card.type = "button"; card.className = `achievement-card${unlock ? " unlocked" : ""}`; card.dataset.achievement = definition.id;
        const icon = document.createElement("span"); icon.className = "achievement-icon"; icon.textContent = definition.icon; icon.setAttribute("aria-hidden", "true");
        const name = document.createElement("strong"); name.textContent = unlock || definition.hint !== "???" ? definition.name : "???";
        const detail = document.createElement("small"); detail.textContent = unlock ? new Date(unlock.at).toLocaleString("zh-CN") : definition.hint;
        card.append(icon, name, detail);
        card.addEventListener("click", async () => {
          if (!unlock) { status.textContent = definition.hint; return; }
          if (!unlock.turnId) { status.textContent = "这项成就来自界面操作，没有关联的 Agent 回合。"; return; }
          try {
            const turn = await api.xrayTurn(unlock.turnId);
            if (!turn) { status.textContent = "触发回合的历史已被清理，无法跳转。成就记录仍然保留。"; return; }
            await onTurn(turn); dialog.close();
          } catch (error) { status.textContent = `无法打开触发回合：${error.message || error}`; }
        });
        const item=document.createElement("div");item.className="achievement-item";item.append(card);if(unlock)item.append(shareButton(definition.id));grid.append(item);
        if (focusId === definition.id) { card.dataset.highlight = "true"; card.scrollIntoView({ block: "nearest" }); card.focus(); }
      }
    }
    async function open(focusId) {
      if (!dialog.open) dialog.showModal();
      status.textContent = "学习记录只保存在本地。";
      try { await render(focusId); } catch (error) { status.textContent = `读取学习记录失败：${error.message || error}`; }
    }
    $("#achievements").addEventListener("click", () => void open());
    $("#achievement-close").addEventListener("click", () => dialog.close());
    $("#achievement-export").addEventListener("click", async () => {
      try {
        const result = await api.exportLearning();
        status.textContent = result.cancelled ? "已取消导出。" : "已导出成就、能力状态和计数器，不包含对话或执行记录。";
      } catch (error) { status.textContent = `导出失败：${error.message || error}`; }
    });
    api.onAchievements(async (unlocks) => {
      try {
        if (!definitions.length) definitions = (await api.achievements()).definitions;
        for (const unlock of unlocks) if (!seen.has(unlock.id)) { seen.add(unlock.id); queue.push(unlock); }
        play();
        if (dialog.open) await render();
      } catch { status.textContent = "成就提示暂时不可用，可以稍后重新打开成就页。"; }
    });
    return { open };
  };
})();
