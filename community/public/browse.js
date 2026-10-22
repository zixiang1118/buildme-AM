const mobileButton = document.querySelector('[data-mobile-menu]');
const mobileNavigation = document.querySelector('#mobile-navigation');

function setMobileMenu(open) {
  if (!mobileButton || !mobileNavigation) return;
  mobileButton.setAttribute('aria-expanded', String(open));
  mobileNavigation.classList.toggle('is-open', open);
}

mobileButton?.addEventListener('click', () => setMobileMenu(mobileButton.getAttribute('aria-expanded') !== 'true'));
document.addEventListener('click', (event) => {
  if (mobileButton && matchMedia('(max-width: 760px)').matches && !mobileButton.contains(event.target) && !mobileNavigation.contains(event.target)) setMobileMenu(false);
});
document.addEventListener('keydown', (event) => {
  if (!event.defaultPrevented && event.key === 'Escape' && mobileButton?.getAttribute('aria-expanded') === 'true') {
    setMobileMenu(false);
    mobileButton.focus();
  }
});
document.documentElement.classList.add('browse-ready');

const searchInput = document.querySelector('[data-search-input]');
const searchSuggestions = document.querySelector('#search-suggestions');

if (searchInput && searchSuggestions) {
  const searchFeedback = document.createElement('p');
  searchFeedback.className = 'search-feedback';
  searchFeedback.setAttribute('role', 'status');
  searchFeedback.hidden = true;
  searchSuggestions.after(searchFeedback);
  let searchTimer;
  let searchRequest;
  let searchItems = [];
  let selectedSearch = -1;

  function closeSearchSuggestions() {
    searchSuggestions.hidden = true;
    searchItems = [];
    selectedSearch = -1;
    searchInput.setAttribute('aria-expanded', 'false');
    searchInput.removeAttribute('aria-activedescendant');
  }

  function updateSelectedSearch() {
    [...searchSuggestions.children].forEach((item, index) => item.setAttribute('aria-selected', String(index === selectedSearch)));
    if (selectedSearch >= 0) searchInput.setAttribute('aria-activedescendant', `search-suggestion-${selectedSearch}`);
    else searchInput.removeAttribute('aria-activedescendant');
  }

  async function suggestSearch(query) {
    searchRequest = new AbortController();
    try {
      const response = await fetch(`/search/suggest?q=${encodeURIComponent(query)}`, { headers: { Accept: 'application/json' }, signal: searchRequest.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '即时搜索暂时不可用，可以按回车打开搜索结果。');
      if (searchInput.value.trim() !== query) return;
      searchItems = result.items.slice(0, 6);
      if (!searchItems.length) return closeSearchSuggestions();
      selectedSearch = -1;
      searchSuggestions.replaceChildren();
      searchItems.forEach((item, index) => {
        const anchor = document.createElement('a');
        anchor.id = `search-suggestion-${index}`;
        anchor.href = item.href;
        anchor.textContent = item.title;
        anchor.setAttribute('role', 'option');
        anchor.setAttribute('aria-selected', 'false');
        searchSuggestions.append(anchor);
      });
      searchSuggestions.hidden = false;
      searchInput.setAttribute('aria-expanded', 'true');
    } catch (error) {
      if (error.name === 'AbortError') return;
      searchFeedback.textContent = error.message;
      searchFeedback.hidden = false;
    }
  }

  function scheduleSearch() {
    clearTimeout(searchTimer);
    searchRequest?.abort();
    closeSearchSuggestions();
    searchFeedback.hidden = true;
    const query = searchInput.value.trim();
    if (!query) return;
    searchTimer = setTimeout(() => suggestSearch(query), 200);
  }

  searchInput.setAttribute('role', 'combobox');
  searchInput.setAttribute('aria-autocomplete', 'list');
  searchInput.setAttribute('aria-controls', searchSuggestions.id);
  searchInput.setAttribute('aria-expanded', 'false');
  searchInput.addEventListener('input', (event) => { if (!event.isComposing) scheduleSearch(); });
  searchInput.addEventListener('compositionend', scheduleSearch);
  searchInput.addEventListener('keydown', (event) => {
    if (event.isComposing || searchSuggestions.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSearchSuggestions();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      selectedSearch = (selectedSearch + (event.key === 'ArrowDown' ? 1 : -1) + searchItems.length) % searchItems.length;
      updateSelectedSearch();
    } else if (event.key === 'Enter' && selectedSearch >= 0) {
      event.preventDefault();
      location.assign(searchItems[selectedSearch].href);
    }
  });
  searchInput.form.addEventListener('submit', () => {
    clearTimeout(searchTimer);
    searchRequest?.abort();
  });
  document.addEventListener('click', (event) => {
    if (!searchInput.contains(event.target) && !searchSuggestions.contains(event.target)) {
      closeSearchSuggestions();
      searchFeedback.hidden = true;
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();
    if (matchMedia('(max-width: 760px)').matches && mobileNavigation?.contains(searchInput)) setMobileMenu(true);
    searchInput.focus();
  });
  closeSearchSuggestions();
}

const morePosts = document.querySelector('[data-more-posts]');
if (morePosts) {
  const postList = document.querySelector('#post-list');
  const browseStatus = document.querySelector('#browse-status');
  const seenPosts = new Set([...postList.querySelectorAll('.post-card[id]')].map((post) => post.id));
  let loadingPosts = false;
  let automaticLoading = true;

  async function loadPosts() {
    if (loadingPosts || morePosts.hidden) return;
    loadingPosts = true;
    morePosts.setAttribute('aria-busy', 'true');
    morePosts.setAttribute('aria-disabled', 'true');
    morePosts.textContent = '正在加载…';
    browseStatus.textContent = '';
    try {
      const response = await fetch(morePosts.href, { headers: { Accept: 'application/json' } });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '帖子未加载成功，请点击重试。');
      for (const post of postList.querySelectorAll('.post-card[id]')) seenPosts.add(post.id);
      const template = document.createElement('template');
      template.innerHTML = result.html;
      let added = 0;
      for (const post of [...template.content.children]) {
        if (seenPosts.has(post.id)) continue;
        seenPosts.add(post.id);
        postList.append(post);
        added += 1;
      }
      if (added) postList.querySelector('.empty')?.remove();
      if (result.next) morePosts.href = result.next;
      else { morePosts.hidden = true; postObserver.unobserve(morePosts); }
      automaticLoading = true;
      browseStatus.classList.remove('field-error');
      browseStatus.textContent = result.next ? `已加载 ${added} 条帖子` : '已经看到最后一页了';
      document.dispatchEvent(new Event('community:content-updated'));
    } catch (error) {
      automaticLoading = false;
      browseStatus.classList.add('field-error');
      browseStatus.textContent = error.message;
    } finally {
      loadingPosts = false;
      morePosts.removeAttribute('aria-busy');
      morePosts.removeAttribute('aria-disabled');
      morePosts.textContent = automaticLoading ? '加载更多帖子' : '加载失败，点击重试';
    }
  }

  const postObserver = new IntersectionObserver((entries) => {
    if (automaticLoading && entries.some((entry) => entry.isIntersecting)) loadPosts();
  }, { rootMargin: '320px 0px' });
  morePosts.addEventListener('click', (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    loadPosts();
  });
  postObserver.observe(morePosts);
}
