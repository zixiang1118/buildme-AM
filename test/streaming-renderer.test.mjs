import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";

const source = await readFile(new URL("../desktop/renderer/streaming.js", import.meta.url), "utf8");
function fixture() {
  let time = 0, id = 0;
  const frames = new Map(), timers = new Map(), listeners = new Map();
  const element = {
    clientHeight: 200, scrollHeight: 1000, scrollTop: 800,
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: name => listeners.delete(name),
  };
  const context = vm.createContext({
    window: {}, performance: { now: () => time },
    requestAnimationFrame: callback => { frames.set(++id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: (callback, delay) => { timers.set(++id, { callback, due: time + delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(source, context);
  return {
    ...context.window, element,
    emit: (type, event = {}) => listeners.get(type)?.(event),
    frame(ms = 16) {
      time += ms;
      for (const [id, timer] of [...timers]) if (timer.due <= time) { timers.delete(id); timer.callback(); }
      const pending = [...frames]; frames.clear();
      for (const [, callback] of pending) callback(time);
    },
    pending: () => frames.size + timers.size,
  };
}

describe("stream paint scheduling", () => {
  it("keeps the reasoning text node when unchanged or extended", () => {
    const f = fixture(), element = parseHTML("<div></div>").document.firstChild;
    f.renderStreamText(element, "思考内容"); const text = element.firstChild;
    f.renderStreamText(element, "思考内容"); expect(element.firstChild).toBe(text);
    f.renderStreamText(element, "思考内容继续"); expect(element.firstChild).toBe(text);
    expect(text.nodeValue).toBe("思考内容继续");
    f.renderStreamText(element, "重新思考"); expect(element.textContent).toBe("重新思考");
  });
  it("limits many deltas to one paint per interval and slows the cadence for longer text", () => {
    const f = fixture(), render = vi.fn(); let size = 0;
    const batch = f.createStreamBatcher(render, { size: () => size });
    for (let i = 0; i < 1000; i++) batch.schedule();
    expect(render).not.toHaveBeenCalled(); f.frame(); expect(render).toHaveBeenCalledOnce();
    batch.schedule(); f.frame(32); expect(render).toHaveBeenCalledOnce();
    f.frame(32); expect(render).toHaveBeenCalledTimes(2);
    size = 200000; batch.schedule(); f.frame(128); expect(render).toHaveBeenCalledTimes(2);
    f.frame(32); expect(render).toHaveBeenCalledTimes(3);
  });

  it("flushes without RAF, cancels stale work, and lets the next run paint promptly", () => {
    const f = fixture(), render = vi.fn(), batch = f.createStreamBatcher(render);
    batch.schedule(); batch.flush(); expect(render).toHaveBeenCalledOnce();
    expect(f.pending()).toBe(0); batch.flush(); expect(render).toHaveBeenCalledOnce();
    batch.schedule(); batch.cancel(); f.frame(200); expect(render).toHaveBeenCalledOnce();
    batch.schedule(); f.frame(); expect(render).toHaveBeenCalledTimes(2);
  });
});

describe("stream following", () => {
  it("coalesces layout reads and stops a queued jump immediately on upward wheel or key input", () => {
    const f = fixture(), scroller = f.createChatScroller(f.element);
    f.element.scrollHeight = 2000;
    scroller.follow(); scroller.follow(); expect(f.pending()).toBe(1);
    f.emit("wheel", { deltaY: -10 }); f.frame(); expect(f.element.scrollTop).toBe(800);
    scroller.follow(); expect(f.pending()).toBe(0);
    f.element.scrollTop = 1800; f.emit("scroll");
    scroller.follow(); f.frame(); expect(f.element.scrollTop).toBe(2000);
    scroller.follow(); f.emit("keydown", { key: "PageUp" }); f.frame();
    expect(f.pending()).toBe(0);
  });

  it("ignores content growth but respects scrollbar movement and explicit history restoration", () => {
    const f = fixture(), scroller = f.createChatScroller(f.element);
    f.element.scrollHeight = 2000; f.emit("scroll");
    scroller.follow(); f.frame(); expect(f.element.scrollTop).toBe(2000);
    f.element.scrollTop = 100; f.emit("scroll"); scroller.follow(); f.frame();
    expect(f.element.scrollTop).toBe(100);
    scroller.restore(200, false); scroller.follow(); f.frame(); expect(f.element.scrollTop).toBe(200);
    scroller.pin(); f.frame(); expect(f.element.scrollTop).toBe(2000);
    scroller.follow(); scroller.dispose(); expect(f.pending()).toBe(0);
  });

  it("keeps following when content shrink clamps the browser scroll offset", () => {
    const f = fixture(), scroller = f.createChatScroller(f.element);
    f.element.scrollHeight = 500; f.element.scrollTop = 300;
    scroller.pin(); f.emit("scroll"); f.frame();
    expect(f.element.scrollTop).toBe(500);
    // A real upward move above the new bottom still detaches.
    f.element.scrollTop = 250; f.emit("scroll"); scroller.follow(); f.frame();
    expect(f.element.scrollTop).toBe(250);
  });

  it("lets an inner reasoning pane consume upward scrolling without detaching the chat", () => {
    const f = fixture(), scroller = f.createChatScroller(f.element);
    const inner = { scrollTop: 80, scrollHeight: 800, clientHeight: 200, parentElement: f.element };
    scroller.follow(); f.emit("wheel", { deltaY: -20, target: inner });
    expect(scroller.isFollowing()).toBe(true); f.frame();
    inner.scrollTop = 0; f.emit("wheel", { deltaY: -20, target: inner });
    expect(scroller.isFollowing()).toBe(false);
    f.emit("scroll"); expect(scroller.isFollowing()).toBe(false);
  });
});
