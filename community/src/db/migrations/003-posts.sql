CREATE TABLE posts (
 id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL REFERENCES users(id), category_id INTEGER NOT NULL REFERENCES categories(id),
 title TEXT NOT NULL, body TEXT NOT NULL, html TEXT NOT NULL, excerpt TEXT NOT NULL, toc TEXT NOT NULL DEFAULT '[]',
 link TEXT NOT NULL DEFAULT '', link_title TEXT NOT NULL DEFAULT '', link_source TEXT NOT NULL DEFAULT '', link_thumbnail TEXT NOT NULL DEFAULT '',
 tags_text TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN ('public','pending','hidden','deleted')),
 created_at INTEGER NOT NULL, updated_at INTEGER, last_activity INTEGER NOT NULL, views INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX posts_activity ON posts(status,last_activity DESC,id DESC);
CREATE INDEX posts_created ON posts(status,created_at DESC,id DESC);
CREATE INDEX posts_author ON posts(author_id,created_at);
CREATE INDEX posts_link ON posts(link,created_at);
CREATE TABLE post_tags (post_id INTEGER NOT NULL REFERENCES posts(id),tag_id INTEGER NOT NULL REFERENCES tags(id),PRIMARY KEY(post_id,tag_id));
CREATE TABLE post_versions (id INTEGER PRIMARY KEY,post_id INTEGER NOT NULL REFERENCES posts(id),editor_id INTEGER NOT NULL REFERENCES users(id),data TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE drafts (id INTEGER PRIMARY KEY,author_id INTEGER NOT NULL REFERENCES users(id),data TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX drafts_author ON drafts(author_id,updated_at);
CREATE TABLE replies (id INTEGER PRIMARY KEY,post_id INTEGER NOT NULL REFERENCES posts(id),author_id INTEGER NOT NULL REFERENCES users(id),floor INTEGER NOT NULL,body TEXT NOT NULL,html TEXT NOT NULL,created_at INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,UNIQUE(post_id,floor));
CREATE TABLE votes (post_id INTEGER NOT NULL REFERENCES posts(id),user_id INTEGER NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL,PRIMARY KEY(post_id,user_id));
CREATE TABLE image_refs (image_id TEXT NOT NULL REFERENCES images(id),kind TEXT NOT NULL,entity_id INTEGER NOT NULL,PRIMARY KEY(image_id,kind,entity_id));
CREATE TABLE link_cache (url TEXT PRIMARY KEY,title TEXT NOT NULL,source TEXT NOT NULL,thumbnail TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE click_events (post_id INTEGER NOT NULL REFERENCES posts(id),actor TEXT NOT NULL,clicked_at INTEGER NOT NULL,PRIMARY KEY(post_id,actor));
CREATE TABLE tag_requests (id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL);
CREATE VIRTUAL TABLE posts_fts USING fts5(title,body,tags,tokenize='trigram');
CREATE TRIGGER posts_fts_insert AFTER INSERT ON posts WHEN NEW.status='public' BEGIN
 INSERT INTO posts_fts(rowid,title,body,tags) VALUES (NEW.id,NEW.title,NEW.body,NEW.tags_text);
END;
CREATE TRIGGER posts_fts_update AFTER UPDATE OF title,body,tags_text,status ON posts BEGIN
 DELETE FROM posts_fts WHERE rowid=OLD.id;
 INSERT INTO posts_fts(rowid,title,body,tags) SELECT NEW.id,NEW.title,NEW.body,NEW.tags_text WHERE NEW.status='public' AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.author_id AND banned=1);
END;
CREATE TRIGGER posts_fts_delete AFTER DELETE ON posts BEGIN DELETE FROM posts_fts WHERE rowid=OLD.id; END;
