import type { ShareData } from '../lib/share.js';
import { Icon } from './layout.js';

const shareNumber = (value: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);

export function ShareCard({ data }: { data: ShareData }) {
  if (data.type === 'achievement') {
    return <section class="share-card achievement-share" data-share-type="achievement" aria-label="成就分享">
      <div class="achievement-brick" aria-hidden="true"><Icon name="cube"/></div>
      <div class="achievement-copy"><span class="share-eyebrow">解锁一块新积木</span><h3>{data.name}</h3><p>已解锁 <strong>{shareNumber(data.unlocked)}<span> / {shareNumber(data.total)}</span></strong> 项成就</p><progress class="achievement-progress" value={data.unlocked} max={data.total} aria-label={`已解锁 ${data.unlocked} 项，共 ${data.total} 项成就`}/></div>
    </section>;
  }

  const maxTokens = Math.max(data.pi.tokens, data.dsh.tokens, 1);
  const metrics = [
    { label: '模型调用', pi: data.pi.llmCalls, dsh: data.dsh.llmCalls, suffix: '次' },
    { label: '工具调用', pi: data.pi.toolCalls, dsh: data.dsh.toolCalls, suffix: '次' },
    { label: '耗时', pi: data.pi.seconds, dsh: data.dsh.seconds, suffix: '秒' },
  ];
  return <section class="share-card compare-share" data-share-type="compare" aria-label="Agent 对比分享">
    <div class="share-card-heading"><div><span class="share-eyebrow">同一个任务，两种 Agent</span><h3>Token 用量对比</h3></div><span class="share-model">{data.model}</span></div>
    <div class="share-token-chart">
      <div class="share-token-row is-pi"><div class="share-token-label"><span>我的 Agent <small>{data.pi.capabilities} 项能力</small></span><strong>{shareNumber(data.pi.tokens)}<small> tokens</small></strong></div><progress value={data.pi.tokens} max={maxTokens} aria-label={`我的 Agent：${data.pi.tokens} tokens`}/></div>
      <div class="share-token-row is-dsh"><div class="share-token-label"><span>完全体</span><strong>{shareNumber(data.dsh.tokens)}<small> tokens</small></strong></div><progress value={data.dsh.tokens} max={maxTokens} aria-label={`完全体：${data.dsh.tokens} tokens`}/></div>
    </div>
    <dl class="share-metrics">{metrics.map((metric) => <div><dt>{metric.label}</dt><dd><span aria-label={`我的 Agent ${metric.pi} ${metric.suffix}`}>{shareNumber(metric.pi)}</span><span class="share-metric-divider" aria-hidden="true">/</span><span aria-label={`完全体 ${metric.dsh} ${metric.suffix}`}>{shareNumber(metric.dsh)}</span><small>{metric.suffix}</small></dd></div>)}</dl>
    <p class="share-metric-key">数值顺序：我的 Agent / 完全体</p>
    {data.dshOnly.length > 0 && <div class="share-capabilities"><span>完全体多了</span><div>{data.dshOnly.map((name) => <span class="share-capability">{name}</span>)}</div></div>}
  </section>;
}
