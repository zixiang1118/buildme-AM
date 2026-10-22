const pendingInteractions = new WeakSet();

function discussionStatus(message, error = false) {
  let status = document.querySelector('#discussion-status');
  if (!status) {
    status = document.createElement('p');
    status.id = 'discussion-status';
    status.className = 'notice';
    document.querySelector('.page').prepend(status);
  }
  status.hidden = !message;
  status.textContent = message;
  status.setAttribute('role', error ? 'alert' : 'status');
  status.classList.toggle('error', error);
}

async function interactionRequest(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { Accept: 'application/json' },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作未完成，请稍后重试。');
  return result;
}

function serverFragment(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

function interactionState(form, active, count) {
  form.elements.namedItem('active').value = active ? '0' : '1';
  form.classList.toggle('active', active);
  form.classList.toggle('on', active);
  const button = form.querySelector('button:not([type]), button[type="submit"]');
  button.setAttribute('aria-pressed', String(active));
  const action = form.dataset.interaction === 'bookmark' ? '收藏' : '点赞';
  button.setAttribute('aria-label', active ? `取消${action}` : action);
  for (const number of form.querySelectorAll('[data-count]')) number.textContent = String(count);
  const label = form.querySelector('[data-interaction-label]');
  if (label) label.textContent = active ? button.dataset.activeLabel || `取消${action}` : button.dataset.inactiveLabel || action;
  else if (button.dataset.activeLabel) button.textContent = active ? button.dataset.activeLabel : button.dataset.inactiveLabel;
}

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('form[data-interaction], form[data-reaction]');
  if (!form) return;
  event.preventDefault();
  const lock = form.hasAttribute('data-reaction') ? form.closest('[data-reactions]') : form;
  if (pendingInteractions.has(lock)) return;
  pendingInteractions.add(lock);
  const data = new FormData(form, event.submitter);
  const buttons = [...lock.querySelectorAll('button:not([type]), button[type="submit"]')].map((button) => ({ button, disabled: button.disabled }));
  for (const { button } of buttons) button.disabled = true;
  form.setAttribute('aria-busy', 'true');
  try {
    const result = await interactionRequest(form.action, { method: 'POST', body: data });
    if (form.hasAttribute('data-reaction')) {
      const container = form.closest('[data-reactions]');
      const replacement = serverFragment(result.html);
      const nextContainer = replacement.querySelector('[data-reactions]');
      const emoji = form.elements.namedItem('emoji').value;
      container.replaceWith(replacement);
      const nextForm = [...nextContainer.querySelectorAll('form[data-reaction]')].find((item) => item.elements.namedItem('emoji').value === emoji);
      nextForm?.querySelector('button:not([type]), button[type="submit"]').focus({ preventScroll: true });
      document.dispatchEvent(new Event('community:content-updated'));
    } else {
      for (const matching of document.querySelectorAll('form[data-interaction]')) {
        if (matching.action === form.action && matching.dataset.interaction === form.dataset.interaction) interactionState(matching, result.active, result.count);
      }
    }
    discussionStatus('');
  } catch (error) {
    discussionStatus(error.message, true);
  } finally {
    pendingInteractions.delete(lock);
    form.removeAttribute('aria-busy');
    for (const { button, disabled } of buttons) button.disabled = disabled;
  }
});

const discussion = document.querySelector('[data-discussion]');

if (discussion) {
  const postId = discussion.dataset.postId;
  const replyPages = document.querySelector('#reply-pages');
  const replyForm = document.querySelector('#reply-form');
  const replyBody = replyForm?.querySelector('textarea[name="body"]');
  const replyTarget = document.querySelector('#reply-target');
  const quoteButton = document.querySelector('#reply-quote');
  const slider = discussion.querySelector('[data-floor-slider]');
  const floorPosition = discussion.querySelector('[data-floor-position]');
  const moreReplies = discussion.querySelector('[data-more-replies]');
  const observedReplies = new WeakSet();
  const loadedFloors = new Set([...replyPages.querySelectorAll(':scope > [data-floor]')].map((reply) => Number(reply.dataset.floor)));
  const pageRequests = new Map();
  const loadedPages = new Map();
  let maxFloor = Number(discussion.dataset.maxFloor);
  let nextFrom = Math.max(0, ...loadedFloors) + 1;
  let loadingMore = false;
  let autoLoadStopped = false;
  let jumping = false;
  let changingSlider = false;
  let selectedQuote;
  let currentFloor = Math.min(...loadedFloors);
  if (!loadedFloors.size) currentFloor = 0;

  function updateFloorPosition(floor) {
    currentFloor = floor;
    if (floorPosition) floorPosition.textContent = `${floor} / ${maxFloor}`;
    if (slider && !changingSlider) slider.value = String(floor);
  }

  function updateMoreReplies() {
    if (!moreReplies) return;
    moreReplies.hidden = !nextFrom || nextFrom > maxFloor;
    moreReplies.setAttribute('aria-busy', String(loadingMore));
    moreReplies.setAttribute('aria-disabled', String(loadingMore));
    moreReplies.textContent = loadingMore ? '正在加载回复…' : autoLoadStopped ? '加载失败，点击重试' : '加载更多回复';
    if (moreReplies instanceof HTMLAnchorElement && nextFrom) {
      const url = new URL(moreReplies.href);
      url.searchParams.set('page', String(Math.floor((nextFrom - 1) / 30) + 1));
      moreReplies.href = url.href;
    }
  }

  const floorObserver = new IntersectionObserver((entries) => {
    if (jumping || changingSlider) return;
    const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => Math.abs(a.boundingClientRect.top - innerHeight * 0.2) - Math.abs(b.boundingClientRect.top - innerHeight * 0.2));
    if (visible.length) updateFloorPosition(Number(visible[0].target.dataset.floor));
  }, { rootMargin: '-15% 0px -65% 0px', threshold: 0 });

  function observeReplies() {
    for (const reply of replyPages.querySelectorAll(':scope > [data-floor]')) {
      loadedFloors.add(Number(reply.dataset.floor));
      if (observedReplies.has(reply)) continue;
      observedReplies.add(reply);
      floorObserver.observe(reply);
    }
  }

  async function loadReplyPage(from) {
    if (loadedPages.has(from)) {
      nextFrom = loadedPages.get(from);
      updateMoreReplies();
      return;
    }
    if (pageRequests.has(from)) return pageRequests.get(from);
    const request = (async () => {
      const result = await interactionRequest(`/p/${postId}/replies?from=${from}`);
      const fragment = serverFragment(result.html);
      for (const reply of [...fragment.children]) {
        const floor = Number(reply.dataset.floor);
        if (loadedFloors.has(floor)) continue;
        const following = [...replyPages.children].find((item) => Number(item.dataset.floor) > floor);
        if (following) replyPages.insertBefore(reply, following);
        else replyPages.append(reply);
        loadedFloors.add(floor);
      }
      loadedPages.set(from, result.nextFrom);
      maxFloor = result.maxFloor;
      discussion.dataset.maxFloor = String(maxFloor);
      if (slider) {
        slider.max = String(maxFloor || 1);
        slider.disabled = maxFloor === 0;
      }
      nextFrom = result.nextFrom;
      for (const count of discussion.querySelectorAll('[data-reply-total]')) count.textContent = String(result.total);
      updateFloorPosition(currentFloor);
      updateMoreReplies();
      document.dispatchEvent(new Event('community:content-updated'));
    })();
    pageRequests.set(from, request);
    try {
      await request;
    } finally {
      pageRequests.delete(from);
    }
  }

  async function loadMoreReplies() {
    if (loadingMore || !nextFrom || nextFrom > maxFloor) return;
    loadingMore = true;
    updateMoreReplies();
    try {
      await loadReplyPage(nextFrom);
      autoLoadStopped = false;
      discussionStatus('');
    } catch (error) {
      autoLoadStopped = true;
      discussionStatus(error.message, true);
    } finally {
      loadingMore = false;
      updateMoreReplies();
    }
  }

  const moreObserver = new IntersectionObserver((entries) => {
    if (!autoLoadStopped && !jumping && entries.some((entry) => entry.isIntersecting)) loadMoreReplies();
  }, { rootMargin: '320px 0px' });

  async function jumpToFloor(floor, updateHash = true) {
    if (!Number.isSafeInteger(floor) || floor < 1 || floor > maxFloor) {
      discussionStatus('这个楼层不存在。', true);
      return;
    }
    jumping = true;
    try {
      if (!loadedFloors.has(floor)) await loadReplyPage(Math.floor((floor - 1) / 30) * 30 + 1);
      const reply = document.getElementById(String(floor));
      if (!reply) {
        discussionStatus('这个楼层已删除或暂不可见。', true);
        return;
      }
      if (updateHash) {
        const url = new URL(location.href);
        url.hash = String(floor);
        history.replaceState(null, '', url);
      }
      reply.tabIndex = -1;
      reply.scrollIntoView({ block: 'start', behavior: 'instant' });
      reply.focus({ preventScroll: true });
      updateFloorPosition(floor);
      discussionStatus('');
    } catch (error) {
      discussionStatus(error.message, true);
    } finally {
      jumping = false;
    }
  }

  function jumpFromHash() {
    if (/^#\d+$/.test(location.hash)) jumpToFloor(Number(location.hash.slice(1)), false);
  }

  moreReplies?.addEventListener('click', (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    autoLoadStopped = false;
    loadMoreReplies();
  });
  slider?.addEventListener('input', () => {
    changingSlider = true;
    if (floorPosition) floorPosition.textContent = `${slider.value} / ${maxFloor}`;
  });
  slider?.addEventListener('change', () => {
    changingSlider = false;
    jumpToFloor(Number(slider.value));
  });
  slider?.addEventListener('blur', () => { changingSlider = false; });
  window.addEventListener('hashchange', jumpFromHash);

  function setReplyTarget(floor, username) {
    replyForm.elements.namedItem('parentFloor').value = String(floor);
    const text = document.createElement('span');
    text.textContent = `正在回复 #${floor}${username ? ` @${username}` : ''}`;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'button subtle';
    cancel.dataset.cancelReply = 'true';
    cancel.textContent = '取消回复对象';
    replyTarget.replaceChildren(text, cancel);
    replyTarget.hidden = false;
  }

  if (replyForm) {
    const parentFloor = replyForm.elements.namedItem('parentFloor').value;
    if (parentFloor) setReplyTarget(parentFloor);
    else replyTarget.hidden = true;
  }

  const pendingChildren = new WeakSet();
  document.addEventListener('click', async (event) => {
    if (event.target.closest('a') && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)) return;
    const copyFloor = event.target.closest('[data-copy-floor]');
    if (copyFloor) {
      event.preventDefault();
      try {
        await navigator.clipboard.writeText(copyFloor.href);
        discussionStatus('楼层链接已复制。');
      } catch {
        discussionStatus(`未能自动复制，请复制此地址：${copyFloor.href}`, true);
      }
      return;
    }
    const cancel = event.target.closest('[data-cancel-reply]');
    if (cancel && replyForm) {
      event.preventDefault();
      replyForm.elements.namedItem('parentFloor').value = '';
      replyTarget.hidden = true;
      replyBody.focus();
      return;
    }
    const respond = event.target.closest('[data-reply-to]');
    if (respond && replyForm) {
      event.preventDefault();
      setReplyTarget(respond.dataset.replyTo, respond.dataset.username);
      replyBody.focus();
      return;
    }
    const children = event.target.closest('[data-children]');
    if (children) {
      event.preventDefault();
      if (pendingChildren.has(children)) return;
      const list = children.closest('[data-floor]').querySelector('[data-child-list]');
      if (children.dataset.loaded === 'true') {
        list.hidden = !list.hidden;
        children.setAttribute('aria-expanded', String(!list.hidden));
        return;
      }
      pendingChildren.add(children);
      children.setAttribute('aria-busy', 'true');
      try {
        const result = await interactionRequest(`/p/${postId}/children/${children.dataset.children}`);
        list.replaceChildren(serverFragment(result.html));
        list.hidden = false;
        children.dataset.loaded = 'true';
        children.setAttribute('aria-expanded', 'true');
        document.dispatchEvent(new Event('community:content-updated'));
        discussionStatus('');
      } catch (error) {
        discussionStatus(error.message, true);
      } finally {
        pendingChildren.delete(children);
        children.removeAttribute('aria-busy');
      }
      return;
    }
    const anchor = event.target.closest('a[href]');
    if (!anchor || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || anchor.target === '_blank') return;
    const url = new URL(anchor.href);
    if (url.origin === location.origin && url.pathname === location.pathname && /^#\d+$/.test(url.hash)) {
      event.preventDefault();
      jumpToFloor(Number(url.hash.slice(1)));
    }
  });

  if (replyForm && quoteButton) {
    quoteButton.classList.add('quote-selection');
    document.addEventListener('selectionchange', () => {
      const selection = window.getSelection();
      if (!selection.rangeCount || selection.isCollapsed) {
        quoteButton.hidden = true;
        return;
      }
      const range = selection.getRangeAt(0);
      const start = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
      const prose = start.closest('.reply .prose');
      const text = selection.toString().trim();
      if (!prose || !prose.contains(range.endContainer) || !text) {
        quoteButton.hidden = true;
        return;
      }
      const reply = prose.closest('.reply');
      const replyTo = reply.querySelector('[data-reply-to]');
      selectedQuote = { text, floor: reply.dataset.floor || replyTo.dataset.replyTo, username: replyTo.dataset.username };
      quoteButton.hidden = false;
    });
    quoteButton.addEventListener('mousedown', (event) => event.preventDefault());
    quoteButton.addEventListener('click', (event) => {
      event.preventDefault();
      const { text, floor, username } = selectedQuote;
      const quote = `${replyBody.selectionStart ? '\n\n' : ''}${text.split('\n').map((line) => `> ${line}`).join('\n')}\n>\n> — [${username ? `@${username} · ` : ''}#${floor}](/p/${postId}#${floor})\n\n`;
      replyBody.setRangeText(quote, replyBody.selectionStart, replyBody.selectionEnd, 'end');
      setReplyTarget(floor, username);
      quoteButton.hidden = true;
      window.getSelection().removeAllRanges();
      replyBody.focus();
      replyBody.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  if (replyBody) {
    const mentionList = document.createElement('div');
    mentionList.id = 'reply-mentions';
    mentionList.className = 'mention-list';
    mentionList.hidden = true;
    mentionList.setAttribute('role', 'listbox');
    mentionList.setAttribute('aria-label', '选择要提及的用户');
    replyBody.after(mentionList);
    let mentionTimer;
    let mentionRequest;
    let mentionUsers = [];
    let mentionIndex = 0;
    let mentionRange;

    function closeMentions() {
      mentionList.hidden = true;
      mentionUsers = [];
      replyBody.removeAttribute('aria-activedescendant');
      replyBody.removeAttribute('aria-controls');
      replyBody.removeAttribute('aria-autocomplete');
    }

    function updateMentionSelection() {
      [...mentionList.children].forEach((button, index) => button.setAttribute('aria-selected', String(index === mentionIndex)));
      replyBody.setAttribute('aria-activedescendant', `mention-user-${mentionUsers[mentionIndex].id}`);
    }

    function selectMention(index) {
      const user = mentionUsers[index];
      replyBody.setRangeText(`@${user.username} `, ...mentionRange, 'end');
      closeMentions();
      replyBody.focus();
      replyBody.dispatchEvent(new Event('input', { bubbles: true }));
    }

    async function loadMentions(query, cursor, start) {
      mentionRequest = new AbortController();
      try {
        const result = await interactionRequest(`/api/users?q=${encodeURIComponent(query)}&post=${postId}`, { signal: mentionRequest.signal });
        if (replyBody.selectionStart !== cursor || replyBody.value.slice(start, cursor) !== `@${query}`) return;
        mentionUsers = result.users;
        if (!mentionUsers.length) return closeMentions();
        mentionRange = [start, cursor];
        mentionIndex = 0;
        mentionList.replaceChildren();
        mentionUsers.forEach((user, index) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.id = `mention-user-${user.id}`;
          button.textContent = `@${user.username}`;
          button.setAttribute('role', 'option');
          button.addEventListener('mousedown', (event) => event.preventDefault());
          button.addEventListener('click', () => selectMention(index));
          mentionList.append(button);
        });
        mentionList.hidden = false;
        replyBody.setAttribute('aria-controls', mentionList.id);
        replyBody.setAttribute('aria-autocomplete', 'list');
        updateMentionSelection();
      } catch (error) {
        if (error.name !== 'AbortError') discussionStatus(error.message, true);
      }
    }

    function scheduleMentions() {
      clearTimeout(mentionTimer);
      mentionRequest?.abort();
      closeMentions();
      if (replyBody.selectionStart !== replyBody.selectionEnd) return closeMentions();
      const cursor = replyBody.selectionStart;
      const match = replyBody.value.slice(0, cursor).match(/@([\p{L}\p{N}_]{0,16})$/u);
      if (!match) return closeMentions();
      mentionTimer = setTimeout(() => loadMentions(match[1], cursor, cursor - match[0].length), 200);
    }

    replyBody.addEventListener('input', (event) => { if (!event.isComposing) scheduleMentions(); });
    replyBody.addEventListener('compositionend', scheduleMentions);
    replyBody.addEventListener('click', scheduleMentions);
    replyBody.addEventListener('keydown', (event) => {
      if (event.isComposing || mentionList.hidden) return;
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Escape') return closeMentions();
      if (event.key === 'Enter') return selectMention(mentionIndex);
      mentionIndex = (mentionIndex + (event.key === 'ArrowDown' ? 1 : -1) + mentionUsers.length) % mentionUsers.length;
      updateMentionSelection();
    });
    document.addEventListener('click', (event) => {
      if (event.target !== replyBody && !mentionList.contains(event.target)) closeMentions();
    });
  }

  document.addEventListener('community:content-updated', observeReplies);
  observeReplies();
  updateFloorPosition(currentFloor);
  updateMoreReplies();
  jumpFromHash();
  if (moreReplies) moreObserver.observe(moreReplies);
}

const unreadCounter = document.querySelector('[data-unread-count]');
if (unreadCounter) {
  const baseTitle = document.title.replace(/^\(\d+\)\s*/, '');
  function updateUnread(unread) {
    for (const counter of document.querySelectorAll('[data-unread-count]')) {
      counter.textContent = String(unread);
      counter.hidden = unread === 0;
      counter.setAttribute('aria-label', `${unread} 条未读通知`);
    }
    document.title = unread > 0 ? `(${unread}) ${baseTitle}` : baseTitle;
  }
  updateUnread(Number(unreadCounter.textContent));
  setInterval(async () => {
    try {
      const result = await interactionRequest('/notifications/count');
      updateUnread(result.unread);
    } catch (error) {
      discussionStatus(error.message, true);
    }
  }, 60000);
}
