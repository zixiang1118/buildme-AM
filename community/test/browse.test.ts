import { it, expect } from "vitest";
import { fixture, browser } from "./helpers.js";
import {
  feed,
  hotScore,
  refreshHot,
  search,
  type SearchOptions,
} from "../src/lib/browse.js";
import { renderMarkdown } from "../src/lib/markdown.js";
type Fixture = Awaited<ReturnType<typeof fixture>>;
function post(
  f: Fixture,
  title: string,
  body = "正文学习内容",
  at = f.now,
  author = 1,
  category = 2,
) {
  const rendered = renderMarkdown(f.db, body, f.config.siteUrl);
  return Number(
    f.db
      .prepare(
        "INSERT INTO posts(author_id,category_id,title,body,html,excerpt,toc,tags_text,status,created_at,last_activity) VALUES (?,?,?,?,?,?,?,'','public',?,?)",
      )
      .run(
        author,
        category,
        title,
        body,
        rendered.html,
        rendered.excerpt,
        JSON.stringify(rendered.toc),
        at,
        at,
      ).lastInsertRowid,
  );
}
const options: SearchOptions = {
  q: "",
  type: "posts",
  category: "",
  tag: "",
  author: "",
  range: "all",
  sort: "relevance",
  page: 1,
};
it("B-1 首页默认热门且按热度公式排序，每五分钟刷新", async () => {
  const f = await fixture(),
    a = post(f, "同期的一个帖子"),
    b = post(f, "同期的另一个帖子");
  f.db.prepare("INSERT INTO votes VALUES (?,?,?)").run(b, 1, f.now);
  const rows = feed(
    f.db,
    null,
    "hot",
    { sort: "hot", category: "", tag: "", range: "all" },
    f.now,
    "/",
  );
  expect(rows.posts.map((p) => p.id)).toEqual([b, a]);
  expect(rows.posts[0].hot_score).toBeCloseTo(hotScore(1, 0, 0, 0));
  const score = (
    f.db.prepare("SELECT hot_score FROM posts WHERE id=?").get(b) as {
      hot_score: number;
    }
  ).hot_score;
  refreshHot(f.db, f.now + 60000);
  expect(
    (
      f.db.prepare("SELECT hot_score FROM posts WHERE id=?").get(b) as {
        hot_score: number;
      }
    ).hot_score,
  ).toBe(score);
  expect((await f.app.request("/")).status).toBe(200);
  await f.close();
});
it("B-2 旧帖新回复提升最后活动时间", async () => {
  const f = await fixture(),
    old = post(f, "较早发布的文章", "正文", f.now - 86400000);
  post(f, "刚刚发布的文章");
  f.setNow(f.now + 1000);
  const b = browser(f.app);
  await b.login();
  await b.request(`/p/${old}`);
  await b.post(`/p/${old}/reply`, { body: "新回复推动活动时间" });
  expect(
    feed(
      f.db,
      null,
      "latest",
      { sort: "active", category: "", tag: "", range: "all" },
      f.now,
      "/latest",
    ).posts[0].id,
  ).toBe(old);
  await f.close();
});
it("B-3 分页快照在插入新帖和旧帖更新活动时间后不重复或漏帖", async () => {
  const f = await fixture();
  for (let n = 0; n < 65; n++) post(f, `分页测试帖子 ${n}`, "正文", f.now - n);
  const opts = { sort: "active", category: "", tag: "", range: "all" };
  let page = feed(f.db, null, "latest", opts, f.now, "/latest");
  const ids = page.posts.map((p) => p.id);
  post(f, "分页途中新增的帖子");
  f.db.prepare("UPDATE posts SET last_activity=? WHERE id=1").run(f.now + 1000);
  while (page.next) {
    page = feed(
      f.db,
      null,
      "latest",
      {
        ...opts,
        cursor: new URL(page.next, f.config.siteUrl).searchParams.get(
          "cursor",
        )!,
      },
      f.now,
      "/latest",
    );
    ids.push(...page.posts.map((p) => p.id));
  }
  expect(ids).toHaveLength(65);
  expect(new Set(ids).size).toBe(65);
  expect(ids).not.toContain(66);
  await f.close();
});
it("B-4 板块标签和精华榜时间范围、置顶顺序正确", async () => {
  const f = await fixture(),
    a = post(f, "精华学习文章"),
    old = post(f, "很早以前的精华", "正文", f.now - 40 * 86400000),
    other = post(f, "问答板块文章", "正文", f.now, 1, 3);
  f.db.prepare("UPDATE posts SET featured=1 WHERE id IN (?,?)").run(a, old);
  f.db.prepare("INSERT INTO post_tags VALUES (?,1)").run(a);
  expect(
    feed(
      f.db,
      null,
      "featured",
      { sort: "featured", range: "week", category: "", tag: "" },
      f.now,
      "/featured",
    ).posts.map((p) => p.id),
  ).toEqual([a]);
  expect(
    feed(
      f.db,
      null,
      "latest",
      { sort: "created", range: "all", category: "3", tag: "" },
      f.now,
      "/latest",
    ).posts.map((p) => p.id),
  ).toEqual([other]);
  expect(
    feed(
      f.db,
      null,
      "tag",
      { sort: "created", range: "all", category: "", tag: "harness" },
      f.now,
      "/t/harness",
    ).posts.map((p) => p.id),
  ).toEqual([a]);
  f.db.prepare("UPDATE posts SET pinned=1 WHERE id=?").run(old);
  expect(
    feed(
      f.db,
      null,
      "latest",
      { sort: "created", range: "all", category: "", tag: "" },
      f.now,
      "/latest",
    ).posts[0].id,
  ).toBe(old);
  await f.close();
});
it("B-5 摘要截取纯文字，HTML 使用两行摘要样式", async () => {
  const f = await fixture(),
    id = post(
      f,
      "摘要样式测试",
      "## 标题\n\n**粗体文字** 和 `代码`，" + "详细的内容。".repeat(60),
    );
  const row = f.db.prepare("SELECT excerpt FROM posts WHERE id=?").get(id) as {
    excerpt: string;
  };
  expect(row.excerpt).not.toMatch(/[#*`]/);
  expect(row.excerpt.length).toBeLessThanOrEqual(220);
  expect(await (await f.app.request("/latest")).text()).toContain(
    'class="excerpt"',
  );
  await f.close();
});
it("B-6 长词全文索引、两字中文、作者标签和短语语法；标题优先并高亮", async () => {
  const f = await fixture();
  const a = post(f, "harness 的上下文", "工具执行能力");
  post(f, "其他标题内容", "harness 上下文中的执行顺序");
  f.db.prepare("INSERT INTO post_tags VALUES (?,1)").run(a);
  expect(search(f.db, { ...options, q: "harness" }, f.now).items[0].id).toBe(a);
  expect(
    search(f.db, { ...options, q: "工具" }, f.now).items.map((x) => x.id),
  ).toEqual([a]);
  expect(
    search(
      f.db,
      { ...options, q: '@管理员 #harness "上下文"' },
      f.now,
    ).items.map((x) => x.id),
  ).toEqual([a]);
  const response = await f.app.request("/search?q=harness");
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("<mark>harness</mark>");
  await f.close();
});
it("B-7 编辑、软删除、隐藏和封禁内容立即退出搜索", async () => {
  const f = await fixture(),
    id = post(f, "搜索同步测试", "旧的长词 alpha");
  expect(search(f.db, { ...options, q: "alpha" }, f.now).items).toHaveLength(1);
  f.db.prepare("UPDATE posts SET body=? WHERE id=?").run("新的长词 bravo", id);
  expect(search(f.db, { ...options, q: "alpha" }, f.now).items).toHaveLength(0);
  expect(search(f.db, { ...options, q: "bravo" }, f.now).items).toHaveLength(1);
  for (const status of ["hidden", "deleted"]) {
    f.db.prepare("UPDATE posts SET status=? WHERE id=?").run(status, id);
    expect(search(f.db, { ...options, q: "bravo" }, f.now).items).toHaveLength(
      0,
    );
  }
  f.db.prepare("UPDATE posts SET status='public' WHERE id=?").run(id);
  f.db.prepare("UPDATE users SET banned=1 WHERE id=1").run();
  expect(search(f.db, { ...options, q: "bravo" }, f.now).items).toHaveLength(0);
  await f.close();
});
it("B-13 最新与板块、标签 RSS 包含最多30条并转义 XML", async () => {
  const f = await fixture();
  for (let n = 0; n < 32; n++) post(f, `RSS & <测试> ${n}`, "正文", f.now + n);
  const response = await f.app.request("/feed.xml"),
    xml = await response.text();
  expect(response.headers.get("content-type")).toContain("application/rss+xml");
  expect(xml.match(/<item>/g)).toHaveLength(30);
  expect(xml).toContain("&amp; &lt;测试&gt;");
  expect(xml).toContain("<dc:creator>管理员</dc:creator>");
  expect((await f.app.request("/c/article/feed.xml")).status).toBe(200);
  expect((await f.app.request("/t/harness/feed.xml")).status).toBe(200);
  await f.close();
});
it("B-6 回复和用户搜索保留各自权限范围", async () => {
  const f = await fixture(),
    id = post(f, "回复检索文章");
  f.db
    .prepare(
      "INSERT INTO replies(post_id,author_id,floor,body,html,created_at) VALUES (?,1,1,'harness 回复内容','<p>harness 回复内容</p>',?)",
    )
    .run(id, f.now);
  const found = search(
    f.db,
    { ...options, q: "harness", type: "replies" },
    f.now,
  );
  expect(found.items[0].href).toBe(`/p/${id}?page=1#1`);
  expect(
    search(f.db, { ...options, q: "管理", type: "users" }, f.now).items[0]
      .title,
  ).toBe("管理员");
  f.db.prepare("UPDATE posts SET status='hidden' WHERE id=?").run(id);
  expect(
    search(f.db, { ...options, q: "harness", type: "replies" }, f.now).items,
  ).toHaveLength(0);
  await f.close();
});
