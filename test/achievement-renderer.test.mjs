import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACHIEVEMENTS } from "../src/core/achievements.ts";
const html = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
const source = await readFile(new URL("../desktop/renderer/achievements.js", import.meta.url), "utf8");
function fixture(unlocks = []) {
  const { window, document } = parseHTML(html);
  window.communityAvailable = () => true;
  window.shareToCommunity = vi.fn(async () => undefined);
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const dialog = document.querySelector("#achievements-dialog"); dialog.showModal = () => { dialog.open = true; }; dialog.close = () => { dialog.open = false; };
  let notify;
  const api = {
    achievements: vi.fn(async () => ({ definitions: ACHIEVEMENTS, achievements: unlocks })),
    onAchievements: (listener) => { notify = listener; },
    xrayTurn: vi.fn(async (id) => id === "missing" ? undefined : { id }),
    exportLearning: vi.fn(async () => ({ cancelled: false })),
    learningEvent: vi.fn(async () => ({ accepted: true })),
  };
  vm.runInContext(source, vm.createContext({ window, document, setTimeout: globalThis.setTimeout }));
  const onTurn = vi.fn(async () => undefined); const page = window.createAchievements(api, { onTurn });
  return { page, api, onTurn, window, document, notify: (items) => notify(items), $: (s) => document.querySelector(s) };
}
afterEach(() => vi.useRealTimers());
describe("成就界面", () => {
  it("shows locked hints, exact source turns, missing history and events without a turn", async () => {
    const at = "2026-10-05T00:00:00Z";
    const f = fixture([{ id: "first-turn", at, turnId: "source" }, { id: "first-tool", at, turnId: "missing" }, { id: "xray-open", at }]);
    await f.page.open();
    expect(f.document.querySelectorAll(".achievement-card")).toHaveLength(30);
    f.$('.achievement-item .secondary-button').click();
    expect(f.window.shareToCommunity).toHaveBeenCalledWith('achievement','first-turn');
    expect(f.$("#achievement-count").textContent).toBe("已解锁 3 / 30");
    expect(f.$('[data-achievement="explain-20"]').textContent).toContain("???");
    f.$('[data-achievement="xray-open"]').click(); expect(f.$("#achievement-status").textContent).toContain("没有关联");
    f.$('[data-achievement="first-tool"]').click();
    await vi.waitFor(() => expect(f.$("#achievement-status").textContent).toContain("历史已被清理"));
    expect(f.onTurn).not.toHaveBeenCalled();
    f.$('[data-achievement="first-turn"]').click();
    await vi.waitFor(() => expect(f.onTurn).toHaveBeenCalledWith({ id: "source" }));
    expect(f.$("#achievements-dialog").open).toBe(false);
  });
  it("queues three notifications with 3s visibility and 1s gaps, then merges the rest without duplicates", async () => {
    vi.useFakeTimers(); const f = fixture();
    const unlocks = ACHIEVEMENTS.slice(0, 6).map(({ id }) => ({ id, at: "2026-10-05" }));
    await f.notify(unlocks); await f.notify(unlocks);
    expect(f.$("#achievement-toast").textContent).toContain("初次见面");
    await vi.advanceTimersByTimeAsync(3000); expect(f.$("#achievement-toast").hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(1000); expect(f.$("#achievement-toast").textContent).toContain("动起手来");
    await vi.advanceTimersByTimeAsync(4000); expect(f.$("#achievement-toast").textContent).toContain("命令行");
    await vi.advanceTimersByTimeAsync(4000); expect(f.$("#achievement-toast").textContent).toBe("还解锁了 3 个成就 · 查看全部");
    await vi.advanceTimersByTimeAsync(4000); expect(f.$("#achievement-toast").hidden).toBe(true);
  });
  it("opens the notified achievement, exports through the main process, and isolates event errors", async () => {
    vi.useFakeTimers(); const f = fixture([{ id: "first-turn", at: "2026-10-05", turnId: "source" }]);
    await f.notify([{ id: "first-turn", at: "2026-10-05" }]); f.$("#achievement-toast button").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.$('[data-achievement="first-turn"]').dataset.highlight).toBe("true");
    f.$("#achievement-export").click(); await vi.advanceTimersByTimeAsync(0);
    expect(f.api.exportLearning).toHaveBeenCalledOnce(); expect(f.$("#achievement-status").textContent).toContain("不包含对话");
    f.api.learningEvent.mockRejectedValueOnce(new Error("offline")); f.window.recordLearningEvent("xray-opened", { turnId: "source" });
    await vi.advanceTimersByTimeAsync(0); expect(f.$("#achievement-status").textContent).toContain("对话可继续");
  });
});
