import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, cpus } from "node:os";
import { join, resolve } from "node:path";
import { createApp, loadProfile, TraceCollector, TraceStore } from "../dist/index.js";
const root = await mkdtemp(join(tmpdir(), "buildme-trace-benchmark-"));
let app;
const names = ["beginTurn", "endTurn", "event", "wrapStream", "onAgentEvent"], original = new Map(names.map(name => [name, TraceCollector.prototype[name]]));
function capture(enabled) { for (const name of names) TraceCollector.prototype[name] = enabled ? original.get(name) : name === "wrapStream" ? stream => stream : () => undefined; }
try {
  await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
  await writeFile(join(root, "model.mjs"), `
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Type } from 'typebox';
const plugin = ctx => {
  const faux = fauxProvider({ provider: 'faux', tokensPerSecond: Infinity, models: [{id:'fixed'}] });
  faux.setResponses(Array.from({length:200}, () => async context => {
    await new Promise(done => setTimeout(done, 100));
    return context.messages.some(m => m.role === 'toolResult') ? fauxAssistantMessage('complete') : fauxAssistantMessage(Array.from({length:66}, (_,i) => fauxToolCall('echo', {value:'item '+i})), {stopReason:'toolUse'});
  }));
  ctx.llm.register(faux.provider, 'benchmark');
  return ctx.tools.register({name:'echo', label:'Echo', description:'Fixed local tool', parameters:Type.Object({value:Type.String()}), execute:async (_id,args) => ({content:[{type:'text',text:args.value}],details:{}})});
}; plugin.inject=['llm','tools']; export default plugin;
`);
  const profile = join(root, "profile.json");
  await writeFile(profile, JSON.stringify({ schemaVersion: 1, settings: { name: "trace benchmark", home: ".data", agent: { provider: "faux", model: "fixed", systemPrompt: "fixed local scenario", toolExecution: "parallel" } }, plugins: [{ id: "core.settings" }, { id: "core.sessions" }, { id: "core.prompts" }, { id: "core.tools" }, { id: "core.models" }, { id: "benchmark", source: "./model.mjs" }, { id: "runtime.pi" }] }));
  app = await createApp(await loadProfile(profile)); const store = new TraceStore(join(root, "traces"));
  let events = 0;
  app.ctx.on("piharness/trace", notification => { if (notification.type === "turn-end") events = notification.turn.events.length; void store.accept(notification); });
  async function run(enabled) { capture(enabled); const start = performance.now(); await app.ctx.agents.run("fixed input", { recordRawRequests: true }); await store.flush(); return performance.now() - start; }
  await run(false); await run(true); await run(true); await run(false);
  const samples = [];
  for (let i = 0; i < 21; i++) {
    let baseline, traced;
    if (i % 2) { traced = await run(true); baseline = await run(false); } else { baseline = await run(false); traced = await run(true); }
    samples.push({ baseline, traced, percent: (traced - baseline) / baseline * 100 });
  }
  const median = values => values.toSorted((a,b) => a-b)[Math.floor(values.length / 2)];
  const ordered = samples.map(s => s.percent).toSorted((a,b) => a-b);
  const report = { platform: process.platform, arch: process.arch, cpu: cpus()[0].model, node: process.version, pairs: samples.length, modelDelayMsPerCall: 100, modelCalls: 2, toolCalls: 66, events, raw: true, includesTracePersistence: true, baseline: "Same Pi runtime; collector entry methods disabled by fixture only (no production flag)", medianBaselineMs: median(samples.map(s => s.baseline)), medianTracedMs: median(samples.map(s => s.traced)), medianPairedOverheadPercent: median(ordered), totalOverheadPercent: (samples.reduce((sum,s) => sum+s.traced,0) / samples.reduce((sum,s) => sum+s.baseline,0) - 1) * 100, p95OverheadPercent: ordered[Math.ceil(ordered.length * .95) - 1], maxOverheadPercent: ordered.at(-1), samples };
  console.log(JSON.stringify(report, null, 2)); assert.equal(events, 202); assert.ok(report.medianPairedOverheadPercent <= 5 && report.totalOverheadPercent <= 5, `Trace aggregate overhead exceeds 5%`);
} finally { capture(true); await app?.stop(); await rm(root, { recursive: true, force: true }); }
