import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import { asset } from "../lib/assets.js";
export interface Viewer {
  id: number;
  username: string;
  avatar_url: string | null;
  role: string;
  must_change_password: number;
}
export interface PageProps {
  title: string;
  children: Child;
  theme?: string;
  embed?: boolean;
  csrf?: string;
  user?: Viewer | null;
  path?: string;
  editor?: boolean;
  notice?: string;
  imageOrigin?: string;
  unread?: number;
}
export function Icon({ name }: { name: string }) {
  return (
    <svg class="icon" width="18" height="18" aria-hidden="true">
      <use href={`${asset("icons.svg")}#${name}`} />
    </svg>
  );
}
export function Csrf({ value }: { value?: string }) {
  return <input type="hidden" name="csrf" value={value} />;
}
export function Layout(p: PageProps) {
  return (
    <>
      {raw("<!doctype html>")}
      <html
        lang="zh-CN"
        data-image-origin={p.imageOrigin}
        data-theme={p.theme}
        data-embed={p.embed ? "1" : "0"}
      >
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{p.unread ? `(${p.unread}) ` : ""}{p.title} · BuildMe 社区</title>
          <meta
            name="description"
            content="分享发现，讨论 Agent，记录每一次动手的经验。"
          />
          <link rel="stylesheet" href={asset("site.css")} />
          <script src={asset("site.js")} defer />
          <script src={asset("browse.js")} defer />
          <script src={asset("interactions.js")} defer />
          <script src={asset("share.js")} defer />
          {p.editor && <script src={asset("editor.js")} defer />}
          {p.editor && <script src={asset("works.js")} defer />}
        </head>
        <body class={p.embed ? "is-embed" : ""}>
          <div class="shell">
            <header class="site-header">
              <div class="header-inner">
                <a href="/" class="brand">
                  <span class="brand-mark">
                    <Icon name="cube" />
                  </span>
                  BuildMe <span class="brand-subtitle">社区</span>
                </a>
                <nav class="nav" aria-label="主导航">
                  <a href="/" aria-current={p.path === "/" || p.path === "/hot" ? "page" : undefined}>热门</a>
                  <a
                    href="/latest"
                    aria-current={p.path === "/latest" ? "page" : undefined}
                  >
                    最新
                  </a>
                  <a href="/featured" aria-current={p.path === "/featured" ? "page" : undefined}>精华</a>
                  <a href="/works" aria-current={p.path === "/works" ? "page" : undefined}>作品墙</a>
                </nav>
                <form class="header-search" action="/search" role="search"><label class="sr-only" for="site-search">搜索社区</label><input id="site-search" data-search-input name="q" type="search" placeholder="搜索社区 /" autocomplete="off" aria-controls="search-suggestions"/><div id="search-suggestions" role="listbox" hidden/></form>
                <button class="button mobile-menu-toggle" type="button" data-mobile-menu aria-controls="mobile-navigation" aria-expanded="false">菜单</button>
                <div class="header-actions" id="mobile-navigation">
                  <form method="post" action="/theme" class="inline-form">
                    <Csrf value={p.csrf} />
                    <input
                      name="returnTo"
                      type="hidden"
                      value={p.path ?? "/latest"}
                    />
                    <select name="theme" aria-label="主题">
                      <option value="system" selected={!p.theme}>
                        跟随系统
                      </option>
                      <option value="light" selected={p.theme === "light"}>
                        浅色
                      </option>
                      <option value="dark" selected={p.theme === "dark"}>
                        深色
                      </option>
                    </select>
                    <button class="button" type="submit">
                      切换
                    </button>
                  </form>
                  <a href="/download" class="download-link">下载 BuildMe</a>
                  {p.user ? (
                    <>
                      <a href="/new" class="button primary">
                        写长文
                      </a>
                      <a href="/notifications" aria-label="通知">通知 <span data-unread-count hidden={!p.unread}>{p.unread || ""}</span></a>
                      <a href="/bookmarks">收藏</a>
                      <a href="/settings" class="account-link">
                        {p.user.username}
                      </a>
                    </>
                  ) : (
                    <a href="/login" class="button primary">
                      登录 / 注册
                    </a>
                  )}
                </div>
              </div>
            </header>
            <main class="page">
              {p.notice && (
                <p class="notice" role="status">
                  {p.notice}
                </p>
              )}
              {p.children}
            </main>
            <footer class="site-footer">
              <span>BuildMe 社区 · 让每一次尝试，都有回响</span>
              <a href="/about">关于与规则</a>
            </footer>
          </div>
        </body>
      </html>
    </>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: Child;
}) {
  return (
    <div class="empty">
      <Icon name="chat" />
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}
export function Avatar({
  user,
}: {
  user: { username: string; avatar_url?: string | null };
}) {
  const tone =
    [...user.username].reduce((n, c) => n + c.codePointAt(0)!, 0) % 6;
  return user.avatar_url ? (
    <img class="avatar" src={user.avatar_url} alt="" width="32" height="32" />
  ) : (
    <span class={`avatar tone-${tone}`} aria-hidden="true">
      {[...user.username][0]}
    </span>
  );
}
