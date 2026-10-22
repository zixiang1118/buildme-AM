import { readConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { join } from "node:path";
import { renderMarkdown } from "../src/lib/markdown.js";
import { usernameKey } from "../src/lib/validation.js";
const config = readConfig(),
  db = openDb(join(config.dataDir, "community.sqlite"));
const examples = [
  {
    name: "示例_林夏",
    title: "为什么同一个模型，换个 harness 表现差这么多",
    category: 2,
    body: "# 先从一个小实验开始\n\n模型像发动机，harness 像整辆车。工具、上下文与执行循环，都会影响最终的体验。\n\n## 记录三个维度\n\n- 工具能否被正确调用\n- 上下文是否包含完成任务需要的信息\n- 遇到错误后能否继续\n\n这是一条由 seed 显式生成的示例内容，你可以用它熟悉社区。",
  },
  {
    name: "示例_阿哲",
    title: "给 Agent 写工具说明时，我会先检查这三件事",
    category: 2,
    body: "## 从工具输入开始\n\n明确每个字段的含义、调用时机与输出结构。\n\n```ts\nconst tools = [readFile, searchFiles];\n```\n\n| 检查项 | 为什么 |\n| --- | --- |\n| 参数清晰 | 减少猜测 |\n| 错误可读 | 帮助下一步决策 |\n\n- [x] 用最小任务测试\n- [ ] 记录真实失败案例\n\n这是一篇本地开发示例。",
  },
  {
    name: "示例_Momo",
    title: "你们是怎么整理自己的 Agent 学习笔记的？",
    category: 3,
    body: "目前按“问题 → 尝试 → 结果”记录，过几天再补一段复盘。想听听大家的做法。\n\n这里只是开发示例，不代表真实用户活动。",
  },
  {
    name: "示例_小北",
    title: "今天终于把第一个小工具做出来了 🎉",
    category: 5,
    body: "从只会问问题，到把需求拆成一小步一小步。虽然功能还很简单，但已经能解决自己的一个问题了。\n\n欢迎把你的动手经历写下来。\n\n本条为开发示例。",
  },
];
let added = 0;
db.transaction(() => {
  for (const [index, item] of examples.entries()) {
    let user = db
      .prepare("SELECT id FROM users WHERE username_key=?")
      .get(usernameKey(item.name)) as { id: number } | undefined;
    if (!user) {
      user = {
        id: Number(
          db
            .prepare(
              "INSERT INTO users(username,username_key,bio,created_at,first_post_approved) VALUES (?,?,?,?,1)",
            )
            .run(
              item.name,
              usernameKey(item.name),
              "开发示例账号，不提供登录",
              Date.now() - 30 * 86400000,
            ).lastInsertRowid,
        ),
      };
    }
    if (
      db
        .prepare("SELECT 1 FROM posts WHERE author_id=? AND title=?")
        .get(user.id, item.title)
    )
      continue;
    const rendered = renderMarkdown(db, item.body, config.siteUrl),
      at = Date.now() - (index + 1) * 3600000;
    const id = Number(
      db
        .prepare(
          "INSERT INTO posts(author_id,category_id,title,body,html,excerpt,toc,tags_text,status,created_at,last_activity) VALUES (?,?,?,?,?,?,?,?,'public',?,?)",
        )
        .run(
          user.id,
          item.category,
          item.title,
          item.body,
          rendered.html,
          rendered.excerpt,
          JSON.stringify(rendered.toc),
          "经验分享",
          at,
          at,
        ).lastInsertRowid,
    );
    const tag = db
      .prepare("SELECT id FROM tags WHERE name='经验分享'")
      .get() as { id: number };
    db.prepare("INSERT INTO post_tags VALUES (?,?)").run(id, tag.id);
    added++;
  }
})();
db.close();
console.log(`新增 ${added} 篇开发示例；没有创建可登录的默认账号或虚构点赞。`);
