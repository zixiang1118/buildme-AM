import type { Hono, Context } from "hono";
import type { Env, User, Category } from "../types.js";
import {
  Feed,
  SearchPage,
  ProfilePage,
  TagsPage,
  DownloadPage,
} from "../views/browse.js";
import { PostCard } from "../views/posts.js";
import {
  feed,
  sidebar,
  search,
  tagCounts,
  type FeedOptions,
  type SearchOptions,
} from "../lib/browse.js";
import { getPost } from "../lib/posts.js";
import { FormError, usernameKey } from "../lib/validation.js";
import { limit } from "../lib/auth.js";
const pageNumber = (value: string | undefined) =>
  Math.max(1, Math.min(100000, Number.parseInt(value ?? "1", 10) || 1));
function searchOptions(c: Context<Env>): SearchOptions {
  return {
    q: (c.req.query("q") ?? "").slice(0, 200),
    type: ["replies", "users"].includes(c.req.query("type") ?? "")
      ? c.req.query("type")!
      : "posts",
    category: c.req.query("category") ?? "",
    tag: c.req.query("tag") ?? "",
    author: c.req.query("author") ?? "",
    range: c.req.query("range") ?? "all",
    sort: c.req.query("sort") === "latest" ? "latest" : "relevance",
    page: pageNumber(c.req.query("page")),
  };
}
export function browsing(app: Hono<Env>) {
  const showFeed = async (
    c: Context<Env>,
    mode: string,
    title: string,
    category = "",
    tag = "",
  ) => {
    const options: FeedOptions = {
      sort:
        c.req.query("sort") ??
        (mode === "featured" ? "featured" : mode === "hot" ? "hot" : "active"),
      category: category || c.req.query("category") || "",
      tag: tag || c.req.query("tag") || "",
      range: c.req.query("range") ?? "all",
      cursor: c.req.query("cursor"),
    };
    const result = feed(
      c.get("db"),
      c.get("user"),
      mode,
      options,
      c.get("now"),
      c.req.path,
    );
    if (c.req.header("accept")?.includes("application/json"))
      return c.json({
        html: (
          await (
            <>
              {result.posts.map((post) => (
                <PostCard c={c} post={post} />
              ))}
            </>
          )
        ).toString(),
        next: result.next,
      });
    const page = (
      <Feed
        c={c}
        result={result}
        mode={mode}
        title={title}
        options={options}
        sidebar={sidebar(c.get("db"), c.get("now"))}
      />
    );
    if (c.get("user") && !options.cursor)
      c.get("db")
        .prepare("UPDATE users SET last_home_seen=? WHERE id=?")
        .run(c.get("now"), c.get("user")!.id);
    return c.html(page);
  };
  app.get("/", (c) => showFeed(c, "hot", "社区热门"));
  app.get("/hot", (c) => showFeed(c, "hot", "社区热门"));
  app.get("/latest", (c) => showFeed(c, "latest", "最新发现"));
  app.get("/featured", (c) => showFeed(c, "featured", "精华与榜单"));
  app.get("/c/:slug", (c) => {
    const category = c
      .get("db")
      .prepare("SELECT * FROM categories WHERE slug=? AND active=1")
      .get(c.req.param("slug")) as Category | undefined;
    if (!category) throw new FormError("板块不存在", {}, 404);
    return showFeed(c, "category", category.name, String(category.id));
  });
  app.get("/t/:name", (c) =>
    showFeed(c, "tag", `#${c.req.param("name")}`, "", c.req.param("name")),
  );
  app.get("/tags", (c) =>
    c.html(<TagsPage c={c} tags={tagCounts(c.get("db"))} />),
  );
  app.get("/search", (c) => {
    const options = searchOptions(c);
    return c.html(
      <SearchPage
        c={c}
        options={options}
        result={search(c.get("db"), options, c.get("now"))}
      />,
    );
  });
  app.get("/search/suggest", (c) => {
    limit(c.get("db"), "search", c.get("ipKey"), 30, 60000, c.get("now"));
    const options = searchOptions(c);
    return c.json({
      items: options.q
        ? search(c.get("db"), options, c.get("now"), 6).items
        : [],
    });
  });
  app.get("/u/:name", (c) => {
    const db = c.get("db"),
      name = c.req.param("name");
    let profile = db
      .prepare("SELECT * FROM users WHERE username_key=? AND banned=0 AND profile_pending=0")
      .get(usernameKey(name)) as User | undefined;
    if (!profile && /^\d+$/.test(name)) {
      profile = db
        .prepare("SELECT * FROM users WHERE id=? AND banned=0 AND profile_pending=0")
        .get(name) as User | undefined;
      if (profile)
        return c.redirect(`/u/${encodeURIComponent(profile.username)}`, 301);
    }
    if (!profile) throw new FormError("用户不存在", {}, 404);
    const ids = db
      .prepare(
        "SELECT id FROM posts WHERE author_id=? AND status='public' ORDER BY created_at DESC LIMIT 30",
      )
      .all(profile.id) as { id: number }[];
    const replies = db
      .prepare(
        "SELECT r.post_id,r.floor,r.body,p.title FROM replies r JOIN posts p ON p.id=r.post_id JOIN users u ON u.id=p.author_id WHERE r.author_id=? AND r.deleted=0 AND r.status='public' AND p.status='public' AND u.banned=0 AND u.profile_pending=0 ORDER BY r.created_at DESC LIMIT 30",
      )
      .all(profile.id) as {
      post_id: number;
      floor: number;
      body: string;
      title: string;
    }[];
    const stats = db
      .prepare(
        "SELECT COUNT(*) posts,(SELECT COUNT(*) FROM votes v JOIN posts p ON p.id=v.post_id WHERE p.author_id=? AND p.status='public') votes FROM posts WHERE author_id=? AND status='public'",
      )
      .get(profile.id, profile.id) as { posts: number; votes: number };
    return c.html(
      <ProfilePage
        c={c}
        profile={profile}
        tab={c.req.query("tab") ?? "posts"}
        posts={ids.map((x) => getPost(db, x.id, c.get("user")))}
        replies={replies}
        stats={stats}
      />,
    );
  });
  app.get("/download", (c) => c.html(<DownloadPage c={c} />));
  const rss = (c: Context<Env>, category = "", tag = "") => {
    const rows = c
      .get("db")
      .prepare(
        `SELECT p.id,p.title,p.created_at,u.username FROM posts p JOIN users u ON u.id=p.author_id WHERE p.status='public' AND u.banned=0 AND u.profile_pending=0 AND (@category='' OR p.category_id=@category) AND (@tag='' OR EXISTS(SELECT 1 FROM post_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.post_id=p.id AND t.name=@tag)) ORDER BY p.created_at DESC,p.id DESC LIMIT 30`,
      )
      .all({ category, tag }) as {
      id: number;
      title: string;
      created_at: number;
      username: string;
    }[];
    const escape = (value: string) =>
      value.replace(
        /[<>&"']/g,
        (c) =>
          ({
            "<": "&lt;",
            ">": "&gt;",
            "&": "&amp;",
            '"': "&quot;",
            "'": "&apos;",
          })[c]!,
      );
    const site = c.get("config").siteUrl;
    return c.body(
      `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>BuildMe 社区</title><link>${escape(site)}</link><description>最新的 Agent 学习与实践</description>${rows.map((p) => `<item><title>${escape(p.title)}</title><link>${escape(site)}/p/${p.id}</link><guid>${escape(site)}/p/${p.id}</guid><dc:creator>${escape(p.username)}</dc:creator><pubDate>${new Date(p.created_at).toUTCString()}</pubDate></item>`).join("")}</channel></rss>`,
      200,
      { "Content-Type": "application/rss+xml; charset=utf-8" },
    );
  };
  app.get("/feed.xml", (c) => rss(c));
  app.get("/c/:slug/feed.xml", (c) => {
    const row = c
      .get("db")
      .prepare("SELECT id FROM categories WHERE slug=? AND active=1")
      .get(c.req.param("slug")) as { id: number } | undefined;
    if (!row) throw new FormError("板块不存在", {}, 404);
    return rss(c, String(row.id));
  });
  app.get("/t/:name/feed.xml", (c) => rss(c, "", c.req.param("name")));
}
