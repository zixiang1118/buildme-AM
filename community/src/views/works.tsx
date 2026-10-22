import type { Context } from 'hono';
import type { Env } from '../types.js';
import type { FormError } from '../lib/validation.js';
import { harnesses, type Work, type WorkInput, type WorkPageData } from '../lib/works.js';
import { Layout, Empty, Icon, Avatar } from './layout.js';
import { pageProps, Field } from './forms.js';

export function WorkFields({ c, values, error }: { c: Context<Env>; values: WorkInput; error?: FormError }) {
  const cover = values.coverId ? c.get('db').prepare('SELECT url FROM images WHERE id=?').get(values.coverId) as { url: string } | undefined : undefined;
  return <>
    <div class="work-fields-heading"><h2>介绍一下你的作品</h2><p class="muted">让大家一眼看懂你做了什么，以及可以在哪里体验。</p></div>
    <Field label="一句话介绍" name="summary" error={error?.fields.summary} help="最多 60 字，写清楚作品解决什么问题。"><input name="summary" value={values.summary} maxlength={60} placeholder="例如：把课程表变成可以订阅的日历"/></Field>
    <div class="field work-cover-field">
      <label for="work-cover-input">作品封面</label><input id="work-cover-input" type="file" name="cover" data-cover-input accept="image/jpeg,image/png,image/webp,image/gif"/>
      <input type="hidden" name="coverId" value={values.coverId}/>
      <p class="field-help">上传一张能代表作品的图片，拖动下方控件调整 16:10 取景范围。</p>
      {error?.fields.coverId && <p class="field-error">{error.fields.coverId}</p>}
      {error?.fields.cover && <p class="field-error">{error.fields.cover}</p>}
      <div class="cover-crop-frame" data-cover-frame><img data-cover-preview src={cover?.url} alt="作品封面裁剪预览" hidden={!cover}/><span class="cover-placeholder" data-cover-placeholder hidden={!!cover}><Icon name="cube"/><span>上传封面后，在这里调整取景</span></span></div>
      <div class="cover-crop-controls">
        <label><span>水平位置 <output data-crop-label="cropX">{values.cropX}%</output></span><input type="range" name="cropX" min="0" max="100" step="1" value={values.cropX} aria-label="封面水平位置"/></label>
        <label><span>垂直位置 <output data-crop-label="cropY">{values.cropY}%</output></span><input type="range" name="cropY" min="0" max="100" step="1" value={values.cropY} aria-label="封面垂直位置"/></label>
        <label><span>放大 <output data-crop-label="cropZoom">{values.cropZoom}×</output></span><input type="range" name="cropZoom" min="1" max="3" step="0.05" value={values.cropZoom} aria-label="封面缩放"/></label>
      </div>
      {['cropX', 'cropY', 'cropZoom'].map((name) => error?.fields[name] && <p class="field-error">{error.fields[name]}</p>)}
      <div class="form-actions"><button class="button" type="submit" name="action" value="cover-upload" formaction="/works/cover" formnovalidate data-cover-upload>上传封面</button><button class="button" type="button" data-cover-reset hidden>重置取景</button></div>
      <p class="field-help" data-cover-status role="status"/>
    </div>
    <fieldset class="field"><legend>用什么做的 · 至少选一项</legend><div class="tags">{harnesses(c.get('db')).map((harness) => <label class="tag"><input type="checkbox" name="harnesses" value={harness.id} checked={values.harnesses.includes(String(harness.id))}/>{harness.name}</label>)}</div>{error?.fields.harnesses && <p class="field-error">{error.fields.harnesses}</p>}</fieldset>
    <Field label="其他工具名称（可选）" name="otherHarness" error={error?.fields.otherHarness}><input name="otherHarness" value={values.otherHarness} maxlength={20} placeholder="选了“其他”时填写，最多 20 字"/></Field>
    <div class="form-row"><Field label="体验地址（可选）" name="demoUrl" type="url" value={values.demoUrl} error={error?.fields.demoUrl}/><Field label="源码地址（可选）" name="sourceUrl" type="url" value={values.sourceUrl} error={error?.fields.sourceUrl}/></div>
  </>;
}

function HarnessTags({ work }: { work: Work }) {
  return <div class="work-harnesses">{work.harnesses.map((harness) => <span>{harness.name === '其他' && work.other_harness ? work.other_harness : harness.name}</span>)}</div>;
}

export function WorkCard({ work, featured = false }: { work: Work; featured?: boolean }) {
  return <article class={`work-card${featured ? ' featured' : ''}`} data-work-id={work.post.id}>
    <a class="work-cover" href={`/p/${work.post.id}`}><img src={work.cover_thumb} alt={`${work.post.title}的封面`} width="640" height="400" loading="lazy"/>{featured && <span class="work-selected">精选</span>}</a>
    <div class="work-card-body"><h3><a href={`/p/${work.post.id}`}>{work.post.title}</a></h3><p class="work-description">{work.summary}</p><HarnessTags work={work}/><div class="work-card-meta"><Avatar user={work.post}/><a class="work-author" href={`/u/${encodeURIComponent(work.post.username)}`}>{work.post.username}</a><span aria-label={`${work.post.vote_count} 次点赞`}><Icon name="up"/>{work.post.vote_count}</span><span aria-label={`${work.post.reply_count} 条回复`}><Icon name="chat"/>{work.post.reply_count}</span></div></div>
  </article>;
}

export function WorkStrip({ works }: { works: Work[] }) {
  return <section class="work-strip" aria-label="社区作品"><div class="work-strip-heading"><h2>作品墙</h2><span class="muted">最近大家做了什么</span><a href="/works">看全部 ↗</a></div>{works.length ? <div class="work-strip-grid">{works.slice(0, 4).map((work) => <WorkCard work={work}/>)}</div> : <div class="work-strip-empty"><span>还没有作品，来发第一个。</span><a class="button" href="/new?category=4">发布作品</a></div>}</section>;
}

export function WorkInfo({ work }: { work: Work }) {
  return <section class="work-info" aria-label="作品信息"><img class="work-detail-cover" src={work.cover_url} alt={`${work.post.title}的封面`} width="1600" height="1000"/><div class="work-info-body"><p class="work-summary">{work.summary}</p><HarnessTags work={work}/>{(work.demo_url || work.source_url) && <div class="form-actions">{work.demo_url && <a class="button primary" href={work.demo_url} target="_blank" rel="nofollow noopener ugc">体验作品 ↗</a>}{work.source_url && <a class="button" href={work.source_url} target="_blank" rel="nofollow noopener ugc">查看源码 ↗</a>}</div>}</div></section>;
}

export function WorksPage({ c, data }: { c: Context<Env>; data: WorkPageData }) {
  const filterUrl = (harness: string) => `/works?${new URLSearchParams({ sort: data.sort, range: data.range, harness })}`;
  return <Layout {...pageProps(c, '作品墙')}>
    <div class="page-heading"><div><p class="eyebrow">MADE BY THE COMMUNITY</p><h1>想法，在这里变成作品。</h1><p>看看大家用 Agent 做了什么，也来分享你的下一块积木。</p></div><a class="button primary" href="/new?category=4">发布作品 <span aria-hidden="true">↗</span></a></div>
    <nav class="harness-filters" aria-label="按制作工具筛选"><a href={filterUrl('')} aria-current={!data.harness ? 'page' : undefined}>全部工具</a>{data.harnesses.map((harness) => <a href={filterUrl(String(harness.id))} aria-current={data.harness === String(harness.id) ? 'page' : undefined}>{harness.name}</a>)}</nav>
    {data.selected.length > 0 && <section class="selected-works"><div class="section-heading"><h2>社区精选</h2><p class="muted">一些值得打开看看的作品</p></div><div class="selected-work-grid">{data.selected.slice(0, 4).map((work) => <WorkCard work={work} featured/>)}</div></section>}
    <section class="all-works"><div class="feed-toolbar"><h2>{data.sort === 'latest' ? '最新作品' : '最受欢迎'}</h2><form action="/works" method="get" class="feed-controls"><input type="hidden" name="harness" value={data.harness}/><label><span class="sr-only">作品排序</span><select name="sort" aria-label="作品排序"><option value="votes" selected={data.sort === 'votes'}>最受欢迎</option><option value="latest" selected={data.sort === 'latest'}>最新发布</option></select></label><label><span class="sr-only">作品时间范围</span><select name="range" aria-label="作品时间范围"><option value="week" selected={data.range === 'week'}>本周</option><option value="month" selected={data.range === 'month'}>本月</option><option value="all" selected={data.range === 'all'}>全部时间</option></select></label><button class="button" type="submit">应用</button></form></div>
      {data.works.length ? <div class="work-grid">{data.works.map((work) => <WorkCard work={work}/>)}</div> : <Empty title="这里还没有作品">换一个筛选条件，或把你的第一个作品带到这里。</Empty>}
      <nav class="pagination" aria-label="作品分页">{data.next && <a class="button" href={data.next}>下一页</a>}</nav>
    </section>
  </Layout>;
}
