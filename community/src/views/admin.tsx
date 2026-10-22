import type { Child } from 'hono/jsx';
import type { Context } from 'hono';
import type { Env, User, Category } from '../types.js';
import type { Post } from '../lib/posts.js';
import { Layout, Csrf, Avatar, Empty } from './layout.js';
import { pageProps, Field } from './forms.js';

export interface QueueItem { kind: 'post' | 'reply'; id: number; postId: number; title: string; body: string; username: string; authorId: number; status: string; reports: number }
export interface ProfileRequest { user_id: number; username: string; bio: string }
export interface TagRequest { id: number; name: string; username: string }
export interface CatalogItem { id: number; name: string; active: number; position: number; slug?: string; description?: string; color?: string }
export interface BlockedWord { id: number; word: string; level: 'reject' | 'review' }
export interface AdminStatistics { users: number; activeToday: number; activeWeek: number; postsToday: number; repliesToday: number; storageBytes: number }
export interface AdminLog { username: string; action: string; target: string; created_at: number }

const contentStates: Record<string, string> = { public: '公开', pending: '待审核', hidden: '已隐藏', deleted: '已删除' };
const roleNames: Record<User['role'], string> = { member: '成员', moderator: '版主', admin: '管理员' };
const catalogNames: Record<string, string> = { categories: '板块', tags: '标签', harnesses: '制作工具' };
const adminLinks = [
  ['/admin/review', '待处理'], ['/admin/posts', '帖子'], ['/admin/works', '作品精选'],
  ['/admin/users', '用户'], ['/admin/invites', '邀请码'], ['/admin/catalog', '分类选项'],
  ['/admin/words', '屏蔽词'], ['/admin/settings', '站点设置'], ['/admin/stats', '数据'], ['/admin/logs', '日志'],
];

function DateText({ value }: { value: number }) {
  const date = new Date(value);
  return <time dateTime={date.toISOString()}>{date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</time>;
}

export function AdminShell({ c, title, children }: { c: Context<Env>; title: string; children: Child }) {
  const isAdmin = c.get('user')!.role === 'admin';
  const navigation = isAdmin ? adminLinks : adminLinks.filter(([path]) => ['/admin/review', '/admin/posts', '/admin/works', '/admin/logs'].includes(path));
  return <Layout {...pageProps(c, title)}>
    <div class="page-heading"><div><p class="eyebrow">COMMUNITY MANAGEMENT</p><h1>{title}</h1><p>让好的内容留下，让讨论继续发生。</p></div><a class="button" href="/">返回社区</a></div>
    <div class="admin-shell"><nav class="admin-navigation" aria-label="管理导航">{navigation.map(([path, label]) => <a href={path} aria-current={c.req.path === path || c.req.path.startsWith(`${path}/`) ? 'page' : undefined}>{label}</a>)}</nav><div class="admin-content">{children}</div></div>
  </Layout>;
}

export function ModerationQueue({ c, items, profiles, tags }: { c: Context<Env>; items: QueueItem[]; profiles: ProfileRequest[]; tags: TagRequest[] }) {
  const isAdmin = c.get('user')!.role === 'admin';
  return <AdminShell c={c} title="待处理内容">
    <div class="admin-section-heading"><h2>内容队列</h2><span class="muted">{items.length} 条待处理</span></div>
    {items.length ? <div class="admin-card-list">{items.map((item) => <article class="panel moderation-card">
      <div class="post-meta"><span class={`admin-state ${item.status}`}>{contentStates[item.status]}</span><span>{item.kind === 'post' ? '帖子' : '回复'}</span><a href={`/u/${encodeURIComponent(item.username)}`}>@{item.username}</a><span class={item.reports ? 'admin-report-count' : 'muted'}>{item.reports} 次举报</span></div>
      <h3><a href={`/p/${item.postId}`} target="_blank" rel="noopener">{item.title}</a></h3><div class="moderation-body">{item.body}</div>
      <form method="post" action={`/admin/content/${item.kind}/${item.id}/action`} class="admin-action-form"><Csrf value={c.get('csrf')}/>{isAdmin && <label class="admin-check"><input type="checkbox" name="banAuthor" value="1"/>同时封禁作者</label>}<div class="form-actions"><button class="button primary" type="submit" name="action" value="approve">通过审核</button><button class="button" type="submit" name="action" value="restore">恢复显示</button><button class="button danger" type="submit" name="action" value="delete">删除内容</button></div></form>
    </article>)}</div> : <Empty title="暂时没有待处理内容">新的待审内容和举报会出现在这里。</Empty>}
    {isAdmin && <>
      <section class="panel"><div class="admin-section-heading"><h2>简介修改申请</h2><span class="muted">{profiles.length} 条</span></div>{profiles.length ? <div class="admin-request-list">{profiles.map((profile) => <article class="admin-request"><a href={`/u/${encodeURIComponent(profile.username)}`}>@{profile.username}</a><p class="admin-request-text">{profile.bio}</p><form method="post" action={`/admin/profiles/${profile.user_id}`} class="form-actions"><Csrf value={c.get('csrf')}/><button class="button primary" type="submit" name="action" value="approve">通过简介</button><button class="button" type="submit" name="action" value="reject">拒绝简介</button></form></article>)}</div> : <p class="muted">没有待审核的简介。</p>}</section>
      <section class="panel"><div class="admin-section-heading"><h2>新标签申请</h2><span class="muted">{tags.length} 条</span></div>{tags.length ? <div class="admin-request-list">{tags.map((tag) => <article class="admin-request admin-tag-request"><div><strong>#{tag.name}</strong><p class="muted">@{tag.username} 申请</p></div><form method="post" action={`/admin/tags/${tag.id}/approve`}><Csrf value={c.get('csrf')}/><button class="button" type="submit">批准标签</button></form></article>)}</div> : <p class="muted">没有待批准的标签。</p>}</section>
    </>}
  </AdminShell>;
}

export function AdminPosts({ c, posts, query, categories }: { c: Context<Env>; posts: Post[]; query: string; categories: Category[] }) {
  return <AdminShell c={c} title="帖子管理"><form class="panel admin-search" method="get" action="/admin/posts"><label class="field"><span class="sr-only">搜索帖子</span><input type="search" name="q" value={query} placeholder="搜索标题或正文" aria-label="搜索帖子"/></label><button class="button primary" type="submit">搜索</button></form>
    <div class="admin-section-heading"><h2>帖子</h2><span class="muted">{posts.length} 条结果</span></div>
    {posts.length ? <div class="admin-card-list">{posts.map((post) => <article class="panel admin-post-card"><div class="post-meta"><span class={`admin-state ${post.status}`}>{contentStates[post.status]}</span><a href={`/u/${encodeURIComponent(post.username)}`}>@{post.username}</a><span>{post.category_name}</span>{!!post.featured && <span class="featured-badge">精华</span>}{!!post.pinned && <span class="pinned-badge">置顶</span>}</div><h3><a href={`/p/${post.id}`} target="_blank" rel="noopener">{post.title}</a></h3><p class="excerpt">{post.excerpt}</p>
      <form method="post" action={`/admin/content/post/${post.id}/action`} class="admin-action-form"><Csrf value={c.get('csrf')}/><div class="admin-post-controls"><label class="field"><span>移动到板块</span><select name="category">{categories.map((category) => <option value={category.id} selected={post.category_id === category.id}>{category.name}</option>)}</select></label><button class="button" type="submit" name="action" value="move">移动</button><label class="field"><span>置顶范围</span><select name="scope"><option value="global">全站</option><option value="category">当前板块</option></select></label><button class="button" type="submit" name="action" value={post.pinned ? 'unpin' : 'pin'}>{post.pinned ? '取消置顶' : '置顶'}</button></div><div class="form-actions"><button class="button" type="submit" name="action" value={post.featured ? 'unfeature' : 'feature'}>{post.featured ? '取消精华' : '设为精华'}</button><a class="button" href={`/admin/posts/${post.id}/history`}>编辑历史</a><button class="button danger" type="submit" name="action" value="delete">删除帖子</button></div></form>
    </article>)}</div> : <Empty title="没有找到帖子">试试其他关键词，或清空搜索条件。</Empty>}
  </AdminShell>;
}

export function AdminUsers({ c, users, query }: { c: Context<Env>; users: User[]; query: string }) {
  return <AdminShell c={c} title="用户管理"><form class="panel admin-search" method="get" action="/admin/users"><label class="field"><span class="sr-only">搜索用户</span><input type="search" name="q" value={query} placeholder="输入用户名" aria-label="搜索用户"/></label><button class="button primary" type="submit">搜索</button></form>
    <div class="admin-section-heading"><h2>用户</h2><span class="muted">{users.length} 位</span></div>
    {users.length ? <div class="admin-card-list">{users.map((user) => <article class="panel admin-user-card"><header class="admin-user-header"><Avatar user={user}/><div><h3><a href={`/u/${encodeURIComponent(user.username)}`}>{user.username}</a></h3><p class="muted">{roleNames[user.role]} · <DateText value={user.created_at}/> 加入</p></div><span class={`admin-state ${user.banned ? 'deleted' : 'public'}`}>{user.banned ? '已封禁' : '正常'}</span></header>{user.bio && <p class="admin-user-bio">{user.bio}</p>}{user.muted_until !== null && user.muted_until > c.get('now') && <p class="notice warning">禁言至 <DateText value={user.muted_until}/></p>}
      <form method="post" action={`/admin/users/${user.id}/action`} class="admin-action-form"><Csrf value={c.get('csrf')}/><div class="admin-user-controls"><label class="field"><span>禁言天数</span><input type="number" name="days" min="1" max="365" value="7"/></label><button class="button" type="submit" name="action" value="mute">禁言</button><button class="button" type="submit" name="action" value="unmute">解除禁言</button><label class="field"><span>用户角色</span><select name="role">{(['member', 'moderator', 'admin'] as const).map((role) => <option value={role} selected={user.role === role}>{roleNames[role]}</option>)}</select></label><button class="button" type="submit" name="action" value="role">保存角色</button></div><div class="form-actions"><button class={`button${user.banned ? '' : ' danger'}`} type="submit" name="action" value={user.banned ? 'unban' : 'ban'}>{user.banned ? '解除封禁' : '封禁用户'}</button></div></form>
      <form method="post" action="/admin/reset-password" class="admin-reset-password"><Csrf value={c.get('csrf')}/><input type="hidden" name="userId" value={user.id}/><button class="button" type="submit">重置密码</button></form>
    </article>)}</div> : <Empty title="没有找到用户">试试其他用户名。</Empty>}
  </AdminShell>;
}

function CatalogFields({ kind, item }: { kind: string; item: CatalogItem }) {
  return <><input type="hidden" name="id" value={item.id || ''}/><div class="admin-catalog-fields"><Field label="名称" name="name" value={item.name} required/><Field label="排序" name="position" value={String(item.position)} type="number"/><label class="field"><span>状态</span><select name="active"><option value="1" selected={!!item.active}>启用</option><option value="0" selected={!item.active}>停用</option></select></label>{kind === 'categories' && <><Field label="地址标识" name="slug" value={item.slug} required help="用于板块网址，例如 share。"/><Field label="板块说明" name="description" value={item.description}/><label class="field"><span>标记颜色</span><select name="color">{[['brand', '陶土'], ['blue', '蓝色'], ['green', '绿色'], ['purple', '紫色'], ['gray', '灰色']].map(([value, label]) => <option value={value} selected={item.color === value}>{label}</option>)}</select></label></>}</div></>;
}

export function AdminCatalog({ c, kind, items }: { c: Context<Env>; kind: string; items: CatalogItem[] }) {
  const blank: CatalogItem = { id: 0, name: '', active: 1, position: items.length + 1, slug: '', description: '', color: 'brand' };
  return <AdminShell c={c} title="分类选项"><nav class="feed-tabs" aria-label="分类选项类型">{Object.entries(catalogNames).map(([value, label]) => <a href={`/admin/catalog?kind=${value}`} aria-current={kind === value ? 'page' : undefined}>{label}</a>)}</nav>
    <section class="panel"><h2 class="admin-panel-title">新增{catalogNames[kind]}</h2><form class="form" method="post" action={`/admin/catalog/${kind}/save`}><Csrf value={c.get('csrf')}/><CatalogFields kind={kind} item={blank}/><div class="form-actions"><button class="button primary" type="submit">新增{catalogNames[kind]}</button></div></form></section>
    <div class="admin-section-heading"><h2>已有{catalogNames[kind]}</h2><span class="muted">{items.length} 项</span></div>{items.length ? <div class="admin-card-list">{items.map((item) => <section class="panel admin-catalog-card"><div class="admin-section-heading"><h3>{item.name}</h3><span class={`admin-state ${item.active ? 'public' : 'hidden'}`}>{item.active ? '启用中' : '已停用'}</span></div><form class="form" method="post" action={`/admin/catalog/${kind}/save`}><Csrf value={c.get('csrf')}/><CatalogFields kind={kind} item={item}/><div class="form-actions"><button class="button" type="submit">保存修改</button></div></form></section>)}</div> : <Empty title={`还没有${catalogNames[kind]}`}>可以使用上方表单新增。</Empty>}
  </AdminShell>;
}

export function AdminWords({ c, words }: { c: Context<Env>; words: BlockedWord[] }) {
  return <AdminShell c={c} title="屏蔽词"><section class="panel"><h2 class="admin-panel-title">新增屏蔽词</h2><form class="form" method="post" action="/admin/words"><Csrf value={c.get('csrf')}/><div class="form-row"><Field label="词语" name="word" required/><label class="field"><span>处理方式</span><select name="level"><option value="reject">拒绝提交</option><option value="review">转入待审</option></select></label></div><p class="field-help">检查标题、正文、回复、用户名、简介和链接标题。</p><div class="form-actions"><button class="button primary" type="submit">添加屏蔽词</button></div></form></section>
    <section class="panel"><div class="admin-section-heading"><h2>当前规则</h2><span class="muted">{words.length} 条</span></div>{words.length ? <div class="table-scroll" tabindex={0} role="region" aria-label="屏蔽词列表"><table class="admin-table admin-word-table"><thead><tr><th scope="col">词语</th><th scope="col">处理方式</th><th scope="col">操作</th></tr></thead><tbody>{words.map((word) => <tr><td>{word.word}</td><td><span class={`admin-state ${word.level === 'reject' ? 'deleted' : 'pending'}`}>{word.level === 'reject' ? '拒绝提交' : '转入待审'}</span></td><td><form method="post" action={`/admin/words/${word.id}/delete`}><Csrf value={c.get('csrf')}/><button class="button danger" type="submit">删除</button></form></td></tr>)}</tbody></table></div> : <p class="muted">尚未添加屏蔽词。</p>}</section>
  </AdminShell>;
}

export function AdminSettings({ c, firstPostReview }: { c: Context<Env>; firstPostReview: boolean }) {
  return <AdminShell c={c} title="站点设置"><section class="panel"><h2 class="admin-panel-title">新成员的第一篇帖子</h2><form class="form" method="post" action="/admin/settings"><Csrf value={c.get('csrf')}/><fieldset class="field"><legend>首帖审核</legend><label class="admin-radio"><input type="radio" name="firstPostReview" value="1" checked={firstPostReview}/><span><strong>开启</strong><small>第一篇帖子由管理员或版主通过后公开。</small></span></label><label class="admin-radio"><input type="radio" name="firstPostReview" value="0" checked={!firstPostReview}/><span><strong>关闭</strong><small>第一篇帖子通过其他检查后直接公开。</small></span></label></fieldset><div class="form-actions"><button class="button primary" type="submit">保存设置</button></div></form></section></AdminShell>;
}

export function AdminStats({ c, stats }: { c: Context<Env>; stats: AdminStatistics }) {
  const values = [['注册用户', stats.users], ['今日活跃用户', stats.activeToday], ['近 7 天活跃用户', stats.activeWeek], ['今日帖子', stats.postsToday], ['今日回复', stats.repliesToday], ['存储占用 / 字节', stats.storageBytes]] as const;
  return <AdminShell c={c} title="社区数据"><dl class="admin-stat-grid">{values.map(([label, value]) => <div class="panel"><dt>{label}</dt><dd>{value.toLocaleString('zh-CN')}</dd></div>)}</dl></AdminShell>;
}

export function AdminLogs({ c, logs }: { c: Context<Env>; logs: AdminLog[] }) {
  return <AdminShell c={c} title="操作日志"><section class="panel"><div class="admin-section-heading"><h2>最近的管理操作</h2><span class="muted">{logs.length} 条</span></div>{logs.length ? <div class="table-scroll" tabindex={0} role="region" aria-label="管理操作日志"><table class="admin-table admin-log-table"><thead><tr><th scope="col">时间</th><th scope="col">操作者</th><th scope="col">操作</th><th scope="col">对象</th></tr></thead><tbody>{logs.map((log) => <tr><td><DateText value={log.created_at}/></td><td>{log.username}</td><td><code>{log.action}</code></td><td>{log.target}</td></tr>)}</tbody></table></div> : <p class="muted">暂无操作日志。</p>}</section></AdminShell>;
}

export function ReportForm({ c, kind, id }: { c: Context<Env>; kind: 'post' | 'reply'; id: number }) {
  if (!c.get('user')) return <a class="report-entry" href="/login" aria-label="登录后举报">举报</a>;
  return <details class="report-form"><summary>举报</summary><form class="form" method="post" action={`/reports/${kind}/${id}`}><Csrf value={c.get('csrf')}/><label class="field"><span>举报原因</span><select name="reason" required><option value="">请选择原因</option>{['广告', '与主题无关', '不友善', '违法违规', '其他'].map((reason) => <option value={reason}>{reason}</option>)}</select></label><label class="field"><span>补充说明（可选）</span><textarea name="description" maxlength={1000} rows={3} placeholder="请说明具体问题，最多 1000 字。"/></label><div class="form-actions"><button class="button" type="submit">提交举报</button></div></form></details>;
}
