import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { URL } from "node:url";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { RESEARCH_MODULES } from "../desktop/platform-modules.mjs";

const code = await readFile(new URL("../desktop/renderer/platforms.js", import.meta.url), "utf8");

async function fixture(reducedMotion = false) {
  const { document, window } = parseHTML("<html><body><div class='app-shell'></div></body></html>");
  const animations = [];
  window.HTMLElement.prototype.focus = function () {};
  window.HTMLElement.prototype.animate = function (frames, options) {
    const animation = { cancel: vi.fn(), onfinish: null };
    animations.push({ node: this, frames, options, animation });
    return animation;
  };
  window.SVGElement.prototype.animate = window.HTMLElement.prototype.animate;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { top: this.parentNode ? [...this.parentNode.children].indexOf(this) * 54 : 0 };
  };
  window.matchMedia = () => ({ matches: reducedMotion });
  window.getComputedStyle = el => ({ transform: el.dataset.intermediate || el.getAttribute("transform"), opacity: el.dataset.intermediateOpacity || "1" });
  const state = { platforms: [], snapshot: null, activePlatformId: null, moduleCatalog: RESEARCH_MODULES };
  vm.runInNewContext(code, { window, document, JSON, Math, Number, String, Object, Map, Set, Date });
  const ui = window.createPlatforms({ platformState: async () => state }); await ui.open(state);
  const toggle = id => document.querySelector(`.platform-module-card[data-module-id="${id}"]`).click();
  const block = id => document.querySelector(`.platform-assembly-block[data-module-id="${id}"]`);
  const row = id => document.querySelector(`.platform-assembly-item[data-module-id="${id}"]`);
  const selected = () => [...document.querySelectorAll(".platform-assembly-item")].map(el => el.dataset.moduleId);
  const drag = (type, node) => {
    const event = new window.Event(type, { cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { setData: vi.fn() } });
    node.dispatchEvent(event); return event;
  };
  return { document, toggle, block, row, selected, animations, drag };
}

describe("continuous research brick assembly", () => {
  it("keeps existing bricks and cards alive and continues from an interrupted animation", async () => {
    const f = await fixture(); f.toggle("datasets");
    const svg = f.document.querySelector(".platform-assembly-svg"), first = f.block("datasets"), tile = f.document.querySelector('[data-module-id="datasets"].platform-module-card');
    first.dataset.intermediate = "matrix(1, 0, 0, 1, 210, 142)";
    first.dataset.intermediateOpacity = "0.4";
    f.toggle("analysis");
    expect(f.document.querySelector(".platform-assembly-svg")).toBe(svg);
    expect(f.block("datasets")).toBe(first);
    expect(f.document.querySelector('[data-module-id="datasets"].platform-module-card')).toBe(tile);
    expect(f.animations.filter(a => a.node === first).at(-1).frames[0].transform).toBe("matrix(1, 0, 0, 1, 210, 142)");
    expect(f.animations.filter(a => a.node === first).at(-1).frames[0].opacity).toBe("0.4");
    expect(f.selected()).toEqual(["datasets", "analysis"]);
    f.toggle("analysis");
    expect(f.selected()).toEqual(["datasets"]);
    const removal = f.animations.filter(a => a.node.dataset.leaving === "true").at(-1);
    expect(removal.node.getAttribute("aria-hidden")).toBe("true");
    expect(removal.node.getAttribute("tabindex")).toBe("-1");
    removal.animation.onfinish();
    expect(f.block("analysis")).toBeNull();
    expect(f.block("datasets")).toBe(first);
  });

  it("reorders dragged bricks while retaining the same canvas and keyboard controls", async () => {
    const f = await fixture(); for (const id of ["datasets", "analysis", "writing"]) f.toggle(id);
    const first = f.block("datasets");
    f.drag("dragstart", f.row("datasets"));
    expect(f.drag("dragover", f.row("writing")).defaultPrevented).toBe(true);
    f.drag("drop", f.row("writing"));
    expect(f.selected()).toEqual(["analysis", "writing", "datasets"]);
    expect(f.block("datasets")).toBe(first);
    f.document.querySelector('button[aria-label="上移数据集管理"]').click();
    expect(f.selected()).toEqual(["analysis", "datasets", "writing"]);
    expect(f.document.querySelector('[role="status"].sr-only').textContent).toContain("第 2 块");
  });

  it("updates immediately without animations when reduced motion is enabled", async () => {
    const f = await fixture(true); f.toggle("datasets"); f.toggle("analysis"); f.toggle("datasets");
    expect(f.selected()).toEqual(["analysis"]);
    expect(f.block("datasets")).toBeNull();
    expect(f.animations).toHaveLength(0);
  });
});
