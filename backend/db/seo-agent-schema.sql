-- Append these CREATE TABLE statements to backend/db/init.js inside the schema string.
-- All use TEXT IDs to match the rest of the project.

CREATE TABLE IF NOT EXISTS seo_agent_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TEXT DEFAULT (datetime('now')),
  cancelled_at TEXT,
  monthly_price REAL DEFAULT 59,
  stripe_subscription_id TEXT,
  stripe_customer_id TEXT,
  last_run_at TEXT,
  total_runs INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS seo_agent_config (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  autonomy_level TEXT DEFAULT 'manual',    -- manual | auto_safe | full_auto
  frequency_days INTEGER DEFAULT 2,
  notify_email INTEGER DEFAULT 1,
  notify_overage INTEGER DEFAULT 1,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS seo_keywords (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  location TEXT DEFAULT 'United States',
  enabled INTEGER DEFAULT 1,
  current_rank INTEGER,
  last_checked TEXT,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS seo_competitor_snapshots (
  id TEXT PRIMARY KEY,
  keyword_id TEXT NOT NULL,
  rank INTEGER,
  competitor_url TEXT,
  title TEXT,
  meta_description TEXT,
  h1 TEXT,
  word_count INTEGER,
  schema_types TEXT,            -- JSON array
  internal_links INTEGER,
  scraped_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS seo_suggestions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  keyword_id TEXT,
  type TEXT NOT NULL,           -- meta_title | meta_description | h1 | schema | content_topic | internal_link
  current_value TEXT,
  suggested_value TEXT,
  reasoning TEXT,
  source_competitors TEXT,      -- JSON array of URLs
  confidence REAL DEFAULT 0.5,
  status TEXT DEFAULT 'pending', -- pending | approved | applied | rejected | reverted
  created_at TEXT DEFAULT (datetime('now')),
  applied_at TEXT
);

CREATE TABLE IF NOT EXISTS seo_changes_history (
  id TEXT PRIMARY KEY,
  suggestion_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  applied_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_seo_kw_user ON seo_keywords(user_id);
CREATE INDEX IF NOT EXISTS idx_seo_sug_user_status ON seo_suggestions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_seo_snap_kw ON seo_competitor_snapshots(keyword_id, scraped_at);
CREATE INDEX IF NOT EXISTS idx_seo_sub_user ON seo_agent_subscriptions(user_id, status);
