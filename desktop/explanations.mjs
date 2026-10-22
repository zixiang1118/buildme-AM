import { ExplanationService, eventExplanation, comparisonExplanation } from "../dist/core/explanations.js";
import knowledge from "./renderer/knowledge.cjs";

export function createExplanationService({ root, connection, traceStore, comparisons, notify, learning }) {
  return new ExplanationService(root, connection, async (target) => {
    if (target.kind === "comparison") {
      const { group, metrics, traces } = await comparisons().details(target.compareGroupId);
      return comparisonExplanation(group, metrics, traces);
    }
    const turn = await traceStore().turn(target.turnId);
    if (!turn) throw new Error("这个回合的 X 光记录已被清理，无法讲解。");
    return eventExplanation(turn, target, knowledge);
  }, notify, async (input, cacheKey) => {
    await learning({ id: `explanation:${cacheKey}`, at: new Date().toISOString(), type: input.kind === "event" ? "explain-deep" : "compare-summary", ...(input.turnId ? { turnId: input.turnId } : {}) });
  });
}
