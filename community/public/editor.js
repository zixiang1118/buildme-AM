const editorForm = document.querySelector(
  "form[data-editor], form[data-quick-share]",
);

if (editorForm) {
  const body = editorForm.querySelector('textarea[name="body"]');
  const title = editorForm.querySelector('input[name="title"]');
  const link = editorForm.querySelector('input[name="link"]');
  const csrf = editorForm.querySelector('input[name="csrf"]').value;
  const preview = document.querySelector("#editor-preview");
  const previewToc = document.querySelector("#preview-toc");
  const status = document.querySelector("#editor-status");
  const linkStatus = document.querySelector("#link-status");
  const imageInput = editorForm.querySelector("[data-image-input]");
  const editorGrid = editorForm.querySelector(".editor-grid");
  const isQuickShare = editorForm.hasAttribute("data-quick-share");
  const userId = editorForm.dataset.userId;
  const draftKey = `buildme:draft:${userId}:${editorForm.dataset.editorId}`;
  const recentKey = `buildme:emoji:${userId}`;
  const uploadTasks = new Map();
  let dirty = false;
  let awaitingRestore = false;
  let submitting = false;
  let previewTimer;
  let previewRequest;
  let linkRequest;
  let suggestionItems = [];
  let suggestionIndex = 0;
  let suggestionRange;

  function setStatus(message, error = false) {
    if (!status) return;
    status.textContent = message;
    status.setAttribute("role", error ? "alert" : "status");
    status.classList.toggle("field-error", error);
  }

  function readStorage(key) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : null;
    } catch {
      setStatus("无法读取浏览器本地记录，请使用“保存草稿”。", true);
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      setStatus("浏览器无法保存本地记录，请使用“保存草稿”。", true);
      return false;
    }
  }

  function removeStorage(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      setStatus("浏览器无法清除本地记录。", true);
    }
  }

  function captureFields() {
    return [...editorForm.elements]
      .filter(
        (field) =>
          field.name &&
          !["csrf", "image"].includes(field.name) &&
          !["file", "submit", "button"].includes(field.type) &&
          (field.type !== "hidden" || ["coverId","shareData"].includes(field.name)),
      )
      .map((field) => ({
        name: field.name,
        value: field.value,
        checked: field.checked,
      }));
  }

  function saveLocalDraft() {
    if (!dirty || awaitingRestore || submitting) return;
    if (
      writeStorage(draftKey, { fields: captureFields(), savedAt: Date.now() })
    ) {
      dirty = false;
      if (!uploadTasks.size) setStatus("草稿已保存在此浏览器");
    }
  }

  async function postForm(url, data, signal) {
    const response = await fetch(url, {
      method: "POST",
      body: data,
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal,
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || "操作未完成，请重试。");
      error.fields = result.fields;
      throw error;
    }
    return result;
  }

  function apiData(values) {
    const data = new FormData();
    data.set("csrf", csrf);
    for (const [key, value] of Object.entries(values)) data.set(key, value);
    return data;
  }

  async function updatePreview() {
    if (!preview) return;
    previewRequest?.abort();
    previewRequest = new AbortController();
    try {
      const result = await postForm(
        "/preview",
        apiData({ body: body.value }),
        previewRequest.signal,
      );
      preview.innerHTML = result.html;
      if (previewToc) {
        previewToc.replaceChildren();
        previewToc.classList.add("toc", "preview-toc");
        previewToc.hidden = !result.toc.length;
        const heading = document.createElement("strong");
        heading.textContent = "文章目录";
        const list = document.createElement("ol");
        for (const item of result.toc) {
          const row = document.createElement("li");
          row.className = `level-${item.level}`;
          const anchor = document.createElement("a");
          anchor.href = `#${encodeURIComponent(item.id)}`;
          anchor.textContent = item.text;
          row.append(anchor);
          list.append(row);
        }
        previewToc.append(heading, list);
      }
      document.dispatchEvent(new Event("community:content-updated"));
    } catch (error) {
      if (error.name !== "AbortError")
        setStatus(`预览未更新：${error.message}`, true);
    }
  }

  function contentChanged() {
    dirty = true;
    reconcileUploads();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, 350);
  }

  function insertText(text) {
    body.setRangeText(text, body.selectionStart, body.selectionEnd, "end");
    body.focus();
    body.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function wrapSelection(before, after, placeholder) {
    const start = body.selectionStart;
    const selected = body.value.slice(start, body.selectionEnd) || placeholder;
    body.setRangeText(
      `${before}${selected}${after}`,
      start,
      body.selectionEnd,
      "end",
    );
    body.focus();
    body.setSelectionRange(
      start + before.length,
      start + before.length + selected.length,
    );
    body.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function prefixLines(prefix) {
    const start = body.value.lastIndexOf("\n", body.selectionStart - 1) + 1;
    const nextNewline = body.value.indexOf("\n", body.selectionEnd);
    const end = nextNewline === -1 ? body.value.length : nextNewline;
    const text = body.value
      .slice(start, end)
      .split("\n")
      .map(
        (line, index) =>
          `${typeof prefix === "function" ? prefix(index) : prefix}${line}`,
      )
      .join("\n");
    body.setRangeText(text, start, end, "select");
    body.focus();
    body.dispatchEvent(new Event("input", { bubbles: true }));
  }

  const emojis = [
    ["😀", "开心 微笑 高兴", "表情"],
    ["😄", "笑 大笑 开心", "表情"],
    ["😂", "笑 哭笑 太好笑", "表情"],
    ["🤣", "笑 笑倒", "表情"],
    ["😊", "微笑 害羞", "表情"],
    ["🥰", "喜欢 爱 幸福", "表情"],
    ["😍", "喜欢 爱心眼", "表情"],
    ["😎", "酷 墨镜", "表情"],
    ["🤔", "思考 想想 疑问", "表情"],
    ["🧐", "研究 观察", "表情"],
    ["🤓", "学习 书呆子", "表情"],
    ["😅", "汗 尴尬", "表情"],
    ["😆", "笑 开心", "表情"],
    ["😉", "眨眼", "表情"],
    ["😮", "惊讶 哇", "表情"],
    ["😱", "震惊 害怕", "表情"],
    ["😢", "难过 哭", "表情"],
    ["😭", "哭 大哭", "表情"],
    ["🥲", "哭笑 感动", "表情"],
    ["😴", "困 睡觉", "表情"],
    ["🤯", "震惊 脑爆", "表情"],
    ["🥳", "庆祝 开心", "表情"],
    ["🫡", "敬礼 收到", "表情"],
    ["🤖", "机器人 Agent 智能体", "表情"],
    ["👍", "赞 好 同意", "手势"],
    ["👎", "踩 不好", "手势"],
    ["👏", "鼓掌 棒", "手势"],
    ["🙌", "庆祝 举手", "手势"],
    ["🙏", "谢谢 感谢 拜托", "手势"],
    ["👌", "好 没问题", "手势"],
    ["✌️", "胜利 耶", "手势"],
    ["💪", "加油 努力", "手势"],
    ["🤝", "握手 合作", "手势"],
    ["👋", "你好 再见 挥手", "手势"],
    ["👀", "看 关注 眼睛", "手势"],
    ["🧠", "脑 思考", "手势"],
    ["❤️", "爱 喜欢 红心", "常用符号"],
    ["💛", "黄心 喜欢", "常用符号"],
    ["💙", "蓝心 喜欢", "常用符号"],
    ["🔥", "火 热门", "常用符号"],
    ["✨", "闪亮 精彩", "常用符号"],
    ["🎉", "庆祝 成功", "常用符号"],
    ["🚀", "火箭 起飞 发布", "常用符号"],
    ["💯", "满分 棒", "常用符号"],
    ["✅", "完成 成功 对", "常用符号"],
    ["❌", "错误 失败", "常用符号"],
    ["⚠️", "注意 警告", "常用符号"],
    ["💡", "想法 灵感", "常用符号"],
    ["🛠️", "工具 动手 构建", "物品"],
    ["🧱", "积木 构建", "物品"],
    ["💻", "电脑 编程 代码", "物品"],
    ["🐛", "虫 错误 bug", "物品"],
    ["📚", "书 学习 文档", "物品"],
    ["📝", "笔记 记录", "物品"],
    ["🔗", "链接 分享", "物品"],
    ["📦", "包 打包", "物品"],
    ["🎯", "目标 命中", "物品"],
    ["🏆", "奖杯 成就", "物品"],
    ["☕", "咖啡 休息", "物品"],
    ["🌱", "成长 苗", "物品"],
    ["🐱", "猫 喵", "物品"],
    ["🐶", "狗 汪", "物品"],
    ["🍉", "瓜 吃瓜", "物品"],
  ];
  let recentEmojis = readStorage(recentKey) || [];
  const emojiPanel = document.createElement("section");
  emojiPanel.className = "emoji-panel";
  emojiPanel.hidden = true;
  emojiPanel.setAttribute("aria-label", "选择表情");
  const emojiSearch = document.createElement("input");
  emojiSearch.type = "search";
  emojiSearch.placeholder = "搜索表情，例如：笑、赞、代码";
  emojiSearch.setAttribute("aria-label", "按中文名称搜索表情");
  const emojiCategories = document.createElement("div");
  emojiCategories.className = "emoji-categories";
  const emojiGrid = document.createElement("div");
  emojiGrid.className = "emoji-grid";
  emojiGrid.setAttribute("aria-label", "表情");
  const emojiClose = document.createElement("button");
  emojiClose.type = "button";
  emojiClose.className = "button";
  emojiClose.textContent = "关闭";
  emojiPanel.append(emojiSearch, emojiCategories, emojiGrid, emojiClose);
  body.parentElement.after(emojiPanel);
  let emojiCategory = "表情";
  let emojiSelection = [0, 0];

  function rememberEmoji(emoji) {
    recentEmojis = [
      emoji,
      ...recentEmojis.filter((item) => item !== emoji),
    ].slice(0, 16);
    writeStorage(recentKey, recentEmojis);
  }

  function selectEmoji(emoji) {
    body.setSelectionRange(...emojiSelection);
    insertText(emoji);
    rememberEmoji(emoji);
    closeEmojiPanel();
  }

  function renderEmojis() {
    const query = emojiSearch.value.trim().toLocaleLowerCase();
    const items = emojis.filter(([symbol, names, category]) =>
      query
        ? `${symbol} ${names}`.toLocaleLowerCase().includes(query)
        : emojiCategory === "常用"
          ? recentEmojis.includes(symbol)
          : category === emojiCategory,
    );
    if (emojiCategory === "常用" && !query)
      items.sort(
        (a, b) => recentEmojis.indexOf(a[0]) - recentEmojis.indexOf(b[0]),
      );
    emojiGrid.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = query ? "没有匹配的表情" : "选择过的表情会显示在这里";
      emojiGrid.append(empty);
    }
    for (const [symbol, names] of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = symbol;
      button.title = names;
      button.setAttribute("aria-label", names);
      button.addEventListener("click", () => selectEmoji(symbol));
      emojiGrid.append(button);
    }
    for (const button of emojiCategories.querySelectorAll("button"))
      button.setAttribute(
        "aria-pressed",
        String(button.textContent === emojiCategory),
      );
  }

  for (const category of ["常用", "表情", "手势", "常用符号", "物品"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = category;
    button.addEventListener("click", () => {
      emojiCategory = category;
      renderEmojis();
    });
    emojiCategories.append(button);
  }
  emojiSearch.addEventListener("input", renderEmojis);
  function closeEmojiPanel() {
    emojiPanel.hidden = true;
    editorForm
      .querySelector('[data-markdown="emoji"]')
      ?.setAttribute("aria-expanded", "false");
  }
  emojiClose.addEventListener("click", () => {
    closeEmojiPanel();
    body.focus();
  });
  emojiPanel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeEmojiPanel();
      body.focus();
    }
  });

  const suggestions = document.createElement("div");
  suggestions.className = "emoji-suggestions";
  suggestions.hidden = true;
  suggestions.id = "emoji-suggestions";
  suggestions.setAttribute("role", "listbox");
  suggestions.setAttribute("aria-label", "表情联想");
  body.parentElement.after(suggestions);

  function closeSuggestions() {
    suggestions.hidden = true;
    suggestionItems = [];
    body.removeAttribute("aria-activedescendant");
    body.removeAttribute("aria-controls");
  }

  function chooseSuggestion(index) {
    const emoji = suggestionItems[index][0];
    body.setSelectionRange(...suggestionRange);
    closeSuggestions();
    insertText(emoji);
    rememberEmoji(emoji);
  }

  function updateSuggestionSelection() {
    [...suggestions.children].forEach((button, index) =>
      button.setAttribute("aria-selected", String(index === suggestionIndex)),
    );
    body.setAttribute(
      "aria-activedescendant",
      `emoji-option-${suggestionIndex}`,
    );
  }

  function showSuggestions() {
    if (body.selectionStart !== body.selectionEnd) return closeSuggestions();
    const match = body.value
      .slice(0, body.selectionStart)
      .match(/(:([^\s:]{1,12}))$/u);
    if (!match) return closeSuggestions();
    suggestionItems = emojis
      .filter(([, names]) =>
        names.toLocaleLowerCase().includes(match[2].toLocaleLowerCase()),
      )
      .slice(0, 7);
    if (!suggestionItems.length) return closeSuggestions();
    suggestionRange = [
      body.selectionStart - match[1].length,
      body.selectionStart,
    ];
    suggestionIndex = 0;
    suggestions.replaceChildren();
    suggestionItems.forEach(([symbol, names], index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.id = `emoji-option-${index}`;
      button.textContent = `${symbol} ${names.split(" ")[0]}`;
      button.setAttribute("role", "option");
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => chooseSuggestion(index));
      suggestions.append(button);
    });
    suggestions.hidden = false;
    body.setAttribute("aria-controls", suggestions.id);
    updateSuggestionSelection();
  }

  const uploadList = document.createElement("div");
  uploadList.className = "upload-list";
  uploadList.setAttribute("aria-live", "polite");
  body.parentElement.after(uploadList);

  function updateSubmitState() {
    for (const button of editorForm.querySelectorAll(
      'button[type="submit"], input[type="submit"]',
    )) {
      button.disabled = submitting || uploadTasks.size > 0;
    }
  }

  function renderUploads() {
    uploadList.replaceChildren();
    for (const [id, task] of uploadTasks) {
      const row = document.createElement("div");
      row.className = `upload-task${task.error ? " failed" : ""}`;
      const label = document.createElement("span");
      label.textContent = task.error || `正在上传 ${task.file.name}…`;
      row.append(label);
      if (task.error && task.file) {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "button";
        retry.textContent = "重试";
        retry.addEventListener("click", () => uploadImage(id));
        row.append(retry);
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "button";
      remove.textContent = "移除占位";
      remove.addEventListener("click", () => {
        task.controller?.abort();
        body.value = body.value.replace(task.placeholder, "");
        uploadTasks.delete(id);
        body.dispatchEvent(new Event("input", { bubbles: true }));
        renderUploads();
      });
      row.append(remove);
      uploadList.append(row);
    }
    updateSubmitState();
  }

  function reconcileUploads() {
    let changed = false;
    for (const [id, task] of uploadTasks) {
      if (!body.value.includes(task.placeholder)) {
        task.controller?.abort();
        uploadTasks.delete(id);
        changed = true;
      }
    }
    for (const match of body.value.matchAll(
      /!\[图片上传中\]\(buildme-upload:([a-z0-9-]+)\)/g,
    )) {
      if (!uploadTasks.has(match[1])) {
        uploadTasks.set(match[1], {
          placeholder: match[0],
          error: "这张图片未完成上传，请移除占位后重新选择图片。",
        });
        changed = true;
      }
    }
    if (changed) renderUploads();
  }

  async function uploadImage(id) {
    const task = uploadTasks.get(id);
    task.error = null;
    task.controller = new AbortController();
    renderUploads();
    try {
      const result = await postForm(
        "/images",
        apiData({ image: task.file }),
        task.controller.signal,
      );
      if (!uploadTasks.has(id)) return;
      body.value = body.value.replace(
        task.placeholder,
        `![${task.file.name.replace(/[[\]\\]/g, "")}](${result.url})`,
      );
      uploadTasks.delete(id);
      body.dispatchEvent(new Event("input", { bubbles: true }));
      setStatus("图片已上传");
    } catch (error) {
      if (error.name === "AbortError") return;
      task.error = `${task.file.name} 上传失败：${error.message}`;
      setStatus("图片上传未完成。请重试或移除占位后再发布。", true);
    }
    renderUploads();
  }

  function queueImages(files) {
    for (const file of files) {
      const id = crypto.randomUUID();
      const placeholder = `![图片上传中](buildme-upload:${id})`;
      uploadTasks.set(id, { file, placeholder, error: null });
      insertText(`\n${placeholder}\n`);
      uploadImage(id);
    }
  }

  imageInput?.addEventListener("change", () => {
    queueImages(imageInput.files);
    imageInput.value = "";
  });
  body.addEventListener("paste", (event) => {
    const images = [...event.clipboardData.files].filter((file) =>
      file.type.startsWith("image/"),
    );
    if (!images.length) return;
    event.preventDefault();
    queueImages(images);
  });
  body.addEventListener("dragover", (event) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    body.classList.add("drag-over");
  });
  body.addEventListener("dragleave", () => body.classList.remove("drag-over"));
  body.addEventListener("drop", (event) => {
    body.classList.remove("drag-over");
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    queueImages(event.dataTransfer.files);
  });

  function markdownAction(action) {
    switch (action) {
      case "heading":
        prefixLines("## ");
        break;
      case "bold":
        wrapSelection("**", "**", "加粗文字");
        break;
      case "italic":
        wrapSelection("*", "*", "斜体文字");
        break;
      case "quote":
        prefixLines("> ");
        break;
      case "code":
        wrapSelection("`", "`", "代码");
        break;
      case "codeblock":
        wrapSelection("\n```text\n", "\n```\n", "在这里写代码");
        break;
      case "link":
        wrapSelection("[", "](https://)", "链接文字");
        break;
      case "list":
        prefixLines("- ");
        break;
      case "ordered":
        prefixLines((index) => `${index + 1}. `);
        break;
      case "image":
        imageInput.click();
        break;
      case "emoji":
        emojiSelection = [body.selectionStart, body.selectionEnd];
        emojiPanel.hidden = !emojiPanel.hidden;
        editorForm
          .querySelector('[data-markdown="emoji"]')
          .setAttribute("aria-expanded", String(!emojiPanel.hidden));
        if (!emojiPanel.hidden) {
          renderEmojis();
          emojiSearch.focus();
        }
        break;
    }
  }

  editorForm.addEventListener("click", (event) => {
    const button = event.target.closest("[data-markdown]");
    if (button) {
      event.preventDefault();
      markdownAction(button.dataset.markdown);
    }
    const tab = event.target.closest("[data-editor-tab]");
    if (tab) {
      event.preventDefault();
      editorGrid.dataset.view = tab.dataset.editorTab;
      for (const item of editorForm.querySelectorAll("[data-editor-tab]"))
        item.setAttribute("aria-selected", String(item === tab));
      if (tab.dataset.editorTab === "preview") updatePreview();
    }
  });
  body.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (
      !suggestions.hidden &&
      ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)
    ) {
      event.preventDefault();
      if (event.key === "Escape") return closeSuggestions();
      if (event.key === "Enter") return chooseSuggestion(suggestionIndex);
      suggestionIndex =
        (suggestionIndex +
          (event.key === "ArrowDown" ? 1 : -1) +
          suggestionItems.length) %
        suggestionItems.length;
      updateSuggestionSelection();
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const action = { b: "bold", i: "italic", k: "link" }[
      event.key.toLowerCase()
    ];
    if (action) {
      event.preventDefault();
      markdownAction(action);
    }
  });
  body.addEventListener("input", (event) => {
    if (!event.isComposing) showSuggestions();
  });
  body.addEventListener("compositionend", showSuggestions);
  body.addEventListener("click", showSuggestions);

  let resolvedLink = "";
  const linkPreview = document.createElement("div");
  linkPreview.className = "resolved-link";
  if (linkStatus) linkStatus.after(linkPreview);

  async function resolveLink() {
    const url = link.value.trim();
    if (url === resolvedLink) return;
    linkRequest?.abort();
    linkPreview.replaceChildren();
    if (!url) {
      resolvedLink = "";
      if (linkStatus) linkStatus.textContent = "";
      return;
    }
    linkRequest = new AbortController();
    if (linkStatus) {
      linkStatus.textContent = "正在读取链接标题…";
      linkStatus.classList.remove("field-error");
    }
    try {
      const result = await postForm(
        "/links/resolve",
        apiData({ link: url }),
        linkRequest.signal,
      );
      if (link.value.trim() !== url) return;
      resolvedLink = url;
      if (!title.value.trim() && result.title) {
        title.value = [...result.title].slice(0, 80).join("");
        dirty = true;
      }
      if (linkStatus)
        linkStatus.textContent = result.title
          ? "已读取标题，你可以继续修改。"
          : "未取到标题，请手动填写，仍可发布。";
      const card = document.createElement("div");
      card.className = "link-card";
      if (
        result.thumbnail &&
        [
          location.origin,
          document.documentElement.dataset.imageOrigin,
        ].includes(new URL(result.thumbnail, location.origin).origin)
      ) {
        const image = document.createElement("img");
        image.src = result.thumbnail;
        image.alt = "";
        card.append(image);
      }
      const details = document.createElement("div");
      const heading = document.createElement("strong");
      heading.textContent = result.title || title.value || url;
      const source = document.createElement("small");
      source.textContent = result.source;
      details.append(heading, source);
      card.append(details);
      linkPreview.append(card);
      if (result.duplicate) {
        const notice = document.createElement("p");
        notice.className = "notice warning duplicate-notice";
        notice.append(
          `这个链接 ${result.duplicate.days} 天前 @${result.duplicate.username} 分享过。`,
        );
        const original = document.createElement("a");
        original.href = `/p/${result.duplicate.id}`;
        original.textContent = "查看原帖";
        original.target = "_blank";
        original.rel = "noopener";
        notice.append(original, "，你也可以继续发布。");
        linkPreview.append(notice);
      }
    } catch (error) {
      if (error.name === "AbortError") return;
      if (linkStatus) {
        linkStatus.textContent = `链接解析未完成：${error.message} 请手动填写标题，仍可发布。`;
        linkStatus.classList.add("field-error");
      }
    }
  }
  link?.addEventListener("change", resolveLink);
  link?.addEventListener("paste", () => setTimeout(resolveLink, 0));

  function showFieldErrors(fields) {
    for (const message of editorForm.querySelectorAll("[data-client-error]"))
      message.remove();
    for (const field of editorForm.querySelectorAll('[aria-invalid="true"]'))
      field.removeAttribute("aria-invalid");
    if (!fields) return;
    for (const [name, reason] of Object.entries(fields)) {
      const field = editorForm.elements.namedItem(name);
      if (!(field instanceof HTMLElement)) continue;
      field.setAttribute("aria-invalid", "true");
      const message = document.createElement("p");
      message.className = "field-error";
      message.dataset.clientError = "true";
      message.textContent = reason;
      field.after(message);
    }
  }

  editorForm.addEventListener("submit", async (event) => {
    reconcileUploads();
    if (
      uploadTasks.size ||
      body.value.includes("buildme-upload:") ||
      submitting
    ) {
      event.preventDefault();
      setStatus(
        uploadTasks.size || body.value.includes("buildme-upload:")
          ? "请先完成图片上传，或移除未上传的占位。"
          : "正在提交，请稍候。",
        true,
      );
      return;
    }
    if (
      !isQuickShare ||
      event.submitter?.getAttribute("formaction") === "/drafts"
    ) {
      saveLocalDraft();
      return;
    }
    event.preventDefault();
    const data = new FormData(editorForm, event.submitter);
    submitting = true;
    updateSubmitState();
    setStatus("正在发布…");
    showFieldErrors();
    try {
      const result = await postForm(editorForm.action, data);
      if (result.html) {
        const template = document.createElement("template");
        template.innerHTML = result.html;
        document.querySelector("#post-list").prepend(template.content);
        document.querySelector("#post-list .empty")?.remove();
      }
      editorForm.reset();
      removeStorage(draftKey);
      dirty = false;
      resolvedLink = "";
      linkPreview.replaceChildren();
      if (linkStatus) linkStatus.textContent = "";
      setStatus(
        result.pending
          ? "已提交，管理员审核通过后会公开显示。"
          : "已发布到最新列表。",
      );
      document.dispatchEvent(new Event("community:content-updated"));
    } catch (error) {
      showFieldErrors(error.fields);
      setStatus(`未发布：${error.message}`, true);
    } finally {
      submitting = false;
      updateSubmitState();
    }
  });

  editorForm.addEventListener("input", contentChanged);
  editorForm.addEventListener("change", () => {
    dirty = true;
  });
  const storedDraft = readStorage(draftKey);
  if (
    storedDraft?.fields?.length &&
    JSON.stringify(storedDraft.fields) !== JSON.stringify(captureFields())
  ) {
    awaitingRestore = true;
    const restoreBar = document.createElement("div");
    restoreBar.className = "notice draft-restore";
    restoreBar.setAttribute("role", "status");
    const message = document.createElement("p");
    message.textContent =
      "恢复上次没发完的草稿？当前内容会保留，直到你选择恢复。";
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "button primary";
    restore.textContent = "恢复草稿";
    const discard = document.createElement("button");
    discard.type = "button";
    discard.className = "button";
    discard.textContent = "丢弃本地草稿";
    restore.addEventListener("click", () => {
      for (const saved of storedDraft.fields) {
        for (const field of editorForm.elements) {
          if (field.name !== saved.name) continue;
          if (["checkbox", "radio"].includes(field.type)) {
            if (field.value === saved.value) field.checked = saved.checked;
          } else field.value = saved.value;
        }
      }
      awaitingRestore = false;
      restoreBar.remove();
      document.dispatchEvent(new Event("community:work-restored"));
      body.dispatchEvent(new Event("input", { bubbles: true }));
      setStatus("已恢复本地草稿");
      body.focus();
    });
    discard.addEventListener("click", () => {
      awaitingRestore = false;
      removeStorage(draftKey);
      restoreBar.remove();
      dirty = true;
      setStatus("已保留当前内容");
    });
    restoreBar.append(message, restore, discard);
    editorForm.prepend(restoreBar);
  }
  setInterval(saveLocalDraft, 5000);
  window.addEventListener("pagehide", saveLocalDraft);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) saveLocalDraft();
  });
  reconcileUploads();
  updatePreview();
}
