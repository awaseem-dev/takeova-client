-- MINE Schema (shared between SQLite and Postgres via pg-adapter)
-- Generated from db/init.js

CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, name TEXT, role TEXT DEFAULT 'user', account_status TEXT DEFAULT 'active', plan TEXT, stripe_customer_id TEXT, stripe_subscription_id TEXT, stripe_connect_id TEXT, email_limit INTEGER DEFAULT 500, emails_sent INTEGER DEFAULT 0, edits_used INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, streak INTEGER DEFAULT 0, referral_code TEXT UNIQUE, referred_by TEXT, referral_revenue REAL DEFAULT 0, commission_earned REAL DEFAULT 0, commission_paid REAL DEFAULT 0, two_fa_secret TEXT, two_fa_enabled INTEGER DEFAULT 0, email_verified INTEGER DEFAULT 0, verification_token TEXT, verification_sent_at TEXT, subscription_status TEXT, avatar TEXT, bio TEXT, phone TEXT, timezone TEXT, promo_used TEXT, join_date TEXT, last_login TEXT, google_id TEXT, apple_id TEXT, outreach_credits REAL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token TEXT UNIQUE NOT NULL, ip_address TEXT, user_agent TEXT, expires_at TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS sites (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, template TEXT, category TEXT, status TEXT DEFAULT 'draft', html TEXT, css TEXT, domain TEXT, custom_domain TEXT, logo TEXT, favicon TEXT, colors_json TEXT, font TEXT, seo_json TEXT, seo_title TEXT, seo_description TEXT, seo_keywords TEXT, views INTEGER DEFAULT 0, revenue REAL DEFAULT 0, leads INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, email TEXT, phone TEXT, company TEXT, status TEXT DEFAULT 'lead', source TEXT, notes TEXT, tags_json TEXT, tags TEXT, last_seen TEXT, last_activity TEXT, last_contacted TEXT, lead_score INTEGER DEFAULT 0, lead_grade TEXT DEFAULT 'F', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS deals (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT, title TEXT, value REAL DEFAULT 0, currency TEXT DEFAULT 'USD', stage TEXT DEFAULT 'lead', probability INTEGER DEFAULT 20, expected_close TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT NOT NULL, name TEXT, description TEXT, price REAL, compare_price REAL, images_json TEXT, category TEXT, tags_json TEXT, variants_json TEXT, inventory INTEGER DEFAULT 0, stock INTEGER DEFAULT 999, track_inventory INTEGER DEFAULT 0, low_stock_threshold INTEGER DEFAULT 10, variants TEXT DEFAULT '[]', status TEXT DEFAULT 'active', sku TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT NOT NULL, order_number TEXT, customer_name TEXT, customer_email TEXT, items TEXT, total REAL, shipping_name TEXT, shipping_address TEXT, status TEXT DEFAULT 'paid', fulfillment_status TEXT DEFAULT 'unfulfilled', tracking_number TEXT, tracking_url TEXT, carrier TEXT, label_url TEXT, stripe_session_id TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS coupons (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, code TEXT, type TEXT DEFAULT 'percent', value REAL, min_order REAL DEFAULT 0, max_uses INTEGER, used INTEGER DEFAULT 0, expires_at TEXT, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS gift_cards (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, code TEXT UNIQUE, initial_value REAL, current_balance REAL, recipient_email TEXT, recipient_name TEXT, message TEXT, status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, invoice_number TEXT, client_name TEXT, client_email TEXT, client_address TEXT, items_json TEXT, subtotal REAL, tax REAL, total REAL, status TEXT DEFAULT 'draft', due_date TEXT, stripe_invoice_id TEXT, paid_at TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS courses (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT NOT NULL, title TEXT, description TEXT, price REAL, modules_json TEXT, thumbnail TEXT, status TEXT DEFAULT 'draft', enrolled INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS enrollments (id TEXT PRIMARY KEY, course_id TEXT, user_id TEXT, student_email TEXT, student_name TEXT, progress_json TEXT, progress TEXT DEFAULT '{}', completed INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT NOT NULL, service_id TEXT, service TEXT, customer_name TEXT, customer_email TEXT, customer_phone TEXT, date TEXT, time TEXT, duration INTEGER DEFAULT 60, location TEXT, price REAL DEFAULT 0, status TEXT DEFAULT 'confirmed', notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS recurring_bookings (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, service_id TEXT, customer_name TEXT, customer_email TEXT, day_of_week TEXT, time TEXT, frequency TEXT DEFAULT 'weekly', start_date TEXT, end_date TEXT, status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS group_bookings (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, service_id TEXT, title TEXT, date TEXT, time TEXT, max_attendees INTEGER DEFAULT 10, current_attendees INTEGER DEFAULT 0, price REAL DEFAULT 0, description TEXT, status TEXT DEFAULT 'open', created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS group_booking_attendees (id TEXT PRIMARY KEY, group_booking_id TEXT, name TEXT, email TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT NOT NULL, title TEXT, description TEXT, date TEXT, time TEXT, start_date TEXT, end_date TEXT, location TEXT, cover_image TEXT, ticket_types_json TEXT, status TEXT DEFAULT 'draft', capacity INTEGER, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS event_tickets (id TEXT PRIMARY KEY, event_id TEXT, name TEXT, description TEXT, price REAL DEFAULT 0, quantity INTEGER, sold INTEGER DEFAULT 0, type TEXT DEFAULT 'general', buyer_email TEXT, buyer_name TEXT, ticket_type TEXT, qr_code TEXT, status TEXT DEFAULT 'valid', created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS memberships (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT NOT NULL, name TEXT, price REAL, interval_type TEXT DEFAULT 'monthly', features_json TEXT, active_members INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS blog_posts (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT NOT NULL, title TEXT, slug TEXT, content TEXT, excerpt TEXT, tags_json TEXT, cover_image TEXT, status TEXT DEFAULT 'draft', views INTEGER DEFAULT 0, published_at TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS forms (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT NOT NULL, form_id TEXT, title TEXT, fields_json TEXT, submit_text TEXT DEFAULT 'Submit', success_msg TEXT DEFAULT 'Thank you!', submissions INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS form_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, site_id TEXT, form_id TEXT, data TEXT, ip_address TEXT, user_agent TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT NOT NULL, reviewer_name TEXT, customer_name TEXT, customer_email TEXT, rating INTEGER, text TEXT, comment TEXT, source TEXT DEFAULT 'manual', verified INTEGER DEFAULT 0, approved INTEGER DEFAULT 1, product_id TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS funnels (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, trigger_event TEXT, emails_json TEXT, steps_json TEXT, status TEXT DEFAULT 'draft', contacts_entered INTEGER DEFAULT 0, conversions INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS email_templates (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, subject TEXT, body_html TEXT, html TEXT, preview_text TEXT, blocks TEXT, category TEXT, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS email_templates_user (id TEXT PRIMARY KEY, user_id TEXT, site_id TEXT, name TEXT, subject TEXT, body TEXT, trigger_event TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS email_log (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    to_email TEXT,
    subject TEXT,
    type TEXT,
    opened INTEGER DEFAULT 0,
    clicked INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
    CREATE TABLE IF NOT EXISTS site_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, site_id TEXT NOT NULL, html TEXT, change_description TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS ai_edits_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, original_text TEXT, new_text TEXT, prompt TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE INDEX IF NOT EXISTS idx_site_versions_site ON site_versions(site_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_ai_edits_user ON ai_edits_log(user_id, created_at)

-- ────────────────────────────────────────────────────────────────────────────
-- Added by recent sessions — per-user integration credentials + notifications
-- These also auto-create at runtime via ensureTable(), so safe to add here for
-- clean schema restores too.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_integration_keys (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    service         TEXT NOT NULL,
    ciphertext      TEXT NOT NULL,
    iv              TEXT NOT NULL,
    auth_tag        TEXT NOT NULL,
    meta            TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    last_used_at    TEXT,
    auto_sync_enabled INTEGER DEFAULT 1,
    last_sync_at    TEXT,
    last_sync_status TEXT,
    last_sync_count INTEGER,
    consecutive_failures INTEGER DEFAULT 0,
    last_failure_email_at TEXT,
    UNIQUE(user_id, service)
);

CREATE TABLE IF NOT EXISTS user_notifications (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    type            TEXT,
    severity        TEXT,
    title           TEXT,
    body            TEXT,
    action_url      TEXT,
    action_label    TEXT,
    read            INTEGER DEFAULT 0,
    created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_user_notifications_user_id_read ON user_notifications(user_id, read);

CREATE TABLE IF NOT EXISTS push_tokens (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    token           TEXT NOT NULL,
    platform        TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, token)
);
