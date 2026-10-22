(() => {
  const pendingKey = 'buildme:pending-share';
  const form = document.querySelector('form[data-editor][data-user-id]');
  const field = form?.querySelector('input[name="shareData"]');
  const format = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
  const invalidMessage = '分享数据无法读取，请回到 BuildMe 重新分享。';
  let preview;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function notice(text, error = false) {
    let status = document.querySelector('[data-share-status]');
    if (!status) {
      status = node('div', 'notice share-editor-notice');
      status.dataset.shareStatus = '';
      const anchor = form || document.querySelector('.auth-layout') || document.querySelector('.page').firstElementChild;
      anchor.before(status);
    }
    status.textContent = text;
    status.classList.toggle('error', error);
    status.setAttribute('role', error ? 'alert' : 'status');
  }

  function number(value, integer = true) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || integer && !Number.isSafeInteger(value)) throw new Error(invalidMessage);
    return value;
  }

  function text(value) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(invalidMessage);
    return value;
  }

  function metrics(value) {
    if (!value || typeof value !== 'object') throw new Error(invalidMessage);
    return { llmCalls: number(value.llmCalls), toolCalls: number(value.toolCalls), tokens: number(value.tokens), seconds: number(value.seconds, false) };
  }

  function shareData(value, type) {
    if (!value || typeof value !== 'object' || value.v !== 1 || value.type && value.type !== type) throw new Error(invalidMessage);
    if (type === 'compare') {
      if (!Array.isArray(value.dshOnly) || value.dshOnly.length > 8) throw new Error(invalidMessage);
      const pi = metrics(value.pi);
      return { v: 1, type, model: text(value.model), pi: { capabilities: number(value.pi.capabilities), ...pi }, dsh: metrics(value.dsh), dshOnly: value.dshOnly.map((name) => {
        const label = text(name);
        if ([...label].length > 12) throw new Error(invalidMessage);
        return label;
      }) };
    }
    if (type === 'achievement') {
      const unlocked = number(value.unlocked);
      const total = number(value.total);
      if (!total || unlocked > total) throw new Error(invalidMessage);
      return { v: 1, type, id: text(value.id), name: text(value.name), unlocked, total };
    }
    throw new Error(invalidMessage);
  }

  function parseJson(json, type) {
    if (new TextEncoder().encode(json).length > 4096) throw new Error('分享数据超过 4 KB，请回到 BuildMe 重新分享。');
    return shareData(JSON.parse(json), type);
  }

  function decode(fragment, type) {
    if (fragment.length > 5464 || !/^[A-Za-z0-9_-]+={0,2}$/.test(fragment)) throw new Error(invalidMessage);
    const binary = atob(fragment.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.length > 4096) throw new Error('分享数据超过 4 KB，请回到 BuildMe 重新分享。');
    return parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), type);
  }

  function encode(data) {
    const payload = { ...data };
    delete payload.type;
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function progress(value, max, label, className = '') {
    const bar = node('progress', className);
    bar.max = max;
    bar.value = value;
    bar.setAttribute('aria-label', label);
    return bar;
  }

  function renderCard(data) {
    const card = node('section', `share-card ${data.type === 'compare' ? 'compare-share' : 'achievement-share'}`);
    card.dataset.shareType = data.type;
    card.setAttribute('aria-label', data.type === 'compare' ? 'Agent 对比分享' : '成就分享');
    if (data.type === 'achievement') {
      const brick = node('div', 'achievement-brick');
      brick.setAttribute('aria-hidden', 'true');
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('class', 'icon');
      icon.setAttribute('width', '18');
      icon.setAttribute('height', '18');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', document.querySelector('.brand-mark use').getAttribute('href'));
      icon.append(use);
      brick.append(icon);
      const copy = node('div', 'achievement-copy');
      const count = node('p');
      const value = node('strong', '', format.format(data.unlocked));
      value.append(node('span', '', ` / ${format.format(data.total)}`));
      count.append('已解锁 ', value, ' 项成就');
      copy.append(node('span', 'share-eyebrow', '解锁一块新积木'), node('h3', '', data.name), count, progress(data.unlocked, data.total, `已解锁 ${data.unlocked} 项，共 ${data.total} 项成就`, 'achievement-progress'));
      card.append(brick, copy);
      return card;
    }
    const heading = node('div', 'share-card-heading');
    const title = node('div');
    title.append(node('span', 'share-eyebrow', '同一个任务，两种 Agent'), node('h3', '', 'Token 用量对比'));
    heading.append(title, node('span', 'share-model', data.model));
    const chart = node('div', 'share-token-chart');
    const max = Math.max(data.pi.tokens, data.dsh.tokens, 1);
    for (const [key, label] of [['pi', '我的 Agent'], ['dsh', '完全体']]) {
      const row = node('div', `share-token-row is-${key}`);
      const caption = node('div', 'share-token-label');
      const name = node('span', '', label);
      if (key === 'pi') name.append(node('small', '', `${data.pi.capabilities} 项能力`));
      const value = node('strong', '', format.format(data[key].tokens));
      value.append(node('small', '', ' tokens'));
      caption.append(name, value);
      row.append(caption, progress(data[key].tokens, max, `${label}：${data[key].tokens} tokens`));
      chart.append(row);
    }
    const stats = node('dl', 'share-metrics');
    for (const [key, label, suffix] of [['llmCalls', '模型调用', '次'], ['toolCalls', '工具调用', '次'], ['seconds', '耗时', '秒']]) {
      const item = node('div');
      const values = node('dd');
      const pi = node('span', '', format.format(data.pi[key]));
      pi.setAttribute('aria-label', `我的 Agent ${data.pi[key]} ${suffix}`);
      const dsh = node('span', '', format.format(data.dsh[key]));
      dsh.setAttribute('aria-label', `完全体 ${data.dsh[key]} ${suffix}`);
      const divider = node('span', 'share-metric-divider', '/');
      divider.setAttribute('aria-hidden', 'true');
      values.append(pi, divider, dsh, node('small', '', suffix));
      item.append(node('dt', '', label), values);
      stats.append(item);
    }
    card.append(heading, chart, stats, node('p', 'share-metric-key', '数值顺序：我的 Agent / 完全体'));
    if (data.dshOnly.length) {
      const capabilities = node('div', 'share-capabilities');
      const tags = node('div');
      for (const name of data.dshOnly) tags.append(node('span', 'share-capability', name));
      capabilities.append(node('span', '', '完全体多了'), tags);
      card.append(capabilities);
    }
    return card;
  }

  function renderPreview() {
    if (!preview) {
      preview = node('div', 'share-editor-preview');
      preview.dataset.sharePreview = '';
      field.after(preview);
    }
    preview.replaceChildren();
    preview.hidden = !field.value;
    if (!field.value) return;
    try {
      const value = JSON.parse(field.value);
      const data = shareData(value, value.type);
      const actions = node('div', 'share-editor-actions');
      const remove = node('button', 'button', '移除分享卡片');
      remove.type = 'button';
      remove.addEventListener('click', () => {
        field.value = '';
        field.dispatchEvent(new Event('input', { bubbles: true }));
        notice('分享卡片已移除，可以继续编辑正文。');
      });
      actions.append(remove);
      preview.append(renderCard(data), actions);
    } catch {
      notice(invalidMessage, true);
    }
  }

  function clearFragment() {
    history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  }

  if (field) {
    field.addEventListener('input', renderPreview);
    document.addEventListener('community:share-restored', renderPreview);
    document.addEventListener('community:work-restored', renderPreview);
    renderPreview();
  }

  const type = new URLSearchParams(location.search).get('type');
  if (location.pathname === '/new' && ['compare', 'achievement'].includes(type) && location.hash.length > 1) {
    let data;
    try {
      data = decode(location.hash.slice(1), type);
    } catch {
      notice(invalidMessage, true);
      clearFragment();
      return;
    }
    if (!form) {
      try {
        sessionStorage.setItem(pendingKey, JSON.stringify(data));
        clearFragment();
        notice('分享数据已暂存。登录后会回到发帖页，补充几句话即可发布。');
      } catch {
        notice('浏览器无法暂存分享数据。请先登录，再回到 BuildMe 重新分享。', true);
      }
      return;
    }
    field.value = JSON.stringify(data);
    const title = form.querySelector('input[name="title"]');
    if (!title.value) title.value = data.type === 'compare' ? `${data.model}：我的 Agent 与完全体的对比` : `解锁「${data.name}」：已完成 ${data.unlocked}/${data.total} 项成就`;
    const category = form.querySelector('select[name="category"]');
    category.value = '1';
    category.dispatchEvent(new Event('change', { bubbles: true }));
    field.dispatchEvent(new Event('input', { bubbles: true }));
    clearFragment();
    try {
      sessionStorage.removeItem(pendingKey);
      notice('分享卡片已带入。补充这次尝试的背景和收获，然后发布。');
    } catch {
      notice('分享卡片已带入，但浏览器无法清除暂存数据。发布后请关闭此标签页。', true);
    }
    return;
  }

  if (location.pathname === '/latest' && document.querySelector('[data-unread-count]')) {
    try {
      const saved = sessionStorage.getItem(pendingKey);
      if (!saved) return;
      const value = JSON.parse(saved);
      const data = parseJson(saved, value.type);
      location.replace(`/new?type=${data.type}#${encode(data)}`);
    } catch {
      notice('暂存的分享数据无法恢复，请回到 BuildMe 重新分享。', true);
    }
  }
})();
