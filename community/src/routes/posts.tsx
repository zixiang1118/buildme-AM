import type { Hono, Context } from "hono";
import type { Env, User } from "../types.js";
import { Layout, Csrf, Empty } from "../views/layout.js";
import { AuthPage, pageProps } from "../views/forms.js";
import { getWork, editWork, prepareCover, writeWork } from "../lib/works.js";
import { replyRows, maxFloor, notifyMentions, notify } from "../lib/interactions.js";
import {
  Editor,
  Detail,
  PostCard,
} from "../views/posts.js";
import { FormError, length, textField } from "../lib/validation.js";
import { requireUser, requireAdmin, requireStaff } from "../lib/session.js";
import { limit, logAdmin } from "../lib/auth.js";
import { SafeFetcher } from "../lib/remote.js";
import { resolveLink, duplicateLink, linkSource } from "../lib/links.js";
import { saveImage } from "../lib/images.js";
import { renderMarkdown, referenceImages } from "../lib/markdown.js";
import {
  postInput,
  blankPost,
  validatePost,
  getPost,
  checkPostingLimits,
  canWrite,
  type Post,
  type PostInput,
} from "../lib/posts.js";
import { firstPostReview, moderationStatus, rejectDuplicate, checkWords } from "../lib/moderation.js";
function isJson(c: Context<Env>) {
  return c.req.header("accept")?.includes("application/json");
}
function editAllowed(user: User, post: Post) {
  if (user.id !== post.author_id && user.role !== "admin")
    throw new FormError("不能修改他人的帖子", {}, 403);
}
function positivePage(raw: string | undefined) {
  const value = Number(raw ?? 1);
  return Number.isInteger(value) && value > 0 ? Math.min(value, 1000000) : 1;
}
function showEditorError(
  c: Context<Env>,
  values: PostInput,
  error: unknown,
  post?: Post,
) {
  if (!(error instanceof FormError)) throw error;
  if (isJson(c))
    return c.json({ error: error.message, fields: error.fields }, error.status);
  return c.html(
    <Editor c={c} values={values} error={error} post={post} />,
    error.status,
  );
}
export function posts(app: Hono<Env>, remote: SafeFetcher) {
  app.get("/new", (c) => {
    if(!c.get("user"))return c.html(<AuthPage c={c}/>);
    return c.html(<Editor c={c} values={{...blankPost(),category:c.req.query("category") ?? "1"}} />);
  });
  app.post("/preview", async (c) => {
    requireUser(c);
    const values = postInput(await c.req.formData());
    if (length(values.body) > 50000)
      throw new FormError("正文不能超过 50,000 字", {
        body: "正文不能超过 50,000 字",
      });
    const rendered = renderMarkdown(
      c.get("db"),
      values.body,
      c.get("config").siteUrl,
    );
    if (isJson(c)) return c.json({ html: rendered.html, toc: rendered.toc });
    let post: Post | undefined;
    if (/^post-\d+$/.test(values.editorId)) {
      post = getPost(
        c.get("db"),
        Number(values.editorId.slice(5)),
        c.get("user"),
      );
      editAllowed(c.get("user")!, post);
    }
    return c.html(
      <Editor c={c} values={values} post={post} preview={rendered} />,
    );
  });
  app.post("/images", async (c) => {
    const user = requireUser(c),
      form = await c.req.formData(),
      values = postInput(form);
    try {
      limit(
        c.get("db"),
        "image-hour",
        String(user.id),
        60,
        3600000,
        c.get("now"),
      );
      limit(
        c.get("db"),
        "image-day",
        String(user.id),
        200,
        86400000,
        c.get("now"),
      );
      const file = form.get("image");
      if (!(file instanceof File)) throw new FormError("请选择图片");
      const image = await saveImage(
        c.get("db"),
        c.get("storage"),
        user.id,
        Buffer.from(await file.arrayBuffer()),
        c.get("now"),
      );
      if (isJson(c)) return c.json(image);
      values.body += `\n\n![图片](${image.url})\n`;
      return c.html(
        <Editor
          c={c}
          values={values}
          preview={renderMarkdown(
            c.get("db"),
            values.body,
            c.get("config").siteUrl,
          )}
          notice="图片已插入正文，请继续编辑或发布"
        />,
      );
    } catch (error) {
      return showEditorError(c, values, error);
    }
  });
  app.post("/links/resolve", async (c) => {
    const user = requireUser(c);
    limit(c.get("db"), "link", String(user.id), 10, 60000, c.get("now"));
    const link = textField(await c.req.formData(), "link");
    return c.json(
      await resolveLink(
        c.get("db"),
        c.get("storage"),
        remote,
        user.id,
        link,
        c.get("now"),
      ),
    );
  });
  async function savePost(c: Context<Env>, old?: Post) {
    const user = requireUser(c),
      db = c.get("db"),
      now = c.get("now"),
      values = postInput(await c.req.formData());
    try {
      validatePost(db, values);
      canWrite(user, now);
      if (old) {
        editAllowed(user, old);
        if (
          old.title !== values.title &&
          now - old.created_at > 86400000 &&
          user.role !== "admin"
        )
          throw new FormError("发布 24 小时后修改标题需要管理员权限", {
            title: "发布 24 小时后不能修改标题",
          });
      }
      if (
        values.draftId &&
        !db
          .prepare("SELECT 1 FROM drafts WHERE id=? AND author_id=?")
          .get(values.draftId, user.id)
      )
        throw new FormError("草稿不存在", {}, 404);
      const duplicate = values.link
        ? duplicateLink(db, values.link, now, old?.id)
        : undefined;
      if (duplicate && values.confirmDuplicate !== "1")
        throw new FormError(
          `这个链接 ${duplicate.days} 天前 @${duplicate.username} 分享过（帖子 #${duplicate.id}），请勾选继续发布或返回原帖`,
          { link: `已有分享：/p/${duplicate.id}` },
          409,
        );
      if (!old) {rejectDuplicate(db,user.id,values.title+values.body+values.link,now);checkPostingLimits(db, user, now, values);}
      let info = {
        title: values.title,
        source: values.link ? linkSource(values.link) : "",
        thumbnail: "",
      };
      if (values.link) {
        try {
          info = await resolveLink(
            db,
            c.get("storage"),
            remote,
            user.id,
            values.link,
            now,
          );
        } catch (error) {
          if (!(error instanceof FormError)) throw error;
        }
      }
      const status=moderationStatus(db,user,[values.title,values.body,values.link,info.title,values.work.summary,values.work.demoUrl,values.work.sourceUrl].join(" "),now,c.get("config").siteUrl);
      const rendered = renderMarkdown(db, values.body, c.get("config").siteUrl);
      if (rendered.imageCount > 30)
        throw new FormError("每帖最多 30 张图片", {
          body: "每帖最多 30 张图片",
        });
      const work = old ? getWork(db,old.id,user) : undefined;
      const coverId = values.category === "4" ? await prepareCover(db,c.get("storage"),user,values.work,now,work) : null;
      const tagNames = values.tags
        .map(
          (id) =>
            (
              db.prepare("SELECT name FROM tags WHERE id=?").get(id) as {
                name: string;
              }
            ).name,
        )
        .join("\n");
      const id = db.transaction(() => {
        let id: number;
        if (old) {
          db.prepare(
            "INSERT INTO post_versions(post_id,editor_id,data,created_at) VALUES (?,?,?,?)",
          ).run(
            old.id,
            user.id,
            JSON.stringify({
              title: old.title,
              body: old.body,
              category: old.category_id,
              link: old.link,
              tags: old.tags_text,
              work: work ?? null,
              shareData: old.share_data,
            }),
            now,
          );
          db.prepare(
            "DELETE FROM post_versions WHERE post_id=? AND id NOT IN (SELECT id FROM post_versions WHERE post_id=? ORDER BY id DESC LIMIT 10)",
          ).run(old.id, old.id);
          db.prepare(
            "UPDATE posts SET category_id=?,title=?,body=?,html=?,excerpt=?,toc=?,link=?,link_title=?,link_source=?,link_thumbnail=?,tags_text=?,updated_at=? WHERE id=?",
          ).run(
            values.category,
            values.title,
            values.body,
            rendered.html,
            rendered.excerpt,
            JSON.stringify(rendered.toc),
            values.link,
            info.title,
            info.source,
            info.thumbnail,
            tagNames,
            now,
            old.id,
          );
          if(status==='pending')db.prepare("UPDATE posts SET status='pending' WHERE id=?").run(old.id);
          id = old.id;
        } else {
          id = Number(
            db
              .prepare(
                "INSERT INTO posts(author_id,category_id,title,body,html,excerpt,toc,link,link_title,link_source,link_thumbnail,tags_text,status,created_at,last_activity) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                user.id,
                values.category,
                values.title,
                values.body,
                rendered.html,
                rendered.excerpt,
                JSON.stringify(rendered.toc),
                values.link,
                info.title,
                info.source,
                info.thumbnail,
                tagNames,
                status==='pending'||(firstPostReview(db)&&!user.first_post_approved&&user.role==='member') ? "pending" : "public",
                now,
                now,
              ).lastInsertRowid,
          );
        }
        db.prepare("UPDATE posts SET share_data=? WHERE id=?").run(values.shareData,id);
        db.prepare("DELETE FROM post_tags WHERE post_id=?").run(id);
        for (const tag of values.tags)
          db.prepare("INSERT INTO post_tags VALUES (?,?)").run(id, tag);
        if (coverId) writeWork(db,id,values.work,coverId);
        else if (work) {
          db.prepare('DELETE FROM work_harnesses WHERE post_id=?').run(id);
          db.prepare('DELETE FROM works WHERE post_id=?').run(id);
          db.prepare("UPDATE posts SET work_summary='' WHERE id=?").run(id);
        }
        const thumbnail = info.thumbnail
          ? (db
              .prepare("SELECT id FROM images WHERE thumb_url=?")
              .get(info.thumbnail) as { id: string } | undefined)
          : undefined;
        referenceImages(db, "post", id, [
          ...rendered.imageIds,
          ...(coverId ? [coverId] : []),
          ...(thumbnail ? [thumbnail.id] : []),
        ]);
        if (values.draftId) {
          db.prepare("DELETE FROM drafts WHERE id=? AND author_id=?").run(
            values.draftId,
            user.id,
          );
          db.prepare(
            "DELETE FROM image_refs WHERE kind='draft' AND entity_id=?",
          ).run(values.draftId);
        }
        if (!old && status==='public') notifyMentions(db, values.body, user.id, id, 0, now);
        return id;
      })();
      const editorId = /^(new|post-\d+|draft-\d+)$/.test(values.editorId)
        ? values.editorId
        : "new";
      const url = `/p/${id}?published=${editorId}`;
      if (isJson(c)) {
        const post = getPost(db, id, user);
        return c.json(
          {
            url,
            pending: post.status === "pending",
            html: await (<PostCard c={c} post={post} />).toString(),
          },
          old ? 200 : 201,
        );
      }
      return c.redirect(url, 303);
    } catch (error) {
      return showEditorError(c, values, error, old);
    }
  }
  app.post("/new", (c) => savePost(c));
  app.get("/p/:id", (c) => {
    const db = c.get("db"),
      post = getPost(db, Number(c.req.param("id")), c.get("user"));
    db.prepare("UPDATE posts SET views=views+1 WHERE id=?").run(post.id);
    post.views++;
    const page = positivePage(c.req.query("page"));
    const replies = replyRows(db, post.id, (page - 1) * 30 + 1);
    const key = c.req.query("published");
    const clearDraft =
      c.get("user")?.id === post.author_id &&
      key &&
      /^(new|post-\d+|draft-\d+)$/.test(key)
        ? key
        : undefined;
    return c.html(
      <Detail
        c={c}
        post={post}
        replies={replies}
        page={page}
        total={post.reply_count}
        max={maxFloor(db, post.id)}
        clearDraft={clearDraft}
      />,
    );
  });
  app.get("/p/:id/edit", (c) => {
    const user = requireUser(c),
      post = getPost(c.get("db"), Number(c.req.param("id")), user);
    editAllowed(user, post);
    const selected = c
      .get("db")
      .prepare("SELECT tag_id FROM post_tags WHERE post_id=?")
      .all(post.id) as { tag_id: number }[];
    return c.html(
      <Editor
        c={c}
        post={post}
        values={{
          ...blankPost(),
          work: editWork(getWork(c.get("db"),post.id,user)),
          shareData: post.share_data,
          title: post.title,
          body: post.body,
          category: String(post.category_id),
          link: post.link,
          tags: selected.map((t) => String(t.tag_id)),
          editorId: `post-${post.id}`,
          confirmDuplicate: "1",
        }}
      />,
    );
  });
  app.post("/p/:id/edit", (c) => {
    const user = requireUser(c),
      post = getPost(c.get("db"), Number(c.req.param("id")), user);
    editAllowed(user, post);
    return savePost(c, post);
  });
  app.post("/p/:id/delete", (c) => {
    const user = requireUser(c),
      db = c.get("db"),
      post = getPost(db, Number(c.req.param("id")), user);
    editAllowed(user, post);
    db.prepare("UPDATE posts SET status='deleted' WHERE id=?").run(post.id);
    if (user.role === "admin")
      logAdmin(db, user.id, "post.delete", String(post.id), c.get("now"));
    return c.redirect("/latest", 303);
  });
  app.get("/go/:id", (c) => {
    const db = c.get("db"),
      user = c.get("user"),
      post = getPost(db, Number(c.req.param("id")), user);
    if (!post.link) throw new FormError("这个帖子没有外部链接", {}, 404);
    const actor = user ? `user:${user.id}` : `ip:${c.get("ipKey")}`;
    db.transaction(() => {
      const prior = db
        .prepare(
          "SELECT clicked_at FROM click_events WHERE post_id=? AND actor=?",
        )
        .get(post.id, actor) as { clicked_at: number } | undefined;
      if (!prior || c.get("now") - prior.clicked_at >= 3600000) {
        db.prepare(
          "INSERT INTO click_events VALUES (?,?,?) ON CONFLICT(post_id,actor) DO UPDATE SET clicked_at=excluded.clicked_at",
        ).run(post.id, actor, c.get("now"));
        db.prepare("UPDATE posts SET clicks=clicks+1 WHERE id=?").run(post.id);
      }
    })();
    return c.redirect(post.link, 302);
  });
  app.get("/drafts", (c) => {
    const user = requireUser(c);
    const drafts = c
      .get("db")
      .prepare(
        "SELECT * FROM drafts WHERE author_id=? ORDER BY updated_at DESC",
      )
      .all(user.id) as { id: number; data: string; updated_at: number }[];
    return c.html(
      <Layout {...pageProps(c, "我的草稿")}>
        <div class="page-heading">
          <h1>我的草稿</h1>
          <a class="button primary" href="/new">
            写新文章
          </a>
        </div>
        {drafts.length ? (
          drafts.map((d) => (
            <article class="panel">
              <h2>
                <a href={`/drafts/${d.id}`}>
                  {(JSON.parse(d.data) as PostInput).title || "未命名草稿"}
                </a>
              </h2>
              <p class="muted">
                {new Date(d.updated_at).toLocaleString("zh-CN", {
                  timeZone: "Asia/Shanghai",
                })}
              </p>
              <form method="post" action={`/drafts/${d.id}/delete`}>
                <Csrf value={c.get("csrf")} />
                <button class="button">删除草稿</button>
              </form>
            </article>
          ))
        ) : (
          <Empty title="还没有服务器草稿">
            在编辑器里点击“保存草稿”，下次就能在这里继续。
          </Empty>
        )}
      </Layout>,
    );
  });
  app.get("/drafts/:id", (c) => {
    const user = requireUser(c),
      draft = c
        .get("db")
        .prepare("SELECT * FROM drafts WHERE id=? AND author_id=?")
        .get(c.req.param("id"), user.id) as
        { id: number; data: string } | undefined;
    if (!draft) throw new FormError("草稿不存在", {}, 404);
    return c.html(
      <Editor
        c={c}
        values={{ ...JSON.parse(draft.data), draftId: String(draft.id) }}
      />,
    );
  });
  app.post("/drafts", async (c) => {
    const user = requireUser(c),
      values = postInput(await c.req.formData()),
      db = c.get("db");
    try {
      validatePost(db, values, true);
      const rendered = renderMarkdown(db, values.body, c.get("config").siteUrl);
      if (values.work.coverId && !db.prepare('SELECT 1 FROM images WHERE id=? AND owner_id=?').get(values.work.coverId,user.id)) throw new FormError('封面不存在或不属于你',{coverId:'请重新上传封面'});
      const id = db.transaction(() => {
        let id: number;
        if (values.draftId) {
          const result = db
            .prepare(
              "UPDATE drafts SET data=?,updated_at=? WHERE id=? AND author_id=?",
            )
            .run(JSON.stringify(values), c.get("now"), values.draftId, user.id);
          if (!result.changes) throw new FormError("草稿不存在", {}, 404);
          id = Number(values.draftId);
        } else {
          if (
            (
              db
                .prepare("SELECT COUNT(*) n FROM drafts WHERE author_id=?")
                .get(user.id) as { n: number }
            ).n >= 20
          )
            throw new FormError("最多保存 20 篇草稿，请先删除旧草稿");
          id = Number(
            db
              .prepare(
                "INSERT INTO drafts(author_id,data,updated_at) VALUES (?,?,?)",
              )
              .run(user.id, JSON.stringify(values), c.get("now"))
              .lastInsertRowid,
          );
        }
        referenceImages(db, "draft", id, [...rendered.imageIds,...(values.work.coverId ? [values.work.coverId] : [])]);
        return id;
      })();
      return c.redirect(`/drafts/${id}`, 303);
    } catch (error) {
      return showEditorError(c, values, error);
    }
  });
  app.post("/drafts/:id/delete", (c) => {
    const user = requireUser(c),
      db = c.get("db");
    db.transaction(() => {
      const result = db
        .prepare("DELETE FROM drafts WHERE id=? AND author_id=?")
        .run(c.req.param("id"), user.id);
      if (result.changes)
        db.prepare(
          "DELETE FROM image_refs WHERE kind='draft' AND entity_id=?",
        ).run(c.req.param("id"));
    })();
    return c.redirect("/drafts", 303);
  });
  app.post("/tags/request", async (c) => {
    const user = requireUser(c),
      name = textField(await c.req.formData(), "name").trim();
    checkWords(c.get("db"),name);
    if (length(name) < 1 || length(name) > 24)
      throw new FormError("标签名需为 1–24 字");
    limit(
      c.get("db"),
      "tag-request",
      String(user.id),
      5,
      86400000,
      c.get("now"),
    );
    c.get("db")
      .prepare(
        "INSERT INTO tag_requests(user_id,name,created_at) VALUES (?,?,?)",
      )
      .run(user.id, name, c.get("now"));
    return c.html(
      <Layout
        {...pageProps(c, "标签已提交")}
        notice="新标签申请已提交，管理员批准后可用。"
      >
        <a href="/latest">返回社区</a>
      </Layout>,
    );
  });
  app.post("/admin/posts/:id/approve", (c) => {
    const admin = requireStaff(c),
      db = c.get("db"),
      post = getPost(db, Number(c.req.param("id")), admin);
    db.transaction(() => {
      db.prepare(
        "UPDATE posts SET status='public' WHERE id=? AND status='pending'",
      ).run(post.id);
      db.prepare("UPDATE users SET first_post_approved=1 WHERE id=?").run(
        post.author_id,
      );
      logAdmin(db, admin.id, "post.approve", String(post.id), c.get("now"));
      notify(db,post.author_id,admin.id,"moderation",null,0,c.get("now"),"你的帖子审核已通过",`/p/${post.id}`);
    })();
    return c.redirect("/admin/review", 303);
  });
  app.post("/admin/tags/:id/approve", (c) => {
    const admin = requireAdmin(c),
      db = c.get("db");
    const row = db
      .prepare("SELECT name FROM tag_requests WHERE id=? AND status='pending'")
      .get(c.req.param("id")) as { name: string } | undefined;
    if (!row) throw new FormError("申请不存在", {}, 404);
    db.transaction(() => {
      db.prepare(
        "INSERT INTO tags(name) VALUES (?) ON CONFLICT(name) DO UPDATE SET active=1",
      ).run(row.name);
      db.prepare("UPDATE tag_requests SET status='approved' WHERE id=?").run(
        c.req.param("id"),
      );
      logAdmin(db, admin.id, "tag.approve", c.req.param("id"), c.get("now"));
    })();
    return c.redirect("/admin/review", 303);
  });
  app.get("/admin/posts/:id/history", (c) => {
    requireStaff(c);
    const versions = c
      .get("db")
      .prepare(
        "SELECT data,created_at FROM post_versions WHERE post_id=? ORDER BY id DESC LIMIT 10",
      )
      .all(c.req.param("id")) as { data: string; created_at: number }[];
    return c.html(
      <Layout {...pageProps(c, "编辑历史")}>
        <h1>最近十次编辑历史</h1>
        {versions.map((v) => {
          const data = JSON.parse(v.data) as { title: string; body: string };
          return (
            <section class="panel">
              <h2>{data.title}</h2>
              <time>
                {new Date(v.created_at).toLocaleString("zh-CN", {
                  timeZone: "Asia/Shanghai",
                })}
              </time>
              <pre>{data.body}</pre>
            </section>
          );
        })}
      </Layout>,
    );
  });
}
