UPDATE categories SET active=1 WHERE slug='work';
CREATE TABLE harnesses(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,position INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1);
INSERT INTO harnesses(name,position) VALUES ('BuildMe',1),('Claude Code',2),('Codex',3),('Cursor',4),('其他',5);
CREATE TABLE works(post_id INTEGER PRIMARY KEY REFERENCES posts(id),summary TEXT NOT NULL,cover_id TEXT NOT NULL REFERENCES images(id),demo_url TEXT NOT NULL,source_url TEXT NOT NULL,other_harness TEXT NOT NULL DEFAULT '',selected_at INTEGER);
CREATE INDEX works_selected ON works(selected_at DESC);
CREATE TABLE work_harnesses(post_id INTEGER NOT NULL REFERENCES works(post_id),harness_id INTEGER NOT NULL REFERENCES harnesses(id),PRIMARY KEY(post_id,harness_id));
CREATE INDEX work_harnesses_filter ON work_harnesses(harness_id,post_id);
ALTER TABLE posts ADD COLUMN work_summary TEXT NOT NULL DEFAULT '';
DROP TRIGGER posts_fts_insert;
DROP TRIGGER posts_fts_update;
CREATE TRIGGER posts_fts_insert AFTER INSERT ON posts WHEN NEW.status='public' BEGIN
 INSERT INTO posts_fts(rowid,title,body,tags) VALUES(NEW.id,NEW.title,NEW.body||' '||NEW.work_summary,NEW.tags_text);
END;
CREATE TRIGGER posts_fts_update AFTER UPDATE OF title,body,tags_text,status,work_summary ON posts BEGIN
 DELETE FROM posts_fts WHERE rowid=OLD.id;
 INSERT INTO posts_fts(rowid,title,body,tags) SELECT NEW.id,NEW.title,NEW.body||' '||NEW.work_summary,NEW.tags_text WHERE NEW.status='public' AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.author_id AND banned=1);
END;

UPDATE drafts SET data=json_set(data,'$.work',json('{"summary":"","coverId":"","demoUrl":"","sourceUrl":"","harnesses":[],"otherHarness":"","cropX":"50","cropY":"50","cropZoom":"1"}')) WHERE json_type(data,'$.work') IS NULL;
