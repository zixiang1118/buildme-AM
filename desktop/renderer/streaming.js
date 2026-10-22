(() => {
  window.renderStreamText = (element, text) => {
    if (element.textContent === text) return;
    const node = element.firstChild;
    if (node?.nodeType === 3 && !node.nextSibling && text.startsWith(node.nodeValue)) node.appendData(text.slice(node.nodeValue.length));
    else element.textContent = text;
  };

  // Coalesce provider deltas before parsing Markdown and touching layout. Long
  // answers get a little more time between paints; completion always flushes.
  window.createStreamBatcher = (render, { size = () => 0 } = {}) => {
    let frame, timer, dirty = false, lastPaint = -Infinity;
    const clear = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
      frame = timer = undefined;
    };
    const paint = () => {
      clear();
      if (!dirty) return;
      dirty = false;
      lastPaint = performance.now();
      render();
    };
    return {
      schedule() {
        dirty = true;
        if (frame !== undefined || timer !== undefined) return;
        const interval = Math.min(160, 64 + Math.floor(size() / 16384) * 16);
        const delay = Math.max(0, interval - (performance.now() - lastPaint));
        const queue = () => { timer = undefined; frame = requestAnimationFrame(paint); };
        if (delay) timer = setTimeout(queue, delay);
        else queue();
      },
      flush: paint,
      cancel() { clear(); dirty = false; lastPaint = -Infinity; },
    };
  };

  window.createChatScroller = (element) => {
    const bottomDistance = () => element.scrollHeight - element.scrollTop - element.clientHeight;
    const atBottom = () => bottomDistance() < 64;
    let following = atBottom(), lastTop = element.scrollTop, frame;
    const cancel = () => { if (frame !== undefined) cancelAnimationFrame(frame); frame = undefined; };
    const pause = () => { following = false; cancel(); };
    const scroll = () => {
      const top = element.scrollTop;
      // Content growth can emit a scroll event too. Only movement up detaches
      // an existing follower; reaching the bottom resumes a detached reader.
      // A shrinking block/session clamps scrollTop to its new maximum. That
      // browser adjustment should not cancel a follower's pending bottom paint.
      if (top < lastTop - 1) { if (!following || bottomDistance() > 1) pause(); }
      else if (!following && top > lastTop + 1 && atBottom()) following = true;
      lastTop = top;
    };
    const consumedInside = event => {
      if (event.defaultPrevented) return true;
      for (let node = event.target; node && node !== element; node = node.parentElement) {
        if (node.scrollTop > 0 && node.scrollHeight > node.clientHeight) return true;
      }
      return false;
    };
    const wheel = event => { if (event.deltaY < 0 && !consumedInside(event)) pause(); };
    const key = event => { if (["ArrowUp", "PageUp", "Home"].includes(event.key) && !consumedInside(event)) pause(); };
    const queue = () => {
      if (!following || frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (!following) return;
        element.scrollTop = element.scrollHeight;
        lastTop = element.scrollTop;
      });
    };
    element.addEventListener("scroll", scroll, { passive: true });
    element.addEventListener("wheel", wheel, { passive: true });
    element.addEventListener("keydown", key);
    return {
      follow: queue,
      isFollowing: () => following,
      pin() { following = true; queue(); },
      reset() { cancel(); following = true; lastTop = element.scrollTop; },
      restore(top, shouldFollow) {
        cancel(); element.scrollTop = top; lastTop = element.scrollTop; following = shouldFollow;
        queue();
      },
      dispose() {
        cancel();
        element.removeEventListener("scroll", scroll);
        element.removeEventListener("wheel", wheel);
        element.removeEventListener("keydown", key);
      },
    };
  };
})();
