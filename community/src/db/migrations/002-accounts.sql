CREATE TABLE users (
 id INTEGER PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE,
 password_hash TEXT, github_id TEXT UNIQUE, avatar_url TEXT, bio TEXT NOT NULL DEFAULT '',
 role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member','moderator','admin')),
 created_at INTEGER NOT NULL, renamed_at INTEGER, must_change_password INTEGER NOT NULL DEFAULT 0,
 banned INTEGER NOT NULL DEFAULT 0, muted_until INTEGER, first_post_approved INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE invitations (id INTEGER PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL, max_uses INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, expires_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0, created_by INTEGER REFERENCES users(id));
CREATE TABLE invitation_uses (invite_id INTEGER REFERENCES invitations(id), user_id INTEGER REFERENCES users(id), used_at INTEGER NOT NULL, PRIMARY KEY(invite_id,user_id));
CREATE TABLE oauth_states (state_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id), verifier TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE login_attempts (ip_key TEXT PRIMARY KEY, failures INTEGER NOT NULL, blocked_until INTEGER NOT NULL, last_at INTEGER NOT NULL);
CREATE TABLE rate_events (scope TEXT NOT NULL, actor TEXT NOT NULL, happened_at INTEGER NOT NULL);
CREATE INDEX rate_events_lookup ON rate_events(scope,actor,happened_at);
CREATE TABLE admin_logs (id INTEGER PRIMARY KEY, actor_id INTEGER NOT NULL REFERENCES users(id), action TEXT NOT NULL, target TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE images (id TEXT PRIMARY KEY, owner_id INTEGER REFERENCES users(id), key TEXT NOT NULL UNIQUE, url TEXT NOT NULL UNIQUE, thumb_key TEXT NOT NULL, thumb_url TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL);
