import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
  createHmac,
} from "node:crypto";
import { promisify } from "node:util";
import type { Db } from "../db/index.js";
import type { User } from "../types.js";
import {
  FormError,
  usernameKey,
  validateUsername,
  validatePassword,
} from "./validation.js";
import { checkWords, queueProfile } from "./moderation.js";
const scrypt = promisify(scryptCallback);
export const token = () => randomBytes(32).toString("base64url");
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function privateKey(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("hex");
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${key.toString("hex")}`;
}
export async function verifyPassword(password: string, hash: string) {
  const [salt, hex] = hash.split(":");
  const expected = Buffer.from(hex, "hex");
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return timingSafeEqual(key, expected);
}
export function userById(db: Db, id: number) {
  return db.prepare("SELECT * FROM users WHERE id=?").get(id) as
    User | undefined;
}
export function ensureNameAvailable(db: Db, name: string, exceptId = 0) {
  validateUsername(name);
  if (
    db
      .prepare("SELECT id FROM users WHERE username_key=? AND id<>?")
      .get(usernameKey(name), exceptId)
  )
    throw new FormError("这个用户名已被使用", {
      username: "这个用户名已被使用",
    });
}
export function createInvite(
  db: Db,
  admin: number,
  maxUses: number,
  expiresAt: number | null,
  now = Date.now(),
) {
  const code = randomBytes(12).toString("base64url");
  db.prepare(
    "INSERT INTO invitations(code_hash,label,max_uses,expires_at,created_by) VALUES (?,?,?,?,?)",
  ).run(digest(code), code.slice(0, 4) + "…", maxUses, expiresAt, admin);
  logAdmin(db, admin, "invite.create", "invitation", now);
  return code;
}
export function logAdmin(
  db: Db,
  actor: number,
  action: string,
  target: string,
  now = Date.now(),
) {
  db.prepare(
    "INSERT INTO admin_logs(actor_id,action,target,created_at) VALUES (?,?,?,?)",
  ).run(actor, action, target, now);
}
export async function register(
  db: Db,
  name: string,
  password: string,
  code: string,
  now: number,
) {
  ensureNameAvailable(db, name);
  const review=checkWords(db,name)==='pending';
  validatePassword(password);
  const hash = await hashPassword(password);
  return db.transaction(() => {
    ensureNameAvailable(db, name);
    const invite = db
      .prepare("SELECT * FROM invitations WHERE code_hash=?")
      .get(digest(code)) as
      | {
          id: number;
          used: number;
          max_uses: number;
          expires_at: number | null;
          revoked: number;
        }
      | undefined;
    if (!invite) throw new FormError("邀请码错误", { invite: "邀请码错误" });
    if (invite.revoked)
      throw new FormError("邀请码已作废", { invite: "邀请码已作废" });
    if (invite.expires_at !== null && invite.expires_at <= now)
      throw new FormError("邀请码已过期", { invite: "邀请码已过期" });
    if (invite.used >= invite.max_uses)
      throw new FormError("邀请码次数已用尽", { invite: "邀请码次数已用尽" });
    const result = db
      .prepare(
        "INSERT INTO users(username,username_key,password_hash,created_at) VALUES (?,?,?,?)",
      )
      .run(name, usernameKey(name), hash, now);
    const id = Number(result.lastInsertRowid);
    if(review) {db.prepare("UPDATE users SET profile_pending=1 WHERE id=?").run(id);queueProfile(db,id,name,"",now);}
    db.prepare("UPDATE invitations SET used=used+1 WHERE id=?").run(invite.id);
    db.prepare("INSERT INTO invitation_uses VALUES (?,?,?)").run(
      invite.id,
      id,
      now,
    );
    return userById(db, id)!;
  })();
}
export function limit(
  db: Db,
  scope: string,
  actor: string,
  max: number,
  windowMs: number,
  now: number,
) {
  db.prepare("DELETE FROM rate_events WHERE happened_at<?").run(now - 86400000);
  const row = db
    .prepare(
      "SELECT COUNT(*) AS total, MIN(happened_at) AS first FROM rate_events WHERE scope=? AND actor=? AND happened_at>?",
    )
    .get(scope, actor, now - windowMs) as {
    total: number;
    first: number | null;
  };
  if (row.total >= max)
    throw new FormError(
      `操作太频繁，请在 ${Math.ceil((row.first! + windowMs - now) / 1000)} 秒后再试`,
      {},
      429,
    );
  db.prepare("INSERT INTO rate_events VALUES (?,?,?)").run(scope, actor, now);
}
export function checkLoginBlock(db: Db, ipKey: string, now: number) {
  const row = db
    .prepare("SELECT blocked_until FROM login_attempts WHERE ip_key=?")
    .get(ipKey) as { blocked_until: number } | undefined;
  if (row && row.blocked_until > now)
    throw new FormError(
      `登录尝试过多，请在 ${Math.ceil((row.blocked_until - now) / 1000)} 秒后再试`,
      {},
      429,
    );
}
export async function login(
  db: Db,
  name: string,
  password: string,
  ipKey: string,
  now: number,
) {
  checkLoginBlock(db, ipKey, now);
  const user = db
    .prepare("SELECT * FROM users WHERE username_key=?")
    .get(usernameKey(name)) as User | undefined;
  const ok =
    password.length <= 1024 &&
    user?.password_hash &&
    (await verifyPassword(password, user.password_hash));
  if (!ok) {
    const last = db
      .prepare("SELECT * FROM login_attempts WHERE ip_key=?")
      .get(ipKey) as { failures: number; last_at: number } | undefined;
    const failures =
      last && now - last.last_at < 900000 ? last.failures + 1 : 1;
    db.prepare(
      "INSERT INTO login_attempts VALUES (?,?,?,?) ON CONFLICT(ip_key) DO UPDATE SET failures=excluded.failures, blocked_until=excluded.blocked_until,last_at=excluded.last_at",
    ).run(ipKey, failures, failures >= 5 ? now + 900000 : 0, now);
    throw new FormError("用户名或密码错误", {}, 400);
  }
  if (user.banned) throw new FormError("账号已被停用", {}, 403);
  db.prepare("DELETE FROM login_attempts WHERE ip_key=?").run(ipKey);
  return user;
}
export async function resetPassword(
  db: Db,
  admin: number,
  target: number,
  now: number,
) {
  const password = randomBytes(15).toString("base64url");
  const hash = await hashPassword(password);
  db.transaction(() => {
    db.prepare(
      "UPDATE users SET password_hash=?,must_change_password=1 WHERE id=?",
    ).run(hash, target);
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(target);
    logAdmin(db, admin, "user.reset-password", String(target), now);
  })();
  return password;
}
