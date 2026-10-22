import { serve } from "@hono/node-server";
import { join } from "node:path";
import { readConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { createApp } from "../src/app.js";
import { renderMarkdown } from "../src/lib/markdown.js";
import { hashPassword, digest } from "../src/lib/auth.js";
if (!process.env.COMMUNITY_BROWSER_DATA_DIR)
  throw new Error("请通过 pnpm test:browser 使用隔离的测试目录");
const config = readConfig({
  SESSION_SECRET: "browser-test-only-secret-at-least-32",
  SITE_URL: "http://localhost:3198",
  DATA_DIR: process.env.COMMUNITY_BROWSER_DATA_DIR,
  PORT: "3198",
});
const db = openDb(join(config.dataDir, "community.sqlite"));
for (const name of ["浏览器管理员", "草稿同学", "图片同学", "快速同学", "作品同学"])
  db.prepare(
    "INSERT INTO users(username,username_key,password_hash,role,created_at,first_post_approved) VALUES (?,?,?,'admin',?,1)",
  ).run(
    name,
    name,
    await hashPassword("browser-test-password"),
    Date.now() - 40 * 86400000,
  );
db.prepare(
  "INSERT INTO invitations(code_hash,label,max_uses,created_by) VALUES (?,?,?,1)",
).run(digest("browser-only-invite"), "浏览器测试邀请码", 5);
db.prepare("INSERT INTO posts(id,author_id,category_id,title,body,html,excerpt,toc,tags_text,status,created_at,last_activity) VALUES (1,2,2,'两百楼 harness 讨论测试','讨论楼层','<p>讨论楼层</p>','讨论楼层','[]','','public',?,?)").run(Date.now()-86400000,Date.now());
const codeBody='讨论楼层\n\n```js\n// 代码高亮对比度\nconst answer = 42;\nconsole.log("harness");\n```';
const codeRendered=renderMarkdown(db,codeBody,config.siteUrl);
db.prepare('UPDATE posts SET body=?,html=? WHERE id=1').run(codeBody,codeRendered.html);
const replyInsert=db.prepare('INSERT INTO replies(post_id,author_id,floor,body,html,created_at) VALUES (1,3,?,?,?,?)');
db.transaction(()=>{for(let floor=1;floor<=200;floor++)replyInsert.run(floor,`这是第 ${floor} 楼的一段文字。`,`<p>这是第 ${floor} 楼的一段文字。</p>`,Date.now());})();
const server = serve({
  fetch: createApp(config, db).fetch,
  hostname: "127.0.0.1",
  port: 3198,
}, () => process.send?.({ready:true}));
process.on("SIGTERM", () =>
  server.close(() => {
    db.close();
    process.exit(0);
  }),
);
