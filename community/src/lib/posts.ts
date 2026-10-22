import type { Db } from "../db/index.js";
import type { User, Category, Tag } from "../types.js";
import { FormError, length, httpUrl, textField } from "./validation.js";
import { blankWork, workInput, validateWork, type WorkInput } from "./works.js";
import { parseShare } from "./share.js";
import { limit } from "./auth.js";
export interface Post {
  share_data: string;
  id: number;
  author_id: number;
  category_id: number;
  title: string;
  body: string;
  html: string;
  excerpt: string;
  toc: string;
  link: string;
  link_title: string;
  link_source: string;
  link_thumbnail: string;
  tags_text: string;
  status: "public" | "pending" | "hidden" | "deleted";
  created_at: number;
  updated_at: number | null;
  last_activity: number;
  views: number;
  clicks: number;
  username: string;
  avatar_url: string | null;
  category_name: string;
  category_color: string;
  vote_count: number;
  reply_count: number;
  voted: number;
  hot_score: number;
  featured: number;
  pinned: number;
  is_new?: boolean;
  first_image?: string;
}
export interface PostInput {
  shareData: string;
  work: WorkInput;
  title: string;
  body: string;
  category: string;
  link: string;
  tags: string[];
  draftId: string;
  confirmDuplicate: string;
  editorId: string;
}
export function postInput(form: FormData): PostInput {
  return {
    shareData: textField(form,"shareData"),
    work: workInput(form),
    title: textField(form, "title").trim(),
    body: textField(form, "body").replace(/\r\n?/g, "\n"),
    category: textField(form, "category"),
    link: textField(form, "link").trim(),
    tags: form.getAll("tags").filter((x): x is string => typeof x === "string"),
    draftId: textField(form, "draftId"),
    confirmDuplicate: textField(form, "confirmDuplicate"),
    editorId: textField(form, "editorId"),
  };
}
export const blankPost = (): PostInput => ({
  shareData: "",
  work: blankWork(),
  title: "",
  body: "",
  category: "1",
  link: "",
  tags: [],
  draftId: "",
  confirmDuplicate: "",
  editorId: "new",
});
export function categories(db: Db) {
  return db
    .prepare("SELECT * FROM categories WHERE active=1 ORDER BY position")
    .all() as Category[];
}
export function tags(db: Db) {
  return db
    .prepare("SELECT * FROM tags WHERE active=1 ORDER BY position,name")
    .all() as Tag[];
}
export function validatePost(db: Db, input: PostInput, draft = false) {
  parseShare(input.shareData);
  const fields: Record<string, string> = {};
  if (input.category === "4") validateWork(db, input.title, input.work, draft);
  if ((!draft && length(input.title) < 4) || length(input.title) > 80)
    fields.title = "标题需为 4–80 字";
  if (
    !db
      .prepare("SELECT 1 FROM categories WHERE id=? AND active=1")
      .get(input.category)
  )
    fields.category = "请选择板块";
  if (length(input.body) > 50000) fields.body = "正文不能超过 50,000 字";
  if (input.body.includes("buildme-upload:"))
    fields.body = "图片尚未上传完成，请完成或移除上传占位";
  if (
    input.tags.length > 5 ||
    new Set(input.tags).size !== input.tags.length ||
    input.tags.some(
      (id) => !db.prepare("SELECT 1 FROM tags WHERE id=? AND active=1").get(id),
    )
  )
    fields.tags = "请选择最多 5 个有效标签";
  if (input.link) {
    try {
      input.link = httpUrl(input.link);
    } catch {
      fields.link = "链接只接受 http 或 https 地址";
    }
  }
  if (Object.keys(fields).length)
    throw new FormError("请检查标出的内容", fields);
}
export const postSelect = `SELECT p.*,u.username,u.avatar_url,c.name category_name,c.color category_color,
 (SELECT COUNT(*) FROM votes v WHERE v.post_id=p.id) vote_count,
 (SELECT COUNT(*) FROM replies r JOIN users ru ON ru.id=r.author_id WHERE r.post_id=p.id AND r.deleted=0 AND r.status='public' AND ru.banned=0 AND ru.profile_pending=0) reply_count,
 (SELECT COUNT(*) FROM votes v WHERE v.post_id=p.id AND v.user_id=@viewer) voted,
 (SELECT i.thumb_url FROM image_refs ref JOIN images i ON i.id=ref.image_id WHERE ref.kind='post' AND ref.entity_id=p.id LIMIT 1) first_image FROM posts p JOIN users u ON u.id=p.author_id JOIN categories c ON c.id=p.category_id`;
export function getPost(db: Db, id: number, viewer: User | null) {
  const post = db
    .prepare(`${postSelect} WHERE p.id=@id AND u.banned=0 AND u.profile_pending=0`)
    .get({ id, viewer: viewer?.id ?? 0 }) as Post | undefined;
  if (!post) throw new FormError("帖子不存在", {}, 404);
  if (post.status === "deleted") throw new FormError("这条帖子已删除", {}, 404);
  if (
    post.status !== "public" &&
    (post.status !== "pending" || post.author_id !== viewer?.id) &&
    viewer?.role !== "admin" && viewer?.role !== "moderator"
  )
    throw new FormError("帖子不存在", {}, 404);
  return post;
}
export function canWrite(user: User, now: number) {
  if(user.profile_pending) throw new FormError("账号资料正在审核，请等待审核结果",{},403);
  if (user.muted_until && user.muted_until > now)
    throw new FormError(
      `禁言至 ${new Date(user.muted_until).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
      {},
      403,
    );
}
export function newAccount(db: Db, user: User, now: number) {
  const total = (
    db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM posts WHERE author_id=?)+(SELECT COUNT(*) FROM replies WHERE author_id=?) n",
      )
      .get(user.id, user.id) as { n: number }
  ).n;
  return now - user.created_at < 86400000 || total < 3;
}
export function checkPostingLimits(
  db: Db,
  user: User,
  now: number,
  input: PostInput,
) {
  canWrite(user, now);
  const fresh = newAccount(db, user, now);
  const last = db
    .prepare(
      "SELECT created_at FROM posts WHERE author_id=? ORDER BY created_at DESC LIMIT 1",
    )
    .get(user.id) as { created_at: number } | undefined;
  if (last && now - last.created_at < (fresh ? 60000 : 30000))
    throw new FormError(
      `请在 ${Math.ceil(((fresh ? 60000 : 30000) - (now - last.created_at)) / 1000)} 秒后再发帖`,
      {},
      429,
    );
  limit(db, "post", String(user.id), fresh ? 5 : 10, 3600000, now);
  if (fresh) {
    const images = (input.body.match(/!\[[^\]]*\]\([^)]+\)/g) ?? []).length;
    const links =
      (
        input.body
          .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
          .match(/https?:\/\/[^\s)]+/g) ?? []
      ).length + (input.link ? 1 : 0) + (input.work.demoUrl ? 1 : 0) + (input.work.sourceUrl ? 1 : 0);
    if (images > 2 || links > 2)
      throw new FormError("新账号每条内容最多 2 个外部链接、2 张图片");
  }
}
