import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../types.js";
import { digest, token, privateKey, userById } from "./auth.js";
import { FormError } from "./validation.js";
const cookieOptions = {
  path: "/",
  httpOnly: true,
  secure: true,
  sameSite: "Lax" as const,
};
export function newSession(c: Context<Env>, userId: number | null) {
  const raw = token(),
    id = digest(raw),
    csrf = token();
  c.get("db")
    .prepare("INSERT INTO sessions VALUES (?,?,?,?)")
    .run(id, userId, csrf, c.get("now") + 90 * 86400000);
  setCookie(c, "community_session", raw, {
    ...cookieOptions,
    maxAge: 90 * 86400,
  });
  c.set("sessionId", id);
  c.set("csrf", csrf);
  c.set("user", userId === null ? null : userById(c.get("db"), userId)!);
}
export function rotateSession(c: Context<Env>, userId: number | null) {
  c.get("db")
    .prepare("DELETE FROM sessions WHERE id=?")
    .run(c.get("sessionId"));
  newSession(c, userId);
}
export const sessions: MiddlewareHandler<Env> = async (c, next) => {
  const db = c.get("db"),
    now = c.get("now"),
    config = c.get("config");
  const raw = getCookie(c, "community_session");
  const record = raw
    ? (db
        .prepare("SELECT * FROM sessions WHERE id=? AND expires_at>?")
        .get(digest(raw), now) as
        { id: string; user_id: number | null; csrf: string } | undefined)
    : undefined;
  const user = record?.user_id ? userById(db, record.user_id) : null;
  if (record && !user?.banned) {
    c.set("sessionId", record.id);
    c.set("csrf", record.csrf);
    c.set("user", user ?? null);
    db.prepare("UPDATE sessions SET expires_at=? WHERE id=?").run(
      now + 90 * 86400000,
      record.id,
    );
    setCookie(c, "community_session", raw!, {
      ...cookieOptions,
      maxAge: 90 * 86400,
    });
  } else newSession(c, null);
  const address = config.trustProxy
    ? (c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "unknown")
    : (c.env?.incoming?.socket?.remoteAddress ?? "127.0.0.1");
  c.set("ipKey", privateKey(address, config.sessionSecret));
  const queryTheme = c.req.query("theme");
  const storedTheme = getCookie(c, "theme");
  const theme = queryTheme ?? storedTheme;
  c.set("theme", theme === "dark" || theme === "light" ? theme : undefined);
  c.set("embed", (c.req.query("embed") ?? getCookie(c, "embed")) === "1");
  if (queryTheme === "dark" || queryTheme === "light")
    setCookie(c, "theme", queryTheme, { ...cookieOptions, maxAge: 31536000 });
  if (queryTheme === "system") deleteCookie(c, "theme", cookieOptions);
  if (c.req.query("embed") === "1" || c.req.query("embed") === "0")
    setCookie(c, "embed", c.req.query("embed")!, {
      ...cookieOptions,
      maxAge: 31536000,
    });
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    if (origin && origin !== config.siteUrl)
      throw new FormError("请求来源不正确", {}, 403);
    const supplied =
      c.req.header("x-csrf-token") ??
      String((await c.req.parseBody()).csrf ?? "");
    if (supplied !== c.get("csrf"))
      throw new FormError("页面已过期，请刷新后重试", {}, 403);
  }
  if (
    user?.must_change_password &&
    !["/settings", "/settings/password", "/logout", "/theme"].includes(
      c.req.path,
    )
  )
    return c.redirect("/settings?reset=1", 303);
  if (user) db.prepare("UPDATE users SET last_seen_at=? WHERE id=?").run(now,user.id);
  await next();
};
export function requireUser(c: Context<Env>) {
  const user = c.get("user");
  if (!user) throw new FormError("请先登录", {}, 403);
  return user;
}
export function requireAdmin(c: Context<Env>) {
  const user = c.get("user");
  if (!user || user.role !== "admin")
    throw new FormError("页面不存在", {}, 404);
  return user;
}

export function requireStaff(c: Context<Env>) {
  const user=c.get('user');
  if(!user || user.role==='member') throw new FormError('页面不存在',{},404);
  return user;
}
