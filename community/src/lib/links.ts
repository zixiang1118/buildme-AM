import { parseHTML } from "linkedom";
import type { Db } from "../db/index.js";
import type { Storage } from "./storage.js";
import { SafeFetcher, RemoteError } from "./remote.js";
import { saveImage } from "./images.js";
import { FormError, httpUrl } from "./validation.js";
export interface LinkInfo {
  title: string;
  source: string;
  thumbnail: string;
  duplicate?: { id: number; title: string; username: string; days: number };
}
export function linkSource(raw: string) {
  const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  if (["x.com", "twitter.com"].includes(host)) return "X";
  if (["youtube.com", "youtu.be", "m.youtube.com"].includes(host))
    return "YouTube";
  if (
    host === "b23.tv" ||
    host === "bilibili.com" ||
    host.endsWith(".bilibili.com")
  )
    return "B 站";
  if (host === "linux.do") return "L 站";
  if (host === "github.com") return "GitHub";
  if (host === "mp.weixin.qq.com") return "公众号";
  return host;
}
export function duplicateLink(db: Db, url: string, now: number, exceptId = 0) {
  const post = db
    .prepare(
      "SELECT p.id,p.title,u.username,p.created_at FROM posts p JOIN users u ON u.id=p.author_id WHERE p.link=? AND p.created_at>? AND p.status='public' AND u.banned=0 AND p.id<>? ORDER BY p.created_at DESC LIMIT 1",
    )
    .get(url, now - 7 * 86400000, exceptId) as
    | { id: number; title: string; username: string; created_at: number }
    | undefined;
  return post
    ? {
        id: post.id,
        title: post.title,
        username: post.username,
        days: Math.floor((now - post.created_at) / 86400000),
      }
    : undefined;
}
export async function resolveLink(
  db: Db,
  storage: Storage,
  remote: SafeFetcher,
  userId: number,
  raw: string,
  now: number,
): Promise<LinkInfo> {
  const url = httpUrl(raw);
  const cached = db
    .prepare(
      "SELECT title,source,thumbnail FROM link_cache WHERE url=? AND expires_at>?",
    )
    .get(url, now) as LinkInfo | undefined;
  if (cached) return { ...cached, duplicate: duplicateLink(db, url, now) };
  const deadline = Date.now() + 4000;
  const remaining = () => Math.max(1, deadline - Date.now());
  const source = linkSource(url);
  let title = "",
    thumbnail = "";
  if (source === "YouTube" || source === "X") {
    await remote.validate(url, remaining());
    const endpoint =
      source === "YouTube"
        ? "https://www.youtube.com/oembed"
        : "https://publish.twitter.com/oembed";
    const response = await remote.get(
      `${endpoint}?${new URLSearchParams({ url, format: "json" })}`,
      { truncate: true, timeoutMs: remaining() },
    );
    let data: {
      title?: string;
      author_name?: string;
      html?: string;
      thumbnail_url?: string;
    };
    try {
      data = JSON.parse(response.body.toString("utf8"));
    } catch {
      throw new RemoteError();
    }
    if (source === "X") {
      const { document } = parseHTML(
        `<html><body>${data.html ?? ""}</body></html>`,
      );
      title = `${data.author_name ?? ""}：${document.querySelector("p")?.textContent?.slice(0, 60) ?? ""}`;
    } else {
      title = data.title ?? "";
      thumbnail = data.thumbnail_url ?? "";
    }
  } else {
    const response = await remote.get(url, {
      truncate: true,
      timeoutMs: remaining(),
    });
    const { document } = parseHTML(response.body.toString("utf8"));
    title =
      document
        .querySelector('meta[property="og:title"]')
        ?.getAttribute("content") ??
      document.querySelector("title")?.textContent ??
      "";
    const image = document
      .querySelector('meta[property="og:image"]')
      ?.getAttribute("content");
    if (image) thumbnail = new URL(image, response.url).href;
  }
  title = title.trim().slice(0, 300);
  if (!title) throw new RemoteError("未找到链接标题，请手动填写");
  let storedThumbnail = "";
  if (thumbnail) {
    try {
      const image = await remote.get(thumbnail, {
        maxBytes: 8 * 1024 * 1024,
        timeoutMs: remaining(),
      });
      storedThumbnail = (await saveImage(db, storage, userId, image.body, now))
        .thumbUrl;
    } catch (error) {
      if (!(error instanceof FormError)) throw error;
    }
  }
  db.prepare(
    "INSERT INTO link_cache VALUES (?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET title=excluded.title,source=excluded.source,thumbnail=excluded.thumbnail,expires_at=excluded.expires_at",
  ).run(url, title, source, storedThumbnail, now + 86400000);
  return {
    title,
    source,
    thumbnail: storedThumbnail,
    duplicate: duplicateLink(db, url, now),
  };
}
