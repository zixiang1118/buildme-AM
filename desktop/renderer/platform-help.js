(() => {
  "use strict";
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };

  window.createPlatformGuide = () => {
    const content = window.PLATFORM_USAGE_GUIDE;
    const dialog = node("dialog", "platform-guide");
    dialog.id = "platform-guide-dialog";
    dialog.setAttribute("aria-labelledby", "platform-guide-title");
    dialog.setAttribute("aria-describedby", "platform-guide-subtitle");
    const shell = node("div", "platform-guide-shell"), header = node("header", "platform-guide-header");
    const title = node("div");
    const heading = node("h2", "", content.title); heading.id = "platform-guide-title";
    const subtitle = node("p", "", content.subtitle); subtitle.id = "platform-guide-subtitle";
    title.append(node("span", "platform-guide-eyebrow", "BUILDME / START HERE"), heading, subtitle);
    const dismiss = node("button", "platform-guide-dismiss", "×");
    dismiss.id = "platform-guide-close"; dismiss.type = "button"; dismiss.setAttribute("aria-label", "关闭搭建与使用说明");
    header.append(title, dismiss);
    const body = node("div", "platform-guide-body"), navigation = node("nav", "platform-guide-nav"), page = node("section", "platform-guide-page");
    navigation.setAttribute("aria-label", "说明章节");
    page.id = "platform-guide-page"; page.tabIndex = 0;
    body.append(navigation, page);
    const footer = node("footer", "platform-guide-footer"), done = node("button", "platform-guide-done", "知道了，返回平台");
    done.type = "button";
    footer.append(node("span", "", "随时从平台右上角打开这份说明"), done);
    shell.append(header, body, footer); dialog.append(shell); document.body.append(dialog);
    let previousFocus;
    const sections = [{ id: "overview", title: "快速开始" }, ...content.sections, { id: "faq", title: "常见问题" }];

    function select(id) {
      for (const button of navigation.children) {
        if (button.dataset.guideSection === id) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      }
      page.replaceChildren(); page.scrollTop = 0;
      const section = sections.find(item => item.id === id);
      page.setAttribute("aria-label", section.title);
      page.append(node("span", "platform-guide-eyebrow", id === "overview" ? "YOUR FIRST PLATFORM" : "BUILD · USE · IMPROVE"), node("h3", "", id === "overview" ? "从搭建到使用，四步开始" : section.title));
      if (id === "overview") {
        const steps = node("ol", "platform-guide-quickstart");
        content.quickStart.forEach((step, index) => {
          const item = node("li", "platform-guide-step");
          item.append(node("span", "platform-guide-number", `0${index + 1}`), node("h4", "", step.title), node("p", "", step.body));
          steps.append(item);
        });
        const note = node("div", "platform-guide-note");
        note.append(node("strong", "", "搭建好之后，可以直接返回聊天。"), node("p", "", "保持在科研版并选中平台，AI 每轮都会收到平台配置。录入、导入、统计和流程执行，从平台里的对应按钮开始。"));
        page.append(steps, note);
      } else if (id === "faq") {
        const list = node("div", "platform-guide-faq");
        content.faq.forEach((entry, index) => {
          const item = node("details"); item.open = index === 0;
          item.append(node("summary", "", entry.question), node("p", "", entry.answer)); list.append(item);
        });
        page.append(list);
      } else {
        if (section.intro) page.append(node("p", "platform-guide-intro", section.intro));
        if (section.steps?.length) {
          const steps = node("ol", "platform-guide-instructions");
          for (const step of section.steps) {
            const item = node("li"); item.append(node("h4", "", step.title), node("p", "", step.body)); steps.append(item);
          }
          page.append(steps);
        }
        if (section.bullets?.length) {
          const list = node("ul", "platform-guide-bullets");
          for (const text of section.bullets) list.append(node("li", "", text));
          page.append(list);
        }
        if (section.example) {
          const example = node("div", "platform-guide-example");
          example.append(node("span", "", section.example.label), node("p", "", section.example.text)); page.append(example);
        }
      }
    }
    sections.forEach((section, index) => {
      const button = node("button", "platform-guide-nav-item"); button.type = "button"; button.dataset.guideSection = section.id;
      button.setAttribute("aria-controls", page.id);
      button.append(node("span", "", index === 0 ? "↗" : String(index).padStart(2, "0")), node("strong", "", section.title.replace(/^\d+\s*·\s*/u, "")));
      button.addEventListener("click", () => select(section.id)); navigation.append(button);
    });
    const close = () => { if (dialog.open) dialog.close(); };
    dismiss.addEventListener("click", close); done.addEventListener("click", close);
    dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
    dialog.addEventListener("close", () => previousFocus?.focus());
    return {
      open(opener = document.activeElement) { if (dialog.open) return; previousFocus = opener; select("overview"); dialog.showModal(); dismiss.focus(); },
      close,
    };
  };
})();
