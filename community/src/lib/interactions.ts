import type { Db } from '../db/index.js';
import type { User } from '../types.js';
import { FormError, usernameKey } from './validation.js';

export const emojis = ['👍','❤️','😂','🎉','🤔','👀','🚀','🙏'];
export interface Reply {
  id: number; post_id: number; author_id: number; floor: number; parent_floor: number | null;
  body: string; html: string; created_at: number; updated_at: number | null; deleted: number; status: string;
  username: string; avatar_url: string | null; parent_username: string | null; child_count: number;
}
const replySelect = `SELECT r.*,u.username,u.avatar_url,pu.username parent_username,
 (SELECT COUNT(*) FROM replies child JOIN users cu ON cu.id=child.author_id WHERE child.post_id=r.post_id AND child.parent_floor=r.floor AND child.deleted=0 AND child.status='public' AND cu.banned=0 AND cu.profile_pending=0) child_count
 FROM replies r JOIN users u ON u.id=r.author_id LEFT JOIN replies parent ON parent.post_id=r.post_id AND parent.floor=r.parent_floor LEFT JOIN users pu ON pu.id=parent.author_id`;
export function replyRows(db: Db, postId: number, from: number, parent?: number) {
  return db.prepare(`${replySelect} WHERE r.post_id=@post AND r.deleted=0 AND r.status='public' AND u.banned=0 AND u.profile_pending=0
    AND ${parent === undefined ? 'r.floor>=@from AND r.floor<@from+30' : 'r.parent_floor=@from'} ORDER BY r.floor LIMIT 30`)
    .all({post: postId, from: parent ?? from}) as Reply[];
}
export function getReply(db: Db, id: number) {
  const reply = db.prepare(`${replySelect} WHERE r.id=? AND r.deleted=0 AND r.status='public' AND u.banned=0 AND u.profile_pending=0`).get(id) as Reply | undefined;
  if (!reply) throw new FormError('回复不存在', {}, 404);
  return reply;
}
export function maxFloor(db: Db, postId: number) {
  return (db.prepare('SELECT COALESCE(MAX(floor),0) n FROM replies WHERE post_id=?').get(postId) as {n:number}).n;
}
export function reactionsFor(db: Db, kind: string, id: number, userId: number) {
  return emojis.map(emoji => {
    const users = db.prepare('SELECT u.username FROM reactions r JOIN users u ON u.id=r.user_id WHERE r.kind=? AND r.target_id=? AND r.emoji=? ORDER BY r.created_at LIMIT 10').all(kind,id,emoji) as {username:string}[];
    const row = db.prepare('SELECT COUNT(*) count,COALESCE(MAX(user_id=?),0) active FROM reactions WHERE kind=? AND target_id=? AND emoji=?').get(userId,kind,id,emoji) as {count:number;active:number};
    return {emoji,...row,names:users.map(x=>x.username).join('、')};
  });
}
export function notify(db: Db, recipient: number, actor: number, kind: string, postId: number | null, floor: number, now: number, message = "", link = "") {
  if (recipient === actor) return;
  const previous = kind === 'like' ? db.prepare("SELECT id FROM notifications WHERE user_id=? AND post_id=? AND kind='like' AND created_at>? ORDER BY id DESC LIMIT 1").get(recipient,postId,now-3600000) as {id:number}|undefined : undefined;
  const id = previous?.id ?? Number(db.prepare('INSERT INTO notifications(user_id,actor_id,kind,post_id,floor,created_at,updated_at,message,link) VALUES (?,?,?,?,?,?,?,?,?)').run(recipient,actor,kind,postId,floor,now,now,message,link).lastInsertRowid);
  if (previous) db.prepare('UPDATE notifications SET updated_at=?,read_at=NULL WHERE id=?').run(now,id);
  db.prepare('INSERT OR IGNORE INTO notification_actors VALUES (?,?)').run(id,actor);
}
export function notifyMentions(db: Db, body: string, actor: number, postId: number, floor: number, now: number, already: number[] = []) {
  const recipients = new Set(already);
  for (const match of body.matchAll(/@([\p{Script=Han}A-Za-z0-9_]{2,16})/gu)) {
    const user = db.prepare('SELECT id FROM users WHERE username_key=? AND banned=0 AND profile_pending=0').get(usernameKey(match[1])) as {id:number}|undefined;
    if (user && !recipients.has(user.id)) { notify(db,user.id,actor,'mention',postId,floor,now); recipients.add(user.id); }
  }
}
export function unreadCount(db: Db, user: Pick<User,'id'> | null) {
  if (!user) return 0;
  return (db.prepare("SELECT COUNT(*) n FROM notifications n LEFT JOIN posts p ON p.id=n.post_id LEFT JOIN users u ON u.id=p.author_id WHERE n.user_id=? AND n.read_at IS NULL AND (n.post_id IS NULL OR (p.status='public' AND u.banned=0 AND u.profile_pending=0))").get(user.id) as {n:number}).n;
}
