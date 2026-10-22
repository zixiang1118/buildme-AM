ALTER TABLE posts ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN pin_category_id INTEGER REFERENCES categories(id);
ALTER TABLE posts ADD COLUMN hot_score REAL NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN last_home_seen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0;
CREATE TABLE cache_entries(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE content_revision(id INTEGER PRIMARY KEY,version INTEGER NOT NULL);
INSERT INTO content_revision VALUES(1,1);
CREATE TABLE feed_snapshots(id TEXT PRIMARY KEY,cache_key TEXT NOT NULL,viewer_id INTEGER NOT NULL,ids TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX feed_snapshots_cache ON feed_snapshots(cache_key,expires_at);
CREATE TRIGGER posts_revision_insert AFTER INSERT ON posts BEGIN UPDATE content_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER posts_revision_update AFTER UPDATE OF title,body,category_id,last_activity,status,featured,pinned,pin_category_id ON posts BEGIN UPDATE content_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER votes_revision_insert AFTER INSERT ON votes BEGIN UPDATE content_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER votes_revision_delete AFTER DELETE ON votes BEGIN UPDATE content_revision SET version=version+1 WHERE id=1; END;
CREATE VIRTUAL TABLE replies_fts USING fts5(body,tokenize='trigram');
INSERT INTO replies_fts(rowid,body) SELECT id,body FROM replies WHERE deleted=0 AND status='public';
CREATE TRIGGER replies_fts_insert AFTER INSERT ON replies WHEN NEW.deleted=0 AND NEW.status='public' BEGIN INSERT INTO replies_fts(rowid,body) VALUES(NEW.id,NEW.body); END;
CREATE TRIGGER replies_fts_update AFTER UPDATE OF body,deleted,status ON replies BEGIN
 DELETE FROM replies_fts WHERE rowid=OLD.id;
 INSERT INTO replies_fts(rowid,body) SELECT NEW.id,NEW.body WHERE NEW.deleted=0 AND NEW.status='public';
END;
CREATE TRIGGER replies_fts_delete AFTER DELETE ON replies BEGIN DELETE FROM replies_fts WHERE rowid=OLD.id; END;

CREATE INDEX image_refs_entity ON image_refs(kind,entity_id);
