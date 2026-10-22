import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/index.js";
import type { User } from "../types.js";
import { getPost, postSelect, type Post } from "./posts.js";
import { FormError, usernameKey } from "./validation.js";

export interface FeedOptions {
  sort: string;
  category: string;
  tag: string;
  range: string;
  cursor?: string;
  harness?: string;
}
export interface FeedResult {
  posts: Post[];
  next: string | null;
}
export interface SidebarData {
  popular: Post[];
  tags: { name: string; count: number }[];
  users: number;
  posts: number;
  today: number;
}
export interface SearchOptions {
  q: string;
  type: string;
  category: string;
  tag: string;
  author: string;
  range: string;
  sort: string;
  page: number;
}
export interface SearchResult {
  items: {
    id: number;
    title: string;
    excerpt: string;
    href: string;
    username: string;
    created_at: number;
  }[];
  total: number;
  terms: string[];
}
export const since = (range: string, now: number) =>
  range === "week"
    ? now - 7 * 86400000
    : range === "month"
      ? now - 30 * 86400000
      : 0;
export function hotScore(
  votes: number,
  reactions: number,
  replies: number,
  hours: number,
) {
  return (votes * 2 + reactions + replies * 2 + 1) / Math.pow(hours + 2, 1.5);
}
export function refreshHot(db: Db, now: number) {
  const cache = db
    .prepare("SELECT updated_at FROM cache_entries WHERE key='hot'")
    .get() as { updated_at: number } | undefined;
  if (cache && now - cache.updated_at < 300000) return;
  db.transaction(() => {
    db.prepare(
      `UPDATE posts SET hot_score=((SELECT COUNT(*)*2 FROM votes WHERE post_id=posts.id)+(SELECT COUNT(*) FROM reactions WHERE kind='post' AND target_id=posts.id)+(SELECT COUNT(*)*2 FROM replies r JOIN users u ON u.id=r.author_id WHERE r.post_id=posts.id AND r.deleted=0 AND r.status='public' AND u.banned=0 AND u.profile_pending=0)+1)/pow((@now-created_at)/3600000.0+2,1.5) WHERE status='public' AND created_at>=@since`,
    ).run({ now, since: now - 14 * 86400000 });
    db.prepare(
      "INSERT INTO cache_entries VALUES ('hot','',?) ON CONFLICT(key) DO UPDATE SET updated_at=excluded.updated_at",
    ).run(now);
  })();
}
export function feed(
  db: Db,
  viewer: User | null,
  mode: string,
  options: FeedOptions,
  now: number,
  path: string,
): FeedResult {
  const viewerId = viewer?.id ?? 0;
  if (mode === "hot") refreshHot(db, now);
  let ids: number[],
    snapshotId: string,
    offset = 0;
  if (options.cursor) {
    const parts = options.cursor.split(".");
    snapshotId = parts[0];
    offset = Number(parts[1]);
    if (
      !/^[a-f0-9]{32}$/.test(snapshotId) ||
      !Number.isInteger(offset) ||
      offset < 0
    )
      throw new FormError("分页地址无效");
    const snapshot = db
      .prepare(
        "SELECT ids FROM feed_snapshots WHERE id=? AND viewer_id=? AND expires_at>?",
      )
      .get(snapshotId, viewerId, now) as { ids: string } | undefined;
    if (!snapshot) throw new FormError("列表已过期，请返回首页刷新", {}, 400);
    ids = JSON.parse(snapshot.ids);
  } else {
    const revision = (
      db.prepare("SELECT version FROM content_revision WHERE id=1").get() as {
        version: number;
      }
    ).version;
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          mode,
          options,
          viewerId,
          revision,
          mode === "hot" ? Math.floor(now / 300000) : 0,
        ]),
      )
      .digest("hex");
    const previous = db
      .prepare(
        "SELECT id,ids FROM feed_snapshots WHERE cache_key=? AND expires_at>? LIMIT 1",
      )
      .get(key, now) as { id: string; ids: string } | undefined;
    if (previous) {
      snapshotId = previous.id;
      ids = JSON.parse(previous.ids);
    } else {
      const sort =
        mode === "hot"
          ? "p.hot_score DESC"
          : options.sort === "votes"
            ? "(SELECT COUNT(*) FROM votes v WHERE v.post_id=p.id) DESC"
            : options.sort === "created"
              ? "p.created_at DESC"
              : "p.last_activity DESC";
      const rows = db
        .prepare(
          `SELECT p.id FROM posts p JOIN users u ON u.id=p.author_id WHERE u.banned=0 AND u.profile_pending=0 AND (p.status='public' OR (p.status='pending' AND p.author_id=@viewer))
        AND (@category='' OR p.category_id=@category) AND (@tag='' OR EXISTS(SELECT 1 FROM post_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.post_id=p.id AND t.name=@tag))
        AND (@harness='' OR EXISTS(SELECT 1 FROM work_harnesses wh WHERE wh.post_id=p.id AND wh.harness_id=@harness))
        AND p.created_at>=@since ${mode === "featured" && options.sort !== "votes" ? "AND p.featured=1" : ""}
        ORDER BY CASE WHEN p.pinned=1 AND (p.pin_category_id IS NULL OR p.pin_category_id=@category) THEN 1 ELSE 0 END DESC,${sort},p.id DESC`,
        )
        .all({
          viewer: viewerId,
          category: options.category,
          tag: options.tag,
          harness: options.harness ?? "",
          since:
            mode === "hot" ? now - 14 * 86400000 : since(options.range, now),
        }) as { id: number }[];
      ids = rows.map((x) => x.id);
      snapshotId = randomBytes(16).toString("hex");
      db.prepare("INSERT INTO feed_snapshots VALUES (?,?,?,?,?)").run(
        snapshotId,
        key,
        viewerId,
        JSON.stringify(ids),
        now + 3600000,
      );
    }
  }
  // Keep the ordered snapshot stable while still excluding newly moderated content.
  const visible: Post[] = [];
  while (offset < ids.length && visible.length < 30) {
    const batch = ids.slice(offset, offset + 30 - visible.length);
    offset += batch.length;
    const bindings: Record<string, number> = { viewer: viewerId };
    batch.forEach((id, i) => (bindings[`id${i}`] = id));
    const rows = db
      .prepare(
        `${postSelect} WHERE p.id IN (${batch.map((_id, i) => `@id${i}`).join(",")}) AND u.banned=0 AND u.profile_pending=0 AND (p.status='public' OR (p.status='pending' AND p.author_id=@viewer))`,
      )
      .all(bindings) as Post[];
    const map = new Map(rows.map((p) => [p.id, p]));
    for (const id of batch) {
      const post = map.get(id);
      if (post) {
        post.is_new = !!viewer && post.last_activity > viewer.last_home_seen;
        visible.push(post);
      }
    }
  }
  const query = new URLSearchParams({
    sort: options.sort,
    category: options.category,
    tag: options.tag,
    range: options.range,
    cursor: `${snapshotId}.${offset}`,
    harness: options.harness ?? "",
  });
  return {
    posts: visible,
    next: offset < ids.length ? `${path}?${query}` : null,
  };
}
export function sidebar(db: Db, now: number): SidebarData {
  const cached = db
    .prepare("SELECT value,updated_at FROM cache_entries WHERE key='weekly'")
    .get() as { value: string; updated_at: number } | undefined;
  let ids: number[];
  if (cached && now - cached.updated_at < 600000)
    ids = JSON.parse(cached.value);
  else {
    ids = (
      db
        .prepare(
          "SELECT p.id FROM posts p JOIN users u ON u.id=p.author_id WHERE p.status='public' AND u.banned=0 AND u.profile_pending=0 AND p.created_at>=? ORDER BY p.views+p.clicks DESC,p.id DESC LIMIT 5",
        )
        .all(now - 7 * 86400000) as { id: number }[]
    ).map((x) => x.id);
    db.prepare(
      "INSERT INTO cache_entries VALUES ('weekly',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    ).run(JSON.stringify(ids), now);
  }
  const popular = ids
    .filter((id) =>
      db
        .prepare(
          "SELECT 1 FROM posts p JOIN users u ON u.id=p.author_id WHERE p.id=? AND p.status='public' AND u.banned=0 AND u.profile_pending=0",
        )
        .get(id),
    )
    .map((id) => getPost(db, id, null));
  const counts = db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM users WHERE banned=0) users,COUNT(*) posts,COALESCE(SUM(p.created_at>=?),0) today FROM posts p JOIN users u ON u.id=p.author_id WHERE p.status='public' AND u.banned=0 AND u.profile_pending=0",
    )
    .get(
      Math.floor((now + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000,
    ) as { users: number; posts: number; today: number };
  return { popular, tags: tagCounts(db).slice(0, 12), ...counts };
}
export function tagCounts(db: Db) {
  return db
    .prepare(
      "SELECT t.name,COUNT(p.id) count FROM tags t LEFT JOIN post_tags pt ON pt.tag_id=t.id LEFT JOIN posts p ON p.id=pt.post_id AND p.status='public' AND EXISTS(SELECT 1 FROM users u WHERE u.id=p.author_id AND u.banned=0 AND u.profile_pending=0) WHERE t.active=1 GROUP BY t.id ORDER BY count DESC,t.name",
    )
    .all() as { name: string; count: number }[];
}
export function search(
  db: Db,
  options: SearchOptions,
  now: number,
  limit = 20,
): SearchResult {
  const terms: string[] = [];
  let author = options.author,
    tag = options.tag;
  for (const match of options.q.matchAll(
    /@([\p{Script=Han}A-Za-z0-9_]{2,16})|#([^\s"]+)|"([^"]+)"|([^\s"]+)/gu,
  )) {
    if (match[1]) author = match[1];
    else if (match[2]) tag = match[2];
    else terms.push(match[3] ?? match[4]);
  }
  const params: Record<string, string | number> = {
    author: usernameKey(author),
    tag,
    category: options.category,
    since: since(options.range, now),
    limit,
    offset: (options.page - 1) * limit,
  };
  if (options.type === "users") {
    const query = terms.join(" ");
    params.term = query.toLowerCase();
    const where =
      "u.banned=0 AND u.profile_pending=0 AND instr(lower(u.username||' '||u.bio),@term)>0 AND (@author='' OR u.username_key=@author)";
    const bindings = { term: params.term, author: params.author };
    const total = (
      db
        .prepare(`SELECT COUNT(*) n FROM users u WHERE ${where}`)
        .get(bindings) as { n: number }
    ).n;
    const rows = db
      .prepare(
        `SELECT id,username,bio,created_at FROM users u WHERE ${where} ORDER BY instr(lower(username),@term)>0 DESC,created_at DESC LIMIT @limit OFFSET @offset`,
      )
      .all({ ...bindings, limit, offset: params.offset }) as {
      id: number;
      username: string;
      bio: string;
      created_at: number;
    }[];
    return {
      terms,
      total,
      items: rows.map((x) => ({
        id: x.id,
        title: x.username,
        excerpt: x.bio,
        username: x.username,
        created_at: x.created_at,
        href: `/u/${encodeURIComponent(x.username)}`,
      })),
    };
  }
  const replies = options.type === "replies",
    alias = replies ? "r" : "p",
    fts = replies ? "replies_fts" : "posts_fts";
  const matches = terms.map((term, i) => {
    params[`t${i}`] = term.toLowerCase();
    return `instr(lower(${replies ? "r.body" : "p.title||' '||p.body||' '||p.tags_text||' '||p.work_summary"}),@t${i})>0`;
  });
  const long = terms.filter((t) => [...t].length >= 3);
  if (long.length) {
    params.match = long
      .map((t) => `"${t.replaceAll('"', '""')}"`)
      .join(" AND ");
    matches.push(
      `${alias}.id IN (SELECT rowid FROM ${fts} WHERE ${fts} MATCH @match)`,
    );
  }
  const from = replies
    ? "replies r JOIN posts p ON p.id=r.post_id JOIN users u ON u.id=r.author_id JOIN users author ON author.id=p.author_id"
    : "posts p JOIN users u ON u.id=p.author_id";
  const where = `p.status='public' AND u.banned=0 AND u.profile_pending=0 ${replies ? "AND r.deleted=0 AND r.status='public' AND author.banned=0 AND author.profile_pending=0" : ""} AND (@category='' OR p.category_id=@category) AND (@author='' OR u.username_key=@author) AND (@tag='' OR EXISTS(SELECT 1 FROM post_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.post_id=p.id AND t.name=@tag)) AND ${alias}.created_at>=@since ${matches.length ? "AND " + matches.join(" AND ") : ""}`;
  const countParams = Object.fromEntries(
    Object.entries(params).filter(
      ([key]) => key !== "limit" && key !== "offset",
    ),
  );
  const total = (
    db
      .prepare(`SELECT COUNT(*) n FROM ${from} WHERE ${where}`)
      .get(countParams) as { n: number }
  ).n;
  const score =
    !replies && terms.length
      ? terms.map((_t, i) => `(instr(lower(p.title),@t${i})>0)`).join("+")
      : "0.0";
  const rows = db
    .prepare(
      `SELECT ${alias}.id,p.id post_id,p.title,${replies?'r.body':"p.body||' '||p.work_summary"} body,u.username,${alias}.created_at,${replies ? "r.floor" : "0"} floor FROM ${from} WHERE ${where} ORDER BY ${options.sort === "latest" ? `${alias}.created_at DESC` : `(${score}) DESC,${alias}.created_at DESC`},${alias}.id DESC LIMIT @limit OFFSET @offset`,
    )
    .all(params) as {
    id: number;
    post_id: number;
    title: string;
    body: string;
    username: string;
    created_at: number;
    floor: number;
  }[];
  return {
    terms,
    total,
    items: rows.map((r) => {
      const position = terms.length
        ? r.body.toLowerCase().indexOf(terms[0].toLowerCase())
        : 0;
      return {
        ...r,
        excerpt: r.body
          .slice(Math.max(0, position - 50), Math.max(0, position - 50) + 240)
          .replace(/[#*`>]/g, ""),
        href: `/p/${r.post_id}${r.floor ? `?page=${Math.ceil(r.floor / 30)}#${r.floor}` : ""}`,
      };
    }),
  };
}
