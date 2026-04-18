CREATE TABLE IF NOT EXISTS ai_posts (
	id TEXT PRIMARY KEY,
	slug TEXT NOT NULL UNIQUE,
	title TEXT NOT NULL,
	normalized_title TEXT NOT NULL UNIQUE,
	description TEXT NOT NULL,
	tags_json TEXT NOT NULL,
	mdx_content TEXT NOT NULL,
	canonical_content TEXT NOT NULL,
	content_hash TEXT NOT NULL UNIQUE,
	model_name TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'published',
	publish_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_posts_publish_at ON ai_posts(publish_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_posts_status_publish_at ON ai_posts(status, publish_at DESC);

CREATE TABLE IF NOT EXISTS ai_post_tags (
	post_id TEXT NOT NULL,
	tag TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (post_id, tag),
	FOREIGN KEY (post_id) REFERENCES ai_posts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_post_tags_tag ON ai_post_tags(tag);

CREATE TABLE IF NOT EXISTS ai_generation_runs (
	run_id TEXT PRIMARY KEY,
	date_key TEXT NOT NULL,
	status TEXT NOT NULL,
	trigger_source TEXT NOT NULL,
	attempt INTEGER NOT NULL DEFAULT 0,
	error_message TEXT,
	post_id TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	FOREIGN KEY (post_id) REFERENCES ai_posts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_generation_runs_date_key ON ai_generation_runs(date_key);
CREATE INDEX IF NOT EXISTS idx_ai_generation_runs_status ON ai_generation_runs(status);
