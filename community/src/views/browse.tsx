import type { Context } from "hono";
import type { Env, User } from "../types.js";
import type {
  FeedOptions,
  FeedResult,
  SearchOptions,
  SearchResult,
  SidebarData,
} from "../lib/browse.js";
import {
  blankPost,
  categories,
  tags as availableTags,
  type Post,
} from "../lib/posts.js";
import { Layout, Csrf, Avatar, Empty, Icon } from "./layout.js";
import { pageProps, Field } from "./forms.js";
import { PostCard, PostFields, relativeTime } from "./posts.js";
import { homeWorks, selectedWorks, userWorks } from "../lib/works.js";
import { WorkCard, WorkStrip } from "./works.js";

function queryUrl(
  path: string,
  values: Record<string, string | number | undefined>,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== "") query.set(key, String(value));
  return `${path}?${query}`;
}

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  const pattern = terms
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  if (!pattern) return <>{text}</>;
  return (
    <>
      {text
        .split(new RegExp(`(${pattern})`, "giu"))
        .map((part, index) => (index % 2 ? <mark>{part}</mark> : part))}
    </>
  );
}

function QuickShare({ c }: { c: Context<Env> }) {
  const user = c.get("user");
  return user ? (
    <details class="panel quick-share">
      <summary>贴一个链接，再说两句为什么推荐</summary>
      <form
        class="form"
        method="post"
        action="/new"
        data-quick-share
        data-editor-id="new"
        data-user-id={user.id}
      >
        <Csrf value={c.get("csrf")} />
        <input type="hidden" name="editorId" value="new" />
        <PostFields c={c} values={blankPost()} quick />
        <Field label="几句话" name="body">
          <textarea name="body" rows={3} />
        </Field>
        <div id="editor-status" role="status" />
        <div class="form-actions">
          <button class="button primary" type="submit">
            发布
          </button>
          <a href="/new">使用完整编辑器</a>
        </div>
      </form>
    </details>
  ) : (
    <div class="panel quick-share guest-share">
      <span>分享你的发现，让灵感继续生长。</span>
      <a class="button primary" href="/login">
        登录后分享
      </a>
    </div>
  );
}

function CommunitySidebar({ c, data }: { c: Context<Env>; data: SidebarData }) {
  return (
    <aside class="sidebar">
      <section class="panel">
        <h2>本周大家在看</h2>
        {data.popular.length ? (
          <ol class="popular-list">
            {data.popular.slice(0, 5).map((post, index) => (
              <li>
                <span class="rank-number">{index + 1}</span>
                <div>
                  <a href={`/p/${post.id}`}>{post.title}</a>
                  <small>
                    {post.category_name} · {post.views} 次浏览
                  </small>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p class="muted">新的讨论正在这里发生。</p>
        )}
      </section>
      <section class="panel">
        <div class="sidebar-heading">
          <h2>大家关注</h2>
          <a href="/tags">全部标签 ↗</a>
        </div>
        <div class="tags">
          {data.tags.slice(0, 12).map((tag) => (
            <a class="tag" href={`/t/${encodeURIComponent(tag.name)}`}>
              #{tag.name}
            </a>
          ))}
        </div>
        {!data.tags.length && (
          <p class="muted">发布帖子时，为你的发现选几个标签。</p>
        )}
        {c.get("user") && (
          <details class="tag-request">
            <summary>申请新标签</summary>
            <form class="form" method="post" action="/tags/request">
              <Csrf value={c.get("csrf")} />
              <Field label="标签名" name="name" required />
              <button class="button" type="submit">
                提交申请
              </button>
            </form>
          </details>
        )}
      </section>
      <section class="panel">
        <h2>社区正在生长</h2>
        <dl class="community-stats">
          <div>
            <dt>成员</dt>
            <dd>{data.users}</dd>
          </div>
          <div>
            <dt>帖子</dt>
            <dd>{data.posts}</dd>
          </div>
          <div>
            <dt>今日新帖</dt>
            <dd>{data.today}</dd>
          </div>
        </dl>
      </section>
      <section class="panel community-invitation">
        <Icon name="cube" />
        <h2>{c.get("embed") ? "分享你的发现" : "下一次尝试，从这里开始"}</h2>
        <p>
          分享真实的经验，提出具体的问题。每一次尝试，都能帮助别人少走一步弯路。
        </p>
        <a class="button" href={c.get("embed") ? "/new" : "/download"}>
          {c.get("embed") ? "写下你的经验" : "下载 BuildMe"}{" "}
          <span aria-hidden="true">↗</span>
        </a>
      </section>
      <a class="sidebar-rss" href="/feed.xml">
        订阅最新帖子 · RSS
      </a>
    </aside>
  );
}

export function Feed({
  c,
  result,
  mode,
  title,
  options,
  sidebar,
}: {
  c: Context<Env>;
  result: FeedResult;
  mode: string;
  title: string;
  options: FeedOptions;
  sidebar: SidebarData;
}) {
  const categoryList = categories(c.get("db"));
  const sorts =
    mode === "hot"
      ? [["hot", "按热度"]]
      : mode === "featured"
        ? [
            ["featured", "管理员精选"],
            ["votes", "点赞榜"],
          ]
        : [
            ["active", "最近活跃"],
            ["created", "最新发布"],
          ];
  const filterPath = mode === "category" ? "/latest" : c.req.path;
  const filterOptions = {
    sort: options.sort,
    range: options.range,
    tag: options.tag,
  };
  const introduction =
    mode === "hot"
      ? "最近 14 天里，大家正在关注和讨论的好内容。"
      : mode === "featured"
        ? "值得反复阅读的经验，和大家共同选出的好帖子。"
        : "好的链接、踩过的坑，还有你的下一次灵感。";
  return (
    <Layout {...pageProps(c, title)} editor={!!c.get("user")}>
      <div class="page-heading">
        <div>
          <p class="eyebrow">BUILD TOGETHER</p>
          <h1>{title}</h1>
          <p>{introduction}</p>
        </div>
        <a class="button" href="/new">
          写长文 <span aria-hidden="true">↗</span>
        </a>
      </div>
      <div class="layout browse-layout">
        <section class="feed">
          <QuickShare c={c} />
          <WorkStrip works={homeWorks(c.get("db"), c.get("user"), c.get("now"))} />
          <nav class="category-filters" aria-label="按板块筛选">
            <a
              href={queryUrl(filterPath, { ...filterOptions, category: "" })}
              aria-current={!options.category ? "page" : undefined}
            >
              全部
            </a>
            {categoryList.map((category) => (
              <a
                href={queryUrl(filterPath, {
                  ...filterOptions,
                  category: category.id,
                })}
                aria-current={
                  options.category === String(category.id) ? "page" : undefined
                }
              >
                <span class={`category-dot ${category.slug}`} />
                {category.name}
              </a>
            ))}
          </nav>
          <div class="feed-toolbar">
            <form class="feed-controls" action={c.req.path} method="get">
              {options.category && (
                <input type="hidden" name="category" value={options.category} />
              )}
              {options.tag && (
                <input type="hidden" name="tag" value={options.tag} />
              )}
              <label>
                <span class="sr-only">帖子排序</span>
                <select name="sort" aria-label="帖子排序">
                  {sorts.map(([value, label]) => (
                    <option value={value} selected={options.sort === value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {mode === "hot" ? <span class="muted">最近 14 天</span> : <label>
                <span class="sr-only">时间范围</span>
                <select name="range" aria-label="时间范围">
                  <option value="all" selected={options.range === "all"}>
                    全部时间
                  </option>
                  <option value="month" selected={options.range === "month"}>
                    本月
                  </option>
                  <option value="week" selected={options.range === "week"}>
                    本周
                  </option>
                </select>
              </label>}
              <button class="button" type="submit">
                应用
              </button>
            </form>
            <span class="muted">每页 30 条</span>
          </div>
          <div id="post-list" class="feed">
            {result.posts.length ? (
              result.posts.map((post) => <PostCard c={c} post={post} />)
            ) : (
              <Empty title="这里还没有帖子">
                换一个筛选条件，或来分享第一个发现。
              </Empty>
            )}
          </div>
          <p id="browse-status" class="field-help" role="status" />
          <nav class="form-actions feed-pagination" aria-label="帖子分页">
            {result.next && (
              <a class="button" data-more-posts href={result.next}>
                下一页
              </a>
            )}
          </nav>
        </section>
        <CommunitySidebar c={c} data={sidebar} />
      </div>
    </Layout>
  );
}

export function SearchPage({
  c,
  result,
  options,
}: {
  c: Context<Env>;
  result: SearchResult;
  options: SearchOptions;
}) {
  const filters = {
    q: options.q,
    type: options.type,
    category: options.category,
    tag: options.tag,
    author: options.author,
    range: options.range,
    sort: options.sort,
  };
  return (
    <Layout {...pageProps(c, "搜索")}>
      <div class="page-heading">
        <div>
          <p class="eyebrow">FIND SOMETHING USEFUL</p>
          <h1>搜索社区</h1>
          <p>从一个问题，找到下一步的线索。</p>
        </div>
      </div>
      <form action="/search" method="get" class="panel search-form">
        <div class="search-query-row">
          <label class="field">
            <span class="sr-only">搜索关键词</span>
            <input
              type="search"
              name="q"
              value={options.q}
              placeholder="搜索帖子、回复或用户"
              aria-label="搜索关键词"
            />
          </label>
          <button type="submit" class="button primary">
            搜索
          </button>
        </div>
        <p class="search-help">
          用 <code>@用户名</code> 查找作者，用 <code>#标签</code> 缩小范围，用{" "}
          <code>"完整短语"</code> 精确匹配。
        </p>
        <div class="search-filter-grid">
          <label class="field">
            <span>内容类型</span>
            <select name="type" aria-label="内容类型">
              <option value="posts" selected={options.type === "posts"}>
                帖子
              </option>
              <option value="replies" selected={options.type === "replies"}>
                回复
              </option>
              <option value="users" selected={options.type === "users"}>
                用户
              </option>
            </select>
          </label>
          <label class="field">
            <span>板块</span>
            <select name="category" aria-label="板块">
              <option value="">全部板块</option>
              {categories(c.get("db")).map((category) => (
                <option
                  value={category.id}
                  selected={options.category === String(category.id)}
                >
                  {category.name}
                </option>
              ))}
            </select>
          </label>
          <label class="field">
            <span>标签</span>
            <select name="tag" aria-label="标签">
              <option value="">全部标签</option>
              {availableTags(c.get("db")).map((tag) => (
                <option value={tag.name} selected={options.tag === tag.name}>
                  {tag.name}
                </option>
              ))}
            </select>
          </label>
          <label class="field">
            <span>作者</span>
            <input name="author" value={options.author} placeholder="用户名" />
          </label>
          <label class="field">
            <span>时间范围</span>
            <select name="range" aria-label="时间范围">
              <option value="all" selected={options.range === "all"}>
                全部时间
              </option>
              <option value="month" selected={options.range === "month"}>
                本月
              </option>
              <option value="week" selected={options.range === "week"}>
                本周
              </option>
            </select>
          </label>
          <label class="field">
            <span>排序</span>
            <select name="sort" aria-label="搜索排序">
              <option value="relevance" selected={options.sort === "relevance"}>
                相关度
              </option>
              <option value="latest" selected={options.sort === "latest"}>
                最新
              </option>
            </select>
          </label>
        </div>
      </form>
      <div class="search-results-heading">
        <h2>{options.q ? `“${options.q}”的搜索结果` : "搜索结果"}</h2>
        <span class="muted">共 {result.total} 条</span>
      </div>
      <div class="search-results">
        {result.items.length ? (
          result.items.map((item) => (
            <article class="panel search-result">
              <h3>
                <a href={item.href}>
                  <Highlight text={item.title} terms={result.terms} />
                </a>
              </h3>
              <p class="search-excerpt">
                <Highlight text={item.excerpt} terms={result.terms} />
              </p>
              <div class="post-meta">
                <a href={`/u/${encodeURIComponent(item.username)}`}>
                  @{item.username}
                </a>
                <time dateTime={new Date(item.created_at).toISOString()}>
                  {relativeTime(item.created_at, c.get("now"))}
                </time>
              </div>
            </article>
          ))
        ) : (
          <Empty title={options.q ? "暂时没有找到匹配内容" : "你想了解什么？"}>
            {options.q
              ? "试试更短的关键词，或减少几个筛选条件。"
              : "输入关键词，也可以直接搜索作者或标签。"}
          </Empty>
        )}
      </div>
      <nav class="pagination" aria-label="搜索结果分页">
        {options.page > 1 && (
          <a
            class="button"
            href={queryUrl("/search", { ...filters, page: options.page - 1 })}
          >
            上一页
          </a>
        )}
        {result.total > 0 && <span class="muted">第 {options.page} 页</span>}
        {options.page * 20 < result.total && (
          <a
            class="button"
            href={queryUrl("/search", { ...filters, page: options.page + 1 })}
          >
            下一页
          </a>
        )}
      </nav>
    </Layout>
  );
}

export function ProfilePage({
  c,
  profile,
  tab,
  posts,
  replies,
  stats,
}: {
  c: Context<Env>;
  profile: User;
  tab: string;
  posts: Post[];
  replies: { post_id: number; floor: number; body: string; title: string }[];
  stats: { posts: number; votes: number };
}) {
  const ownProfile = c.get("user")?.id === profile.id;
  const profileUrl = `/u/${encodeURIComponent(profile.username)}`;
  const profileWorks = tab === "works" ? userWorks(c.get("db"), c.get("user"), profile.id) : [];
  const joined = new Date(profile.created_at);
  return (
    <Layout {...pageProps(c, profile.username)}>
      <section class="panel profile-header">
        <Avatar user={profile} />
        <div class="profile-summary">
          <p class="eyebrow">COMMUNITY MEMBER</p>
          <h1>{profile.username}</h1>
          <p>{profile.bio || "还没有填写简介。"}</p>
          <div class="post-meta">
            <span>
              <time dateTime={joined.toISOString()}>
                {joined.toLocaleDateString("zh-CN", {
                  timeZone: "Asia/Shanghai",
                })}
              </time>{" "}
              加入
            </span>
            <span>
              <strong>{stats.posts}</strong> 篇帖子
            </span>
            <span>
              <strong>{stats.votes}</strong> 次获赞
            </span>
          </div>
        </div>
        {ownProfile && (
          <a class="button" href="/settings">
            编辑资料
          </a>
        )}
      </section>
      <div class="profile-navigation">
        <nav class="feed-tabs" aria-label="用户内容">
          <a
            href={queryUrl(profileUrl, { tab: "posts" })}
            aria-current={tab === "posts" ? "page" : undefined}
          >
            帖子
          </a>
          <a
            href={queryUrl(profileUrl, { tab: "works" })}
            aria-current={tab === "works" ? "page" : undefined}
          >
            作品
          </a>
          <a
            href={queryUrl(profileUrl, { tab: "replies" })}
            aria-current={tab === "replies" ? "page" : undefined}
          >
            回复
          </a>
        </nav>
        {ownProfile && (
          <nav class="profile-private" aria-label="我的内容">
            <a href="/bookmarks">我的收藏</a>
            <a href="/drafts">我的草稿</a>
          </nav>
        )}
      </div>
      <section class="feed profile-feed">
        {tab === "works" ? (
          profileWorks.length ? <div class="work-grid">{profileWorks.map((work) => <WorkCard work={work} />)}</div> : <Empty title="还没有发布作品">把想法做出来，也把成果带到这里。</Empty>
        ) : tab === "replies" ? (
          replies.length ? (
            replies.map((reply) => (
              <article class="panel profile-reply">
                <a class="category" href={`/p/${reply.post_id}#${reply.floor}`}>
                  回复 #{reply.floor}
                </a>
                <h2>
                  <a href={`/p/${reply.post_id}#${reply.floor}`}>
                    {reply.title}
                  </a>
                </h2>
                <p class="excerpt">{reply.body}</p>
                <a
                  class="profile-reply-link"
                  href={`/p/${reply.post_id}#${reply.floor}`}
                >
                  查看讨论 ↗
                </a>
              </article>
            ))
          ) : (
            <Empty title="还没有回复">参与讨论，往往是另一个发现的开始。</Empty>
          )
        ) : posts.length ? (
          posts.map((post) => <PostCard c={c} post={post} />)
        ) : (
          <Empty title="还没有发布帖子">
            好的问题、真实的经验，都值得在这里记录。
          </Empty>
        )}
      </section>
    </Layout>
  );
}

export function TagsPage({
  c,
  tags,
}: {
  c: Context<Env>;
  tags: { name: string; count: number }[];
}) {
  return (
    <Layout {...pageProps(c, "全部标签")}>
      <div class="page-heading">
        <div>
          <p class="eyebrow">FOLLOW YOUR CURIOSITY</p>
          <h1>从一个标签开始</h1>
          <p>找到你关心的话题，看看大家都做了什么。</p>
        </div>
        <a class="button" href="/latest">
          浏览最新帖子
        </a>
      </div>
      {tags.length ? (
        <section class="tag-directory" aria-label="全部标签">
          {tags.map((tag) => (
            <a
              class="panel tag-directory-item"
              href={`/t/${encodeURIComponent(tag.name)}`}
            >
              <strong>#{tag.name}</strong>
              <span class="muted">
                {tag.count} 篇帖子 <span aria-hidden="true">↗</span>
              </span>
            </a>
          ))}
        </section>
      ) : (
        <Empty title="标签正在整理中">
          先浏览最新帖子，或在发布时选择已有标签。
        </Empty>
      )}
    </Layout>
  );
}

export function DownloadPage({ c }: { c: Context<Env> }) {
  const config = c.get("config");
  const featuredWorks = selectedWorks(c.get("db"), c.get("user"), 3);
  return (
    <Layout {...pageProps(c, "下载 BuildMe")}>
      <section class="download-hero">
        <div>
          <p class="eyebrow">BUILD YOUR NEXT IDEA</p>
          <h1>
            从一个想法，
            <br />
            到一次真正的动手。
          </h1>
          <p class="download-intro">
            用 BuildMe 探索 Agent，把想法做出来，再把经验带回社区。
          </p>
          <div class="download-actions">
            {config.downloadMacUrl ? (
              <a class="button primary" href={config.downloadMacUrl}>
                下载 macOS 版 <span aria-hidden="true">↗</span>
              </a>
            ) : (
              <button class="button primary" disabled>
                macOS · 即将开放
              </button>
            )}
            {config.downloadWinUrl ? (
              <a class="button" href={config.downloadWinUrl}>
                下载 Windows 版 <span aria-hidden="true">↗</span>
              </a>
            ) : (
              <button class="button" disabled>
                Windows · 即将开放
              </button>
            )}
          </div>
          <p class="download-version">
            当前版本 <span class="num">{config.appVersion}</span>
          </p>
        </div>
        <div class="download-preview">
          <span class="download-cube">
            <Icon name="cube" />
          </span>
          <strong>BuildMe</strong>
          <span class="muted">应用界面截图准备中</span>
        </div>
      </section>
      <section class="download-community panel">
        <div>
          <h2>动手之后，来聊聊你的发现。</h2>
          <p>
            一段代码、一个好链接、一次没走通的尝试，都能成为下一场讨论的起点。
          </p>
        </div>
        <a class="button" href="/hot">
          逛逛社区 ↗
        </a>
      </section>
      <section class="download-works">
        <h2>大家用 BuildMe 做了什么</h2>
        {featuredWorks.length ? <div class="work-grid download-work-grid">{featuredWorks.map((work) => <WorkCard work={work} />)}</div> : <Empty title="精选作品正在整理中">先去<a href="/works">作品墙</a>看看大家的新发现。</Empty>}
      </section>
    </Layout>
  );
}
