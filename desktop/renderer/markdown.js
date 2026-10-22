(() => {
  const markdown = window.markdownit({ html: false, breaks: true });
  markdown.validateLink = url => /^https?:\/\//i.test(url);
  markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
    tokens[index].attrSet("target", "_blank");
    tokens[index].attrSet("rel", "noopener noreferrer");
    return renderer.renderToken(tokens, index, options);
  };
  markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);
  markdown.renderer.rules.table_open = () => '<div class="markdown-table" tabindex="0" role="region" aria-label="表格"><table>\n';
  markdown.renderer.rules.table_close = () => "</table></div>\n";
  for (const type of ["th_open", "td_open"]) markdown.renderer.rules[type] = (tokens, index, options, env, renderer) => {
    const token = tokens[index], alignment = token.attrGet("style");
    if (alignment) {
      token.attrs = token.attrs.filter(([name]) => name !== "style");
      token.attrSet("class", `markdown-align-${alignment.replace("text-align:", "")}`);
    }
    return renderer.renderToken(tokens, index, options);
  };
  const sources = new WeakMap();
  function reconcileText(current, next) {
    const previous = current.nodeValue, value = next.nodeValue;
    if (previous === value) return;
    if (value.startsWith(previous)) {
      current.appendData(value.slice(previous.length));
      return;
    }
    let start = 0, end = 0;
    while (start < previous.length && start < value.length && previous[start] === value[start]) start++;
    while (end < previous.length - start && end < value.length - start && previous[previous.length - 1 - end] === value[value.length - 1 - end]) end++;
    current.replaceData(start, previous.length - start - end, value.slice(start, value.length - end));
  }
  function reconcileNode(current, next) {
    if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) {
      current.parentNode.replaceChild(next, current);
      return;
    }
    if (current.nodeType === 3 || current.nodeType === 8) {
      reconcileText(current, next);
      return;
    }
    if (current.isEqualNode(next)) return;
    for (const attribute of Array.from(current.attributes)) {
      if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
    }
    for (const attribute of Array.from(next.attributes)) {
      if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
    }
    reconcileChildren(current, next);
  }
  function reconcileChildren(current, next) {
    const previous = Array.from(current.childNodes), following = Array.from(next.childNodes);
    for (let index = 0; index < following.length; index++) {
      if (previous[index]) reconcileNode(previous[index], following[index]);
      else current.appendChild(following[index]);
    }
    for (let index = following.length; index < previous.length; index++) current.removeChild(previous[index]);
  }
  window.renderMarkdown = (element, text) => {
    const previous = sources.get(element);
    if (previous?.text === text) return;
    // Reparse the full source so a late reference definition or closing fence can
    // update earlier Markdown, but keep existing blocks and growing text nodes.
    const html = markdown.render(text);
    element.classList.add("markdown-body");
    if (previous?.html !== html) {
      const template = document.createElement("template");
      template.innerHTML = html;
      reconcileChildren(element, template.content);
    }
    sources.set(element, { text, html });
  };
})();
