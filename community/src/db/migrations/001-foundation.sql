CREATE TABLE categories (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE,
 description TEXT NOT NULL, color TEXT NOT NULL, position INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE health_probe (id INTEGER PRIMARY KEY CHECK(id=1), checked_at INTEGER NOT NULL);
INSERT INTO health_probe VALUES (1,0);
INSERT INTO categories VALUES
 (1,'分享','share','分享值得一看的链接','brand',1,1),
 (2,'文章','article','学习笔记、经验和教程','blue',2,1),
 (3,'问答','question','一起解决具体的问题','green',3,1),
 (4,'作品','work','展示用 Agent 做出的东西','purple',4,0),
 (5,'闲聊','chat','技术之外，随便聊聊','gray',5,1);
INSERT INTO tags(name) VALUES ('harness'),('Skill'),('上下文'),('MCP'),('vibe coding'),('经验分享');
