ALTER TABLE posts ADD COLUMN share_data TEXT NOT NULL DEFAULT '';
UPDATE drafts SET data=json_set(data,'$.shareData','');
