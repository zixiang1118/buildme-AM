ALTER TABLE tags ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN profile_pending INTEGER NOT NULL DEFAULT 0;
CREATE TABLE site_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO site_settings VALUES('first_post_review','1');
CREATE TABLE blocked_words(id INTEGER PRIMARY KEY,word TEXT NOT NULL UNIQUE,level TEXT NOT NULL CHECK(level IN ('reject','review')));
CREATE TABLE reports(id INTEGER PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('post','reply')),target_id INTEGER NOT NULL,reporter_id INTEGER NOT NULL REFERENCES users(id),reason TEXT NOT NULL,description TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(kind,target_id,reporter_id));
CREATE INDEX reports_target ON reports(kind,target_id);
CREATE TABLE pending_profiles(user_id INTEGER PRIMARY KEY REFERENCES users(id),username TEXT NOT NULL,bio TEXT NOT NULL,created_at INTEGER NOT NULL);

CREATE TABLE notifications_new(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),actor_id INTEGER NOT NULL REFERENCES users(id),kind TEXT NOT NULL,post_id INTEGER REFERENCES posts(id),floor INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,read_at INTEGER,message TEXT NOT NULL DEFAULT '',link TEXT NOT NULL DEFAULT '');
INSERT INTO notifications_new(id,user_id,actor_id,kind,post_id,floor,created_at,updated_at,read_at) SELECT id,user_id,actor_id,kind,post_id,floor,created_at,updated_at,read_at FROM notifications;
CREATE TABLE notification_actors_new(notification_id INTEGER NOT NULL REFERENCES notifications_new(id) ON DELETE CASCADE,user_id INTEGER NOT NULL REFERENCES users(id),PRIMARY KEY(notification_id,user_id));
INSERT INTO notification_actors_new SELECT * FROM notification_actors;
DROP TABLE notification_actors;
DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;
ALTER TABLE notification_actors_new RENAME TO notification_actors;
CREATE INDEX notifications_inbox ON notifications(user_id,updated_at DESC,id DESC);
CREATE INDEX notifications_group ON notifications(user_id,post_id,kind,created_at);
