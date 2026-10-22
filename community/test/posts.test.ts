import { describe, it, expect, vi } from "vitest";
import sharp from "sharp";
import { randomBytes } from "node:crypto";
import { fixture, browser } from "./helpers.js";
import { register } from "../src/lib/auth.js";
import { SafeFetcher, RemoteError, type Transport } from "../src/lib/remote.js";
import { renderMarkdown } from "../src/lib/markdown.js";
import { saveImage } from "../src/lib/images.js";
import { LocalStorage } from "../src/lib/storage.js";
import { join } from "node:path";
const content = {
  title: "我的第一篇学习笔记",
  category: "2",
  body: "# 学习笔记\n\n从一个小问题开始。",
  editorId: "new",
};
async function author(f: Awaited<ReturnType<typeof fixture>>) {
  const b = browser(f.app);
  await b.login();
  await b.request("/new");
  return b;
}
function postId(response: Response) {
  return Number(response.headers.get("location")!.match(/\/p\/(\d+)/)![1]);
}
describe("C2 内容闭环", () => {
  it("P-3 空标题、超长、无板块、正文过长和非法链接被拒绝，输入保留", async () => {
    const f = await fixture();
    const b = await author(f);
    for (const values of [
      { title: "" },
      { title: "字".repeat(81) },
      { category: "" },
      { body: "字".repeat(50001) },
      { link: "javascript:alert(1)" },
    ] as Record<string, string>[]) {
      const response = await b.post("/new", { ...content, ...values });
      expect(response.status).toBe(422);
      expect(await response.text()).toContain("请检查标出的内容");
    }
    expect(f.db.prepare("SELECT COUNT(*) n FROM posts").get()).toEqual({
      n: 0,
    });
    await f.close();
  });
  it("P-2 链接超时仍可手填标题发布", async () => {
    const remote = new SafeFetcher(
      async () => [{ address: "8.8.8.8", family: 4 }],
      async () => {
        throw new RemoteError("链接解析超时");
      },
    );
    const f = await fixture({ remote });
    const b = await author(f);
    const response = await b.post("/new", {
      ...content,
      link: "https://example.test/story",
    });
    expect(response.status).toBe(303);
    const detail = await (
      await b.request(response.headers.get("location")!)
    ).text();
    expect(detail).toContain(content.title);
    expect(detail).toContain("example.test");
    await f.close();
  });
  it("P-4 两万字长文的预览发布一致，表格任务代码目录和图片均保留", async () => {
    const f = await fixture();
    const b = await author(f);
    const png = await sharp({
      create: { width: 20, height: 20, channels: 3, background: "#c4582f" },
    })
      .png()
      .toBuffer();
    const upload = await b.post(
      "/images",
      { image: new Blob([new Uint8Array(png)], { type: "image/png" }) },
      true,
    );
    expect(upload.status).toBe(200);
    const image = (await upload.json()) as { url: string };
    const body =
      "# 标题\n\n## 子标题\n\n| 姓名 | 进度 |\n| --- | --- |\n| 同学 | 完成 |\n\n- [x] 已完成\n\n```js\nconst count = 1;\n```\n\n" +
      `![截图](${image.url})\n\n` +
      "实践记录很重要。".repeat(3000) +
      " 🎉";
    const preview = (await (
      await b.post("/preview", { body }, true)
    ).json()) as { html: string; toc: unknown[] };
    const response = await b.post("/new", { ...content, body });
    expect(response.status).toBe(303);
    const row = f.db
      .prepare("SELECT html,toc FROM posts WHERE id=?")
      .get(postId(response)) as { html: string; toc: string };
    expect(row.html).toBe(preview.html);
    expect(JSON.parse(row.toc)).toEqual(preview.toc);
    for (const token of [
      "<table>",
      'type="checkbox"',
      "hljs",
      'loading="lazy"',
      image.url,
    ])
      expect(row.html).toContain(token);
    expect((await b.request(image.url)).status).toBe(200);
    await f.close();
  });
  it("P-5 Markdown 不执行 HTML 和危险链接；P-6 外站图片只产生链接", async () => {
    const f = await fixture();
    const result = renderMarkdown(
      f.db,
      "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[坏链接](javascript:alert(1))\n\n![外站](https://outside.test/image.jpg)\n\n![协议](//outside.test/another.jpg)",
      f.config.siteUrl,
    );
    expect(result.html).not.toMatch(/<script|<img|href="javascript:/);
    expect(result.html).toContain("&lt;script&gt;");
    expect(result.html).toContain('href="https://outside.test/image.jpg"');
    await f.close();
  });
  it("P-7 真格式校验、移除 EXIF、缩到2400、640缩略图和伪造图片拒绝", async () => {
    const f = await fixture();
    const storage = new LocalStorage(join(f.config.dataDir, "media"));
    const source = await sharp(randomBytes(3200 * 1800 * 3), {
      raw: { width: 3200, height: 1800, channels: 3 },
    })
      .jpeg({ quality: 95 })
      .withExif({
        IFD0: { Artist: "private" },
        IFD3: {
          GPSLatitudeRef: "N",
          GPSLatitude: "31/1 12/1 0/1",
          GPSLongitudeRef: "E",
          GPSLongitude: "121/1 30/1 0/1",
        },
      })
      .toBuffer();
    expect(source.length).toBeGreaterThan(5_500_000);
    expect(source.length).toBeLessThan(6_500_000);
    expect((await sharp(source).metadata()).exif).toBeDefined();
    const saved = await saveImage(f.db, storage, 1, source, f.now);
    const result = await sharp(
      await storage.get(saved.url.replace("/media/", "")),
    ).metadata();
    expect(result.format).toBe("webp");
    expect(result.exif).toBeUndefined();
    expect(result.width).toBeLessThanOrEqual(2400);
    expect(
      (
        await sharp(
          await storage.get(saved.thumbUrl.replace("/media/", "")),
        ).metadata()
      ).width,
    ).toBe(640);
    await expect(
      saveImage(
        f.db,
        storage,
        1,
        Buffer.from("<script>image.jpg</script>"),
        f.now,
      ),
    ).rejects.toThrow("有效");
    await expect(
      saveImage(f.db, storage, 1, Buffer.alloc(8 * 1024 * 1024 + 1), f.now),
    ).rejects.toThrow("8MB");
    await f.close();
  });
  it("P-10 编辑保留最近十个版本，24小时后标题锁定", async () => {
    const f = await fixture();
    const b = await author(f);
    const response = await b.post("/new", content);
    const id = postId(response);
    for (let i = 0; i < 12; i++) {
      f.setNow(f.now + 1000);
      expect(
        (
          await b.post(`/p/${id}/edit`, {
            ...content,
            title: `第 ${i} 次编辑`,
            body: "全新知识词",
          })
        ).status,
      ).toBe(303);
    }
    const versions = f.db
      .prepare("SELECT COUNT(*) n FROM post_versions WHERE post_id=?")
      .get(id);
    expect(versions).toEqual({ n: 10 });
    const detail = await (await b.request(`/p/${id}`)).text();
    expect(detail).toContain("编辑于");
    expect(
      f.db
        .prepare(
          "SELECT rowid FROM posts_fts WHERE posts_fts MATCH '全新知识词'",
        )
        .all(),
    ).toHaveLength(1);
    expect(
      f.db
        .prepare("SELECT rowid FROM posts_fts WHERE posts_fts MATCH '学习笔记'")
        .all(),
    ).toHaveLength(0);
    const user = await register(
      f.db,
      "编辑用户",
      "password123",
      f.invite(),
      f.now,
    );
    f.db.prepare("UPDATE posts SET author_id=? WHERE id=?").run(user.id, id);
    f.setNow(f.now + 86400001);
    const ordinary = browser(f.app);
    await ordinary.login(user.username, "password123");
    await ordinary.request("/settings");
    expect(
      (
        await ordinary.post(`/p/${id}/edit`, {
          ...content,
          title: "超过时间的新标题",
        })
      ).status,
    ).toBe(422);
    await f.close();
  });
  it("P-11 软删除隐藏详情、回复、列表和全文索引", async () => {
    const f = await fixture();
    const b = await author(f);
    const id = postId(await b.post("/new", content));
    await b.post(`/p/${id}/reply`, { body: "一条回复" });
    await b.post(`/p/${id}/delete`);
    expect(await (await b.request("/latest")).text()).not.toContain(
      content.title,
    );
    expect(await (await b.request(`/p/${id}`)).text()).toContain(
      "这条帖子已删除",
    );
    expect(
      f.db.prepare("SELECT * FROM posts_fts WHERE rowid=?").all(id),
    ).toHaveLength(0);
    expect(
      (await b.post(`/p/${id}/reply`, { body: "不能继续回复" })).status,
    ).toBe(404);
    await f.close();
  });
  it("P-12 纯HTML表单注册发帖审核回复点赞，重复点赞幂等", async () => {
    const f = await fixture();
    const admin = await author(f);
    const id = postId(await admin.post("/new", content));
    const member = browser(f.app);
    await member.request("/register");
    await member.post("/register", {
      username: "小同学",
      password: "password123",
      invite: f.invite(),
    });
    await member.request(`/p/${id}`);
    expect(
      (await member.post(`/p/${id}/reply`, { body: "感谢分享！" })).status,
    ).toBe(303);
    expect((await member.post(`/p/${id}/vote`, { active: "1" })).status).toBe(
      303,
    );
    await member.post(`/p/${id}/vote`, { active: "1" });
    expect(
      f.db.prepare("SELECT COUNT(*) n FROM votes WHERE post_id=?").get(id),
    ).toEqual({ n: 1 });
    const first = postId(
      await member.post("/new", { ...content, title: "新同学的首篇帖子" }),
    );
    expect(await (await f.app.request("/latest")).text()).not.toContain(
      "新同学的首篇帖子",
    );
    expect(await (await member.request(`/p/${first}`)).text()).toContain(
      "审核中",
    );
    await admin.post(`/admin/posts/${first}/approve`);
    expect(await (await f.app.request("/latest")).text()).toContain(
      "新同学的首篇帖子",
    );
    await f.close();
  });
  it("服务器草稿隔离所有权，20篇上限，发布删除对应草稿", async () => {
    const f = await fixture();
    const b = await author(f);
    const first = await b.post("/drafts", { ...content, title: "" });
    expect(first.status).toBe(303);
    expect(
      await (await b.request(first.headers.get("location")!)).text(),
    ).toContain(content.body);
    for (let i = 1; i < 20; i++)
      expect((await b.post("/drafts", content)).status).toBe(303);
    expect((await b.post("/drafts", content)).status).toBe(422);
    const user = await register(
      f.db,
      "旁观用户",
      "password123",
      f.invite(),
      f.now,
    );
    const other = browser(f.app);
    await other.login(user.username, "password123");
    expect((await other.request("/drafts/1")).status).toBe(404);
    await b.post("/new", { ...content, draftId: "1", editorId: "draft-1" });
    expect(
      f.db.prepare("SELECT 1 FROM drafts WHERE id=1").get(),
    ).toBeUndefined();
    await f.close();
  });
  it("快速分享返回实际帖子HTML和审核状态，不伪造计数", async () => {
    const f = await fixture();
    const b = await author(f);
    const response = await b.post("/new", content, true);
    expect(response.status).toBe(201);
    const data = (await response.json()) as {
      html: string;
      pending: boolean;
      url: string;
    };
    expect(data.html).toContain(content.title);
    expect(data.pending).toBe(false);
    expect(data.url).toMatch(/^\/p\/\d+/);
    expect(data.html).toContain("0 条回复");
    await f.close();
  });
});
describe("链接网络边界", () => {
  it("P-8 所有本机、内网、链路本地、IPv6、映射IPv4及非法端口均不发出请求", async () => {
    const transport = vi.fn<Transport>();
    const remote = new SafeFetcher(
      async () => [{ address: "10.0.0.1", family: 4 }],
      transport,
    );
    for (const url of [
      "http://127.0.0.1",
      "http://169.254.169.254",
      "http://10.0.0.1",
      "http://[::1]",
      "http://[::ffff:127.0.0.1]",
      "http://public.test",
      "http://example.test:8080",
    ])
      await expect(remote.get(url)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it("P-8 每次重定向重新检查DNS并把已验证IP传给传输层", async () => {
    const sent: string[] = [];
    const transport: Transport = async (url, address) => {
      sent.push(`${url.hostname}:${address.address}`);
      return {
        status: 302,
        headers: { location: "http://private.test" },
        body: Buffer.alloc(0),
        url: url.href,
      };
    };
    const remote = new SafeFetcher(
      async (host) => [
        {
          address: host === "public.test" ? "8.8.8.8" : "127.0.0.1",
          family: 4,
        },
      ],
      transport,
    );
    await expect(remote.get("https://public.test")).rejects.toThrow("内网");
    expect(sent).toEqual(["public.test:8.8.8.8"]);
  });
  it("超时和超过三次跳转被拒绝", async () => {
    const remote = new SafeFetcher(
      async () => [{ address: "8.8.8.8", family: 4 }],
      async (url) => ({
        status: 302,
        headers: { location: url.href },
        body: Buffer.alloc(0),
        url: url.href,
      }),
    );
    await expect(remote.get("https://public.test")).rejects.toThrow("跳转");
    const hung = new SafeFetcher(() => new Promise(() => {}));
    await expect(
      hung.get("https://public.test", { timeoutMs: 10 }),
    ).rejects.toThrow("超时");
  });
});
