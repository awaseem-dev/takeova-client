const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
let db;
function init() {
  const dataDir = process.env.DB_PATH ? path.join(process.env.DB_PATH) : path.join(__dirname, "../data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  db = new Database(path.join(dataDir, "mine.db"));
  // [persistence guard] SQLite keeps EVERYTHING in this one file. On ephemeral hosts
  // (Railway / Render / Fly default filesystems) that file is WIPED on every redeploy
  // unless `dataDir` is a mounted persistent volume. We can't detect a real volume from
  // inside the process, so warn loudly whenever SQLite is the production store and print
  // the resolved path so the operator can confirm it's on a volume.
  if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL) {
    const dbFile = path.join(dataDir, "mine.db");
    console.warn("[persistence] Using SQLite at " + dbFile + " in production.");
    console.warn("[persistence] If this path is NOT a mounted persistent volume, ALL DATA IS LOST on redeploy.");
    console.warn("[persistence] Railway: attach a Volume, then set DB_PATH to its mount path (e.g. DB_PATH=/data).");
  }
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // [boot-safety] Some CREATE INDEX statements below (and lazily-created route tables) reference
  // tables that don't exist yet on a FRESH database during this first init pass. Tolerate
  // "no such table/column" for DDL so the server boots cleanly; deferred indexes are created on
  // the next boot once their tables exist. Real SQL/syntax errors still propagate.
  { const _rawExec = db.exec.bind(db); db.exec = (sql) => { try { return _rawExec(sql); } catch (e) { if (/no such (table|column)/i.test(e.message)) { return db; } throw e; } }; }
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, name TEXT, role TEXT DEFAULT 'user', account_status TEXT DEFAULT 'active', plan TEXT, stripe_customer_id TEXT, stripe_subscription_id TEXT, stripe_connect_id TEXT, email_limit INTEGER DEFAULT 500, emails_sent INTEGER DEFAULT 0, edits_used INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, streak INTEGER DEFAULT 0, referral_code TEXT UNIQUE, referred_by TEXT, referral_revenue REAL DEFAULT 0, commission_earned REAL DEFAULT 0, commission_paid REAL DEFAULT 0, two_fa_secret TEXT, two_fa_enabled INTEGER DEFAULT 0, avatar TEXT, bio TEXT, phone TEXT, timezone TEXT, promo_used TEXT, join_date TEXT, last_login TEXT, google_id TEXT, apple_id TEXT, outreach_credits REAL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token TEXT UNIQUE NOT NULL, ip_address TEXT, user_agent TEXT, expires_at TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS sites (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, template TEXT, category TEXT, status TEXT DEFAULT 'draft', html TEXT, css TEXT, domain TEXT, custom_domain TEXT, logo TEXT, favicon TEXT, colors_json TEXT, font TEXT, seo_json TEXT, seo_title TEXT, seo_description TEXT, seo_keywords TEXT, views INTEGER DEFAULT 0, revenue REAL DEFAULT 0, leads INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, email TEXT, phone TEXT, company TEXT, status TEXT DEFAULT 'lead', source TEXT, notes TEXT, tags_json TEXT, tags TEXT, last_seen TEXT, last_activity TEXT, last_contacted TEXT, lead_score INTEGER DEFAULT 0, lead_grade TEXT DEFAULT 'F', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS deals (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT, title TEXT, value REAL DEFAULT 0, currency TEXT DEFAULT 'USD', stage TEXT DEFAULT 'lead', probability INTEGER DEFAULT 20, expected_close TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT NOT NULL, name TEXT, description TEXT, price REAL, compare_price REAL, images_json TEXT, category TEXT, tags_json TEXT, variants_json TEXT, inventory INTEGER DEFAULT 0, stock INTEGER DEFAULT 999, track_inventory INTEGER DEFAULT 0, low_stock_threshold INTEGER DEFAULT 10, variants TEXT DEFAULT '[]', status TEXT DEFAULT 'active', sku TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT NOT NULL, order_number TEXT, customer_name TEXT, customer_email TEXT, items TEXT, total REAL, shipping_name TEXT, shipping_address TEXT, status TEXT DEFAULT 'paid', fulfillment_status TEXT DEFAULT 'unfulfilled', tracking_number TEXT, tracking_url TEXT, carrier TEXT, label_url TEXT, stripe_session_id TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS coupons (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, code TEXT, type TEXT DEFAULT 'percent', value REAL, min_order REAL DEFAULT 0, max_uses INTEGER, used INTEGER DEFAULT 0, expires_at TEXT, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS gift_cards (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, code TEXT UNIQUE, initial_value REAL, current_balance REAL, recipient_email TEXT, recipient_name TEXT, message TEXT, status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, invoice_number TEXT, client_name TEXT, client_email TEXT, client_address TEXT, items_json TEXT, subtotal REAL, tax REAL, total REAL, status TEXT DEFAULT 'draft', due_date TEXT, stripe_invoice_id TEXT, paid_at TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS platform_charges (id INTEGER PRIMARY KEY AUTOINCREMENT, charge_number TEXT UNIQUE, user_id TEXT NOT NULL, admin_user_id TEXT NOT NULL, description TEXT, amount_cents INTEGER, status TEXT DEFAULT 'pending', stripe_checkout_url TEXT, stripe_session_id TEXT, stripe_payment_intent_id TEXT, due_date TEXT, notes TEXT, paid_at TEXT, refunded_at TEXT, cancelled_at TEXT, last_reminder_at TEXT, reminder_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS courses (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT NOT NULL, title TEXT, description TEXT, price REAL, modules_json TEXT, thumbnail TEXT, status TEXT DEFAULT 'draft', enrolled INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS enrollments (id TEXT PRIMARY KEY, course_id TEXT, user_id TEXT, student_email TEXT, student_name TEXT, progress_json TEXT, progress TEXT DEFAULT '{}', completed INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT NOT NULL, service_id TEXT, service TEXT, customer_name TEXT, customer_email TEXT, customer_phone TEXT, date TEXT, time TEXT, duration INTEGER DEFAULT 60, location TEXT, price REAL DEFAULT 0, status TEXT DEFAULT 'confirmed', notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS recurring_bookings (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, service_id TEXT, customer_name TEXT, customer_email TEXT, day_of_week TEXT, time TEXT, frequency TEXT DEFAULT 'weekly', start_date TEXT, end_date TEXT, status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS group_bookings (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, service_id TEXT, title TEXT, date TEXT, time TEXT, max_attendees INTEGER DEFAULT 10, current_attendees INTEGER DEFAULT 0, price REAL DEFAULT 0, description TEXT, status TEXT DEFAULT 'open', created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS group_booking_attendees (id TEXT PRIMARY KEY, group_booking_id TEXT, name TEXT, email TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT NOT NULL, title TEXT, description TEXT, date TEXT, time TEXT, start_date TEXT, end_date TEXT, location TEXT, cover_image TEXT, ticket_types_json TEXT, status TEXT DEFAULT 'draft', capacity INTEGER, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS event_tickets (id TEXT PRIMARY KEY, event_id TEXT, name TEXT, description TEXT, price REAL DEFAULT 0, quantity INTEGER, sold INTEGER DEFAULT 0, type TEXT DEFAULT 'general', buyer_email TEXT, buyer_name TEXT, ticket_type TEXT, qr_code TEXT, status TEXT DEFAULT 'valid', created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS memberships (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT NOT NULL, name TEXT, price REAL, interval_type TEXT DEFAULT 'monthly', features_json TEXT, active_members INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS mrr_snapshots (user_id TEXT NOT NULL, snapshot_date TEXT NOT NULL, mrr REAL DEFAULT 0, subscribers INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (user_id, snapshot_date));
    CREATE TABLE IF NOT EXISTS blog_posts (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT NOT NULL, title TEXT, slug TEXT, content TEXT, excerpt TEXT, tags_json TEXT, cover_image TEXT, status TEXT DEFAULT 'draft', views INTEGER DEFAULT 0, published_at TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS forms (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT NOT NULL, form_id TEXT, title TEXT, fields_json TEXT, submit_text TEXT DEFAULT 'Submit', success_msg TEXT DEFAULT 'Thank you!', submissions INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS form_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, site_id TEXT, form_id TEXT, data TEXT, ip_address TEXT, user_agent TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT NOT NULL, reviewer_name TEXT, customer_name TEXT, customer_email TEXT, rating INTEGER, text TEXT, comment TEXT, source TEXT DEFAULT 'manual', verified INTEGER DEFAULT 0, approved INTEGER DEFAULT 1, product_id TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS funnels (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, trigger_event TEXT, emails_json TEXT, steps_json TEXT, status TEXT DEFAULT 'draft', contacts_entered INTEGER DEFAULT 0, conversions INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS brand_kit (user_id TEXT PRIMARY KEY, logo_url TEXT, primary_color TEXT DEFAULT '#111111', secondary_color TEXT DEFAULT '#ffffff', accent_color TEXT DEFAULT '#6d28d9', font_heading TEXT DEFAULT 'Inter', font_body TEXT DEFAULT 'Inter', tagline TEXT, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS help_articles (id TEXT PRIMARY KEY, title TEXT, body TEXT, category TEXT DEFAULT 'General', slug TEXT, sort INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
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
  )
`);

  db.exec(`CREATE TABLE IF NOT EXISTS email_tracking (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, subject TEXT, track_id TEXT UNIQUE, opened INTEGER DEFAULT 0, opened_at TEXT, clicks INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`);

db.exec(`
   CREATE TABLE IF NOT EXISTS email_sends (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, recipient_email TEXT, subject TEXT, status TEXT, template_id TEXT, opened INTEGER DEFAULT 0, clicked INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS social_posts (id TEXT PRIMARY KEY, user_id TEXT, text TEXT, platforms TEXT, status TEXT DEFAULT 'published', results TEXT, posted_at TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS ad_campaigns (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, site_id TEXT, name TEXT, platform TEXT, objective TEXT, audience TEXT, daily_budget REAL, budget REAL, budget_type TEXT, total_spent REAL DEFAULT 0, status TEXT DEFAULT 'draft', platform_campaign_id TEXT, start_date TEXT, end_date TEXT, channel_type TEXT DEFAULT 'SEARCH', targeting_json TEXT, creatives_json TEXT, impressions INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0, conversions INTEGER DEFAULT 0, spend REAL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS ad_creatives (id TEXT PRIMARY KEY, campaign_id TEXT, user_id TEXT, headline TEXT, body TEXT, image_url TEXT, video_url TEXT, video_script TEXT, video_format TEXT, video_duration TEXT, cta_text TEXT, cta_url TEXT, variant_label TEXT, impressions INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0, conversions INTEGER DEFAULT 0, spend REAL DEFAULT 0, status TEXT DEFAULT 'active', platform_ad_id TEXT, platform_creative_id TEXT, video_task_id TEXT, video_provider TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS pending_video_tasks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, campaign_id TEXT, creative_id TEXT, task_id TEXT NOT NULL, provider TEXT DEFAULT 'arcads', attempts INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')));
    CREATE INDEX IF NOT EXISTS idx_pvt_status ON pending_video_tasks(status, provider);
    CREATE TABLE IF NOT EXISTS contracts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, client_name TEXT, client_email TEXT, content TEXT, body TEXT, template TEXT, amount REAL DEFAULT 0, status TEXT DEFAULT 'draft', sign_token TEXT UNIQUE, signed_at TEXT, sent_at TEXT, viewed_at TEXT, expires_at TEXT, signature TEXT, signature_data TEXT, signature_name TEXT, signer_ip TEXT, currency TEXT DEFAULT 'USD', created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_name TEXT, client_email TEXT, description TEXT, services TEXT DEFAULT '[]', amount REAL, content TEXT, html TEXT, pdf_url TEXT, status TEXT DEFAULT 'draft', follow_up_count INTEGER DEFAULT 0, opened_at TEXT, signed_at TEXT, signer_name TEXT, signature_data TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, trigger_type TEXT, trigger_event TEXT, trigger_config TEXT, conditions TEXT DEFAULT '[]', actions_json TEXT, actions TEXT DEFAULT '[]', active INTEGER DEFAULT 1, enabled INTEGER DEFAULT 1, runs INTEGER DEFAULT 0, run_count INTEGER DEFAULT 0, last_run TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS link_in_bio (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT UNIQUE NOT NULL, username TEXT UNIQUE, title TEXT, bio TEXT, avatar TEXT, theme TEXT DEFAULT 'minimal', button_style TEXT DEFAULT 'rounded', bg_color TEXT DEFAULT '#ffffff', text_color TEXT DEFAULT '#1a1a1a', button_color TEXT DEFAULT '#635BFF', button_text_color TEXT DEFAULT '#ffffff', show_socials INTEGER DEFAULT 1, show_branding INTEGER DEFAULT 1, links TEXT DEFAULT '[]', header_image TEXT, font TEXT, view_count INTEGER DEFAULT 0, click_count INTEGER DEFAULT 0, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS referrals (id TEXT PRIMARY KEY, referrer_id TEXT, referred_id TEXT, referred_name TEXT, plan TEXT, commission REAL, status TEXT DEFAULT 'pending', paid_at TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS affiliate_links (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, slug TEXT UNIQUE, destination_url TEXT, clicks INTEGER DEFAULT 0, conversions INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS mine_affiliate_assets (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, category TEXT NOT NULL, file_url TEXT NOT NULL, file_name TEXT, file_size INTEGER, file_type TEXT, thumbnail_url TEXT, downloads INTEGER DEFAULT 0, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT, icon TEXT, text TEXT, data TEXT, read INTEGER DEFAULT 0, time TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS webhooks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, url TEXT, event TEXT, events TEXT, app_id TEXT, secret TEXT, active INTEGER DEFAULT 1, status TEXT DEFAULT 'active', failures INTEGER DEFAULT 0, last_fired TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS webhook_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, webhook_id TEXT, event TEXT, payload TEXT, response_code INTEGER, response_status TEXT, response_body TEXT, duration_ms INTEGER, status TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS installed_apps (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, app_slug TEXT, config_json TEXT, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS ai_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, type TEXT, tokens INTEGER, cost REAL, model TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS chatbot_conversations (id TEXT PRIMARY KEY, site_id TEXT, visitor_id TEXT, visitor_name TEXT, visitor_email TEXT, messages_json TEXT, messages TEXT, lead_captured INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS coaching_sessions (id TEXT PRIMARY KEY, user_id TEXT, client_id TEXT, client_name TEXT, client_email TEXT, date TEXT, duration_min INTEGER, goals TEXT, notes TEXT, homework TEXT, next_session TEXT, status TEXT DEFAULT 'scheduled', created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS waitlist (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT, email TEXT, name TEXT, position INTEGER, status TEXT DEFAULT 'waiting', created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT, details TEXT, ip_address TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS dunning_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, type TEXT NOT NULL, attempt INTEGER DEFAULT 1, amount REAL, period TEXT, stripe_invoice_id TEXT, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS platform_charges (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, admin_user_id TEXT, charge_number TEXT, amount_cents INTEGER NOT NULL, description TEXT, notes TEXT, status TEXT DEFAULT 'pending', due_date TEXT, stripe_checkout_url TEXT, stripe_session_id TEXT, stripe_payment_intent_id TEXT, paid_at TEXT, cancelled_at TEXT, refunded_at TEXT, last_reminder_at TEXT, created_at TEXT DEFAULT (datetime('now')));
`);

  // ─── Tables created inline in routes — ensure exist at startup ───
  db.exec(`CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY, user_id TEXT, type TEXT, amount REAL, category TEXT,
      description TEXT, source TEXT, reference_id TEXT, date TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
  db.exec(`CREATE TABLE IF NOT EXISTS page_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT, site_id TEXT, path TEXT,
      referrer TEXT, user_agent TEXT, ip_hash TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
  db.exec(`CREATE TABLE IF NOT EXISTS support_tickets (
      id TEXT PRIMARY KEY, user_id TEXT, subject TEXT, status TEXT DEFAULT 'open',
      priority TEXT DEFAULT 'normal', created_at TEXT DEFAULT (datetime('now'))
    )`);
  db.exec(`CREATE TABLE IF NOT EXISTS funnel_enrollments (
      id TEXT PRIMARY KEY, funnel_id TEXT, user_id TEXT, email TEXT, name TEXT,
      current_step INTEGER DEFAULT 0, status TEXT DEFAULT 'active',
      enrolled_at TEXT DEFAULT (datetime('now'))
    )`);
  db.exec(`CREATE TABLE IF NOT EXISTS membership_tiers (
      id TEXT PRIMARY KEY, user_id TEXT, name TEXT, price REAL, interval TEXT,
      features TEXT, created_at TEXT DEFAULT (datetime('now'))
    )`);
  db.exec(`CREATE TABLE IF NOT EXISTS mine_affiliate_conversions (
      id TEXT PRIMARY KEY, affiliate_id TEXT, user_id TEXT, type TEXT,
      amount REAL, commission REAL, status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    )`);
  db.exec(`CREATE TABLE IF NOT EXISTS product_sub_subscribers (
      id TEXT PRIMARY KEY, user_id TEXT, product_id TEXT, customer_email TEXT,
      customer_name TEXT, stripe_subscription_id TEXT, stripe_customer_id TEXT,
      status TEXT DEFAULT 'active', dunning_attempt INTEGER DEFAULT 0,
      dunning_paused_at TEXT, next_charge TEXT, created_at TEXT DEFAULT (datetime('now'))
    )`);
  db.exec(`CREATE TABLE IF NOT EXISTS sales_copy_history (
      id TEXT PRIMARY KEY, user_id TEXT, copy_type TEXT, input TEXT, output TEXT,
      is_overage INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
    )`);
  db.exec(`CREATE TABLE IF NOT EXISTS affiliate_programs (
      id TEXT PRIMARY KEY, user_id TEXT, name TEXT, commission_type TEXT,
      commission_value REAL, cookie_days INTEGER DEFAULT 30,
      created_at TEXT DEFAULT (datetime('now'))
    )`);

try { db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sites_user ON sites(user_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(user_id, email);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_number ON invoices(user_id, invoice_number);
    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_form_subs ON form_submissions(site_id, form_id);
    CREATE INDEX IF NOT EXISTS idx_link_bio ON link_in_bio(username);
    CREATE INDEX IF NOT EXISTS idx_webhooks ON webhooks(user_id, event);
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS password_resets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token TEXT UNIQUE NOT NULL, expires_at TEXT NOT NULL, used INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token);
    CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_email ON bookings(customer_email);
    CREATE INDEX IF NOT EXISTS idx_products_user ON products(user_id);
    -- High-traffic table indexes (Fix 3)
    CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id);
    CREATE INDEX IF NOT EXISTS idx_contracts_user ON contracts(user_id);
  `); } catch (e) { console.error('[init] core index batch deferred (some tables created later this boot):', e.message); }

  // ── Deferred indexes for tables created lazily in routes ──
  // These tables may not exist yet on a fresh install, so we use try/catch.
  // On next startup after the tables are created these will succeed and be a no-op thereafter.
  const deferredIndexes = [
    "CREATE INDEX IF NOT EXISTS idx_fe_user ON funnel_enrollments(user_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_email_tracking_user ON email_tracking(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_email_tracking_track ON email_tracking(track_id)",
    "CREATE INDEX IF NOT EXISTS idx_affiliate_conversions_user ON mine_affiliate_conversions(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_affiliate_conversions_ref ON mine_affiliate_conversions(referrer_id)",
    "CREATE INDEX IF NOT EXISTS idx_usage_tracking ON usage_tracking(user_id, metric, period)",
    "CREATE INDEX IF NOT EXISTS idx_overage_charges ON overage_charges(user_id, period, status)",
    "CREATE INDEX IF NOT EXISTS idx_intelligence_user ON intelligence_insights(user_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_sales_copy_history ON sales_copy_history(user_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_ai_research_user ON ai_research(user_id, created_at)",
    // High-frequency tables missing indexes
    "CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_customer_accounts_user ON customer_accounts(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_product_sub_subscribers_user ON product_sub_subscribers(user_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_loyalty_config_user ON loyalty_config(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_page_views_site ON page_views(site_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_ai_employees_user ON ai_employees(user_id, role, enabled)",
    "CREATE INDEX IF NOT EXISTS idx_email_sends_user ON email_sends(user_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_abandoned_carts_site ON abandoned_carts(site_id, recovered)",
    "CREATE INDEX IF NOT EXISTS idx_automations_user ON automations(user_id, trigger_event, enabled)",
    "CREATE INDEX IF NOT EXISTS idx_chatbot_conversations_site ON chatbot_conversations(site_id, updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_voice_packs_user ON voice_packs(user_id, mins_used)",
    "CREATE INDEX IF NOT EXISTS idx_membership_tiers_user ON membership_tiers(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_affiliate_programs_user ON affiliate_programs(user_id)",
    // Team members / multi-user access
    `CREATE TABLE IF NOT EXISTS team_members (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      member_user_id TEXT,
      email TEXT NOT NULL,
      role TEXT DEFAULT 'editor',
      status TEXT DEFAULT 'pending',
      invite_token TEXT UNIQUE,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    "CREATE INDEX IF NOT EXISTS idx_team_members_owner ON team_members(owner_id)",
    "CREATE INDEX IF NOT EXISTS idx_team_members_token ON team_members(invite_token)",
    // Prevent two sites claiming the same custom domain
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_custom_domain ON sites(custom_domain) WHERE custom_domain IS NOT NULL AND custom_domain != ''",
  ];
  for (const sql of deferredIndexes) {
    try { db.exec(sql); } catch(e) { /* table not yet created — will be indexed on next startup */ }
  }

  // ── Migrations: safely add columns that may be missing from older DBs ──
  // Core tables created inline in routes — add them here for reliability
  db.exec(`CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, site_id TEXT, filename TEXT, original_name TEXT, mime_type TEXT, size INTEGER, url TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  db.exec(`CREATE TABLE IF NOT EXISTS social_connections (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, platform TEXT, access_token TEXT, refresh_token TEXT, expires_at TEXT, profile_id TEXT, profile_name TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(user_id, platform))`);
  db.exec(`CREATE TABLE IF NOT EXISTS microsoft_connections (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ms_user_id TEXT, ms_email TEXT, ms_name TEXT, access_token TEXT, refresh_token TEXT, expires_at INTEGER, scope TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), UNIQUE(user_id))`);
  db.exec(`CREATE TABLE IF NOT EXISTS microsoft_oauth_states (state TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  db.exec(`CREATE TABLE IF NOT EXISTS platform_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now')))`);
  db.exec(`CREATE TABLE IF NOT EXISTS admin_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now')))`);

  // MINE Control tables — created at startup so the WhatsApp agent never throws on first message
  db.exec(`CREATE TABLE IF NOT EXISTS mine_control_config (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    whatsapp_number TEXT,
    enabled INTEGER DEFAULT 1,
    messages_used INTEGER DEFAULT 0,
    messages_period TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS mine_control_messages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    message TEXT NOT NULL,
    whatsapp_msg_id TEXT UNIQUE,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mine_control_messages ON mine_control_messages(user_id, created_at)`);

  // Sync admin_settings -> platform_settings so all getSetting() calls work regardless of which table was written
  try {
    const adminRows = db.prepare("SELECT key, value FROM admin_settings").all();
    const upsert = db.prepare("INSERT OR IGNORE INTO platform_settings (key, value) VALUES (?, ?)");
    for (const r of adminRows) upsert.run(r.key, r.value);
  } catch(e) {}

  // Ensure uploads directory exists
  const uploadsDir = process.env.UPLOAD_DIR || require('path').join(__dirname, '../../uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

  // ── Voice tables — created at startup so checkUsage('voiceMins') never throws on a fresh deploy ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_packs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      mins_total INTEGER NOT NULL DEFAULT 100,
      mins_used INTEGER NOT NULL DEFAULT 0,
      purchased_at TEXT DEFAULT (datetime('now')),
      stripe_payment_id TEXT,
      expires_at TEXT
    );
    CREATE TABLE IF NOT EXISTS voice_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      call_sid TEXT,
      caller TEXT,
      status TEXT,
      transcript TEXT,
      stage TEXT DEFAULT 'intake_name',
      caller_name TEXT,
      caller_email TEXT,
      call_duration_secs INTEGER,
      ended_at TEXT,
      followup_sent TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS voice_leads (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      session_id TEXT,
      caller_phone TEXT,
      intent TEXT,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS user_voice_numbers (
      user_id TEXT PRIMARY KEY,
      phone_number TEXT,
      twilio_number_sid TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS usage_tracking (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      amount REAL DEFAULT 1,
      period TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, metric, period)
    );
    CREATE TABLE IF NOT EXISTS overage_charges (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      quantity REAL,
      unit_price REAL,
      total REAL,
      period TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ai_research (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      topic TEXT,
      summary TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Ensure abandoned_carts has all needed columns
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS abandoned_carts (id TEXT PRIMARY KEY, site_id TEXT, email TEXT, customer_email TEXT, customer_name TEXT, items TEXT, cart_total REAL, cart_url TEXT, session_id TEXT, recovered INTEGER DEFAULT 0, reminder_sent INTEGER DEFAULT 0, reminder_count INTEGER DEFAULT 0, recovery_email_sent INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`);
  } catch(e) {}

  // Ensure download_tokens table exists
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS download_tokens (id TEXT PRIMARY KEY, user_id TEXT, order_id TEXT, product_id TEXT, filename TEXT, original_name TEXT, token TEXT UNIQUE, expires_at TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  } catch(e) {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS community_replies (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, platform TEXT,
    external_post_id TEXT, post_title TEXT, subreddit TEXT,
    reply_text TEXT, posted INTEGER DEFAULT 0, post_error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`); } catch(e) {}
  try { db.exec("ALTER TABLE mine_control_config ADD COLUMN customer_mode_enabled INTEGER DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE mine_control_config ADD COLUMN customer_greeting TEXT DEFAULT 'Hi! How can I help you today?'"); } catch(e) {}
  try { db.exec("ALTER TABLE mine_control_config ADD COLUMN fallback_message TEXT DEFAULT 'Thanks for reaching out! We\'ll get back to you as soon as possible.'"); } catch(e) {}

  // Tables used in Stripe webhook and crons — must exist at startup before any route fires
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS digital_downloads (id TEXT PRIMARY KEY, user_id TEXT, order_id TEXT, customer_email TEXT, product_name TEXT, download_url TEXT, token TEXT UNIQUE, downloads INTEGER DEFAULT 0, max_downloads INTEGER DEFAULT 5, expires_at TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS scheduled_emails (id TEXT PRIMARY KEY, user_id TEXT, email TEXT, subject TEXT, body TEXT, send_at TEXT, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS customer_accounts (id TEXT PRIMARY KEY, site_id TEXT, email TEXT, name TEXT, phone TEXT, total_spent REAL DEFAULT 0, order_count INTEGER DEFAULT 0, loyalty_points INTEGER DEFAULT 0, created_at TEXT, last_login TEXT);
      CREATE TABLE IF NOT EXISTS loyalty_config (id TEXT PRIMARY KEY, user_id TEXT UNIQUE, enabled INTEGER DEFAULT 1, points_per_dollar REAL DEFAULT 1, signup_bonus INTEGER DEFAULT 50, referral_bonus INTEGER DEFAULT 100, birthday_bonus INTEGER DEFAULT 50, review_bonus INTEGER DEFAULT 25, course_complete_bonus INTEGER DEFAULT 100, booking_bonus INTEGER DEFAULT 10, tiers TEXT DEFAULT '[]', milestones TEXT DEFAULT '[]', rewards TEXT DEFAULT '[]', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS loyalty_transactions (id TEXT PRIMARY KEY, customer_id TEXT, user_id TEXT, type TEXT, points INTEGER, balance_after INTEGER, description TEXT, reference_id TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS loyalty_milestones_achieved (id TEXT PRIMARY KEY, customer_id TEXT, milestone_name TEXT, points_awarded INTEGER, created_at TEXT DEFAULT (datetime('now')), UNIQUE(customer_id, milestone_name));
      CREATE TABLE IF NOT EXISTS loyalty_redemptions (id TEXT PRIMARY KEY, customer_id TEXT, user_id TEXT, reward_name TEXT, points_spent INTEGER, type TEXT, value REAL, coupon_code TEXT UNIQUE, used INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS ad_performance (id TEXT PRIMARY KEY, campaign_id TEXT, date TEXT, impressions INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0, conversions INTEGER DEFAULT 0, spend REAL DEFAULT 0, ctr REAL DEFAULT 0, cpc REAL DEFAULT 0, cpa REAL DEFAULT 0, roas REAL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), UNIQUE(campaign_id, date));
      CREATE TABLE IF NOT EXISTS partner_sessions (token TEXT PRIMARY KEY, partner_id TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, subscription TEXT NOT NULL, type TEXT DEFAULT 'web', platform TEXT DEFAULT 'web', created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS push_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token TEXT UNIQUE, platform TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS ai_employees (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, role TEXT NOT NULL, enabled INTEGER DEFAULT 1, rules TEXT DEFAULT '[]', schedule TEXT DEFAULT '{}', autonomy TEXT DEFAULT 'semi', tone TEXT DEFAULT 'professional', custom_name TEXT, business_context TEXT, email_signature TEXT, policies TEXT, brand_voice TEXT, inspiration_media TEXT, created_at TEXT, updated_at TEXT, UNIQUE(user_id, role));
      CREATE TABLE IF NOT EXISTS ai_employee_actions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, role TEXT NOT NULL, action TEXT, details TEXT, result TEXT, status TEXT DEFAULT 'pending', confidence REAL DEFAULT 0, created_at TEXT, approved_at TEXT, completed_at TEXT);
      CREATE TABLE IF NOT EXISTS intelligence_insights (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, date TEXT NOT NULL, insights TEXT DEFAULT '[]', generated_at TEXT DEFAULT (datetime('now')), email_sent INTEGER DEFAULT 0, push_sent INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS outreach_campaigns (id TEXT PRIMARY KEY, user_id TEXT, list_id TEXT, name TEXT, channel TEXT DEFAULT 'email', goal TEXT, context TEXT, tone TEXT, follow_ups INTEGER DEFAULT 0, follow_up_days TEXT DEFAULT '[2,5]', schedule TEXT, scheduled_time TEXT, sender_name TEXT, sender_email TEXT, signature TEXT, offer TEXT, call_to_action TEXT, daily_limit INTEGER DEFAULT 100, unsubscribe_link INTEGER DEFAULT 1, status TEXT DEFAULT 'draft', total_contacts INTEGER DEFAULT 0, estimated_cost TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS booking_reminders (id TEXT PRIMARY KEY, booking_id TEXT, user_id TEXT, customer_email TEXT, customer_name TEXT, customer_phone TEXT, service TEXT, reminder_time TEXT, type TEXT, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS user_settings (user_id TEXT, key TEXT, value TEXT, PRIMARY KEY(user_id, key));
      CREATE TABLE IF NOT EXISTS portal_clients (id TEXT PRIMARY KEY, site_id TEXT, user_id TEXT, email TEXT, name TEXT, token TEXT UNIQUE, token_expires TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS services (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
        description TEXT, duration_minutes INTEGER DEFAULT 60,
        price REAL DEFAULT 0, category TEXT, color TEXT DEFAULT '#635BFF',
        active INTEGER DEFAULT 1, buffer_minutes INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS staff_profiles (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
        email TEXT, phone TEXT, role TEXT, bio TEXT, avatar TEXT,
        color TEXT DEFAULT '#635BFF', active INTEGER DEFAULT 1,
        working_hours TEXT DEFAULT '{"mon":"09:00-17:00","tue":"09:00-17:00","wed":"09:00-17:00","thu":"09:00-17:00","fri":"09:00-17:00"}',
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS staff_services (
        id TEXT PRIMARY KEY, staff_id TEXT NOT NULL, service_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        UNIQUE(staff_id, service_id)
      );
      CREATE TABLE IF NOT EXISTS property_listings (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, site_id TEXT,
        title TEXT NOT NULL, address TEXT, suburb TEXT, city TEXT, postcode TEXT,
        type TEXT DEFAULT 'sale', status TEXT DEFAULT 'active',
        price REAL, price_display TEXT, bedrooms INTEGER, bathrooms INTEGER,
        parking INTEGER, land_sqm REAL, floor_sqm REAL,
        description TEXT, features TEXT DEFAULT '[]',
        images TEXT DEFAULT '[]', virtual_tour_url TEXT,
        open_home_dates TEXT DEFAULT '[]',
        agent_name TEXT, agent_phone TEXT, agent_email TEXT,
        listed_at TEXT DEFAULT (datetime('now')), created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT,
        title TEXT NOT NULL, description TEXT,
        status TEXT DEFAULT 'quoted',
        phase TEXT DEFAULT 'new',
        quote_id TEXT, invoice_id TEXT,
        scheduled_date TEXT, scheduled_time TEXT, completed_date TEXT,
        address TEXT, location_notes TEXT,
        labour_cost REAL DEFAULT 0, materials_cost REAL DEFAULT 0,
        total_cost REAL DEFAULT 0, deposit_pct INTEGER DEFAULT 0,
        deposit_paid INTEGER DEFAULT 0,
        notes TEXT, internal_notes TEXT,
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS job_materials (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL, user_id TEXT NOT NULL,
        name TEXT NOT NULL, quantity REAL DEFAULT 1, unit TEXT,
        unit_cost REAL DEFAULT 0, total_cost REAL DEFAULT 0,
        supplier TEXT, created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS job_photos (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL, user_id TEXT NOT NULL,
        url TEXT NOT NULL, type TEXT DEFAULT 'progress',
        caption TEXT, created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS job_milestones (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL, user_id TEXT NOT NULL,
        title TEXT NOT NULL, amount REAL DEFAULT 0,
        due_date TEXT, paid_at TEXT, status TEXT DEFAULT 'pending',
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS client_goals (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT NOT NULL,
        title TEXT NOT NULL, description TEXT,
        target_date TEXT, status TEXT DEFAULT 'active',
        progress_pct INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS goal_check_ins (
        id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, user_id TEXT NOT NULL,
        note TEXT, progress_pct INTEGER, created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS session_notes (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT NOT NULL,
        session_date TEXT NOT NULL, duration_minutes INTEGER DEFAULT 60,
        notes TEXT, homework TEXT, wins TEXT, challenges TEXT,
        next_session_plan TEXT, mood_score INTEGER,
        private_notes TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS class_schedules (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, service_id TEXT,
        staff_id TEXT, name TEXT NOT NULL, description TEXT,
        date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT,
        duration_minutes INTEGER DEFAULT 60,
        capacity INTEGER DEFAULT 20, enrolled INTEGER DEFAULT 0,
        price REAL DEFAULT 0, location TEXT, status TEXT DEFAULT 'scheduled',
        recurrence TEXT DEFAULT 'none',
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS class_enrollments (
        id TEXT PRIMARY KEY, class_id TEXT NOT NULL, user_id TEXT,
        contact_id TEXT, customer_name TEXT, customer_email TEXT,
        customer_phone TEXT, status TEXT DEFAULT 'enrolled',
        waitlisted INTEGER DEFAULT 0, paid INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(class_id, customer_email)
      );
    `);
  } catch(e) { console.error('[init] Failed to create webhook-critical tables:', e.message); }


  // ── Extended vertical tables ─────────────────────────────────────────────
  const extendedTables = [
    `CREATE TABLE IF NOT EXISTS vehicles (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT, make TEXT, model TEXT, year INTEGER, rego TEXT, vin TEXT, color TEXT, odometer INTEGER, fuel_type TEXT DEFAULT 'petrol', notes TEXT, created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS vehicle_services (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, vehicle_id TEXT NOT NULL, job_id TEXT, service_type TEXT NOT NULL, odometer_in INTEGER, odometer_out INTEGER, date TEXT, technician TEXT, notes TEXT, next_service_date TEXT, next_service_km INTEGER, created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS loan_applications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT, client_name TEXT, client_email TEXT, client_phone TEXT, loan_type TEXT DEFAULT 'home', status TEXT DEFAULT 'enquiry', loan_amount REAL, property_value REAL, deposit_pct REAL, lender TEXT, interest_rate REAL, loan_term INTEGER, settlement_date TEXT, broker_fee REAL, documents_checklist TEXT DEFAULT '[]', notes TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS children (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, parent_contact_id TEXT, child_name TEXT NOT NULL, date_of_birth TEXT, allergies TEXT, medical_notes TEXT, emergency_contact TEXT, emergency_phone TEXT, enrollment_start TEXT, enrollment_days TEXT DEFAULT '[]', room TEXT, status TEXT DEFAULT 'enrolled', created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS childcare_attendance (id TEXT PRIMARY KEY, child_id TEXT NOT NULL, user_id TEXT NOT NULL, date TEXT NOT NULL, sign_in TEXT, sign_out TEXT, signed_in_by TEXT, signed_out_by TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS practice_clients (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT, entity_name TEXT NOT NULL, entity_type TEXT DEFAULT 'individual', tax_file_number TEXT, abn TEXT, acn TEXT, fiscal_year_end TEXT DEFAULT '06-30', gst_registered INTEGER DEFAULT 0, services_json TEXT DEFAULT '[]', status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS tax_deadlines (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT, title TEXT NOT NULL, deadline_type TEXT, due_date TEXT NOT NULL, status TEXT DEFAULT 'pending', notes TEXT, created_at TEXT DEFAULT (datetime('now')))`,
  ];
  for (const sql of extendedTables) {
    try { db.exec(sql); } catch(e) {}
  }
  try { db.exec(`
    CREATE TABLE IF NOT EXISTS photography_galleries (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT, job_id TEXT,
      name TEXT NOT NULL, description TEXT,
      status TEXT DEFAULT 'draft',
      password TEXT, watermark INTEGER DEFAULT 1,
      watermark_text TEXT, expires_at TEXT,
      photos TEXT DEFAULT '[]', selected_photos TEXT DEFAULT '[]',
      client_viewed_at TEXT, client_selections_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS student_profiles (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT,
      name TEXT NOT NULL, email TEXT, phone TEXT,
      subject TEXT, level TEXT, dob TEXT,
      goals TEXT, notes TEXT, active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS student_progress (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, student_id TEXT NOT NULL,
      session_date TEXT NOT NULL, subject TEXT, topic TEXT,
      rating INTEGER DEFAULT 3, notes TEXT, homework TEXT,
      next_focus TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS term_enrolments (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, student_id TEXT NOT NULL,
      term_name TEXT NOT NULL, start_date TEXT, end_date TEXT,
      lessons_per_week INTEGER DEFAULT 1, lesson_duration INTEGER DEFAULT 60,
      rate_per_lesson REAL DEFAULT 0, total_lessons INTEGER DEFAULT 0,
      total_price REAL DEFAULT 0, status TEXT DEFAULT 'active',
      invoice_id TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS event_vendors (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, event_id TEXT,
      name TEXT NOT NULL, category TEXT, contact_name TEXT,
      email TEXT, phone TEXT, contract_status TEXT DEFAULT 'enquired',
      cost REAL DEFAULT 0, deposit_paid REAL DEFAULT 0,
      notes TEXT, confirmed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS event_timelines (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, event_id TEXT NOT NULL,
      time TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
      location TEXT, responsible TEXT, duration_minutes INTEGER DEFAULT 30,
      category TEXT DEFAULT 'general', completed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS support_retainers (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT NOT NULL,
      name TEXT NOT NULL, hours_per_month REAL DEFAULT 10,
      rate_per_hour REAL DEFAULT 0, monthly_price REAL DEFAULT 0,
      sla_response_hours INTEGER DEFAULT 24,
      sla_resolution_hours INTEGER DEFAULT 72,
      status TEXT DEFAULT 'active', billing_day INTEGER DEFAULT 1,
      hours_used_this_month REAL DEFAULT 0,
      started_at TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS vehicle_profiles (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT,
      rego TEXT NOT NULL, make TEXT, model TEXT, year INTEGER,
      color TEXT, vin TEXT, engine TEXT, odometer INTEGER,
      fuel_type TEXT DEFAULT 'petrol',
      wof_due TEXT, rego_due TEXT, service_due TEXT,
      service_interval_km INTEGER DEFAULT 10000,
      notes TEXT, active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS vehicle_service_history (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, vehicle_id TEXT NOT NULL,
      service_date TEXT NOT NULL, odometer INTEGER,
      description TEXT NOT NULL, parts_cost REAL DEFAULT 0,
      labour_cost REAL DEFAULT 0, total_cost REAL DEFAULT 0,
      technician TEXT, invoice_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS parts_inventory (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      part_number TEXT, name TEXT NOT NULL, description TEXT,
      category TEXT, supplier TEXT, supplier_code TEXT,
      cost_price REAL DEFAULT 0, sell_price REAL DEFAULT 0,
      markup_pct REAL DEFAULT 30, stock_qty INTEGER DEFAULT 0,
      min_stock INTEGER DEFAULT 0, location TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS child_profiles (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      parent_contact_id TEXT, name TEXT NOT NULL,
      dob TEXT, gender TEXT, room_group TEXT,
      allergies TEXT, medical_notes TEXT, dietary_notes TEXT,
      emergency_contact TEXT, emergency_phone TEXT,
      immunisation_status TEXT DEFAULT 'up-to-date',
      start_date TEXT, status TEXT DEFAULT 'enrolled',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS child_attendance (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, child_id TEXT NOT NULL,
      date TEXT NOT NULL, check_in TEXT, check_out TEXT,
      checked_in_by TEXT, checked_out_by TEXT,
      absent INTEGER DEFAULT 0, absent_reason TEXT,
      notes TEXT, created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(child_id, date)
    );
    CREATE TABLE IF NOT EXISTS mortgage_applications (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT NOT NULL,
      application_type TEXT DEFAULT 'purchase',
      status TEXT DEFAULT 'enquiry', stage TEXT DEFAULT 'initial',
      loan_amount REAL DEFAULT 0, property_value REAL DEFAULT 0,
      lender TEXT, product TEXT, interest_rate REAL,
      term_years INTEGER DEFAULT 30, settlement_date TEXT,
      compliance_checked INTEGER DEFAULT 0,
      privacy_consent INTEGER DEFAULT 0,
      notes TEXT, internal_notes TEXT,
      documents TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS floral_orders (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT,
      occasion TEXT, arrangement_type TEXT, size TEXT DEFAULT 'medium',
      flowers TEXT, colors TEXT, message TEXT,
      delivery_date TEXT, delivery_time TEXT,
      delivery_address TEXT, delivery_type TEXT DEFAULT 'delivery',
      price REAL DEFAULT 0, status TEXT DEFAULT 'received',
      florist_notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS occasion_reminders (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT NOT NULL,
      occasion TEXT NOT NULL, reminder_date TEXT NOT NULL,
      notes TEXT, sent INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `); } catch(e) { console.error('[init] extended vertical tables:', e.message); }

  try { db.exec(`
    CREATE TABLE IF NOT EXISTS pet_profiles (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, owner_id TEXT,
      name TEXT NOT NULL, species TEXT DEFAULT 'dog',
      breed TEXT, color TEXT, dob TEXT, weight_kg REAL,
      microchip TEXT, vet_name TEXT, vet_phone TEXT,
      medical_notes TEXT, allergies TEXT, behavioural_notes TEXT,
      last_service TEXT, next_service TEXT, active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS pet_appointments (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      pet_id TEXT NOT NULL, owner_email TEXT, owner_name TEXT,
      service TEXT NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL,
      duration_minutes INTEGER DEFAULT 60, price REAL DEFAULT 0,
      staff_id TEXT, notes TEXT, status TEXT DEFAULT 'confirmed',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, site_id TEXT,
      name TEXT NOT NULL, type TEXT DEFAULT 'room',
      description TEXT, max_guests INTEGER DEFAULT 2,
      beds TEXT DEFAULT '1 queen', price_per_night REAL DEFAULT 0,
      amenities TEXT DEFAULT '[]', images TEXT DEFAULT '[]',
      active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS room_bookings (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, room_id TEXT NOT NULL,
      guest_name TEXT NOT NULL, guest_email TEXT NOT NULL,
      guest_phone TEXT, check_in TEXT NOT NULL, check_out TEXT NOT NULL,
      nights INTEGER DEFAULT 1, guests INTEGER DEFAULT 1,
      total_price REAL DEFAULT 0, deposit_paid REAL DEFAULT 0,
      status TEXT DEFAULT 'confirmed', channel TEXT DEFAULT 'direct',
      notes TEXT, special_requests TEXT,
      checked_in_at TEXT, checked_out_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS room_blocking (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, room_id TEXT NOT NULL,
      start_date TEXT NOT NULL, end_date TEXT NOT NULL,
      reason TEXT DEFAULT 'maintenance', created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS cleaning_properties (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT,
      address TEXT NOT NULL, suburb TEXT, city TEXT,
      property_type TEXT DEFAULT 'house',
      bedrooms INTEGER DEFAULT 3, bathrooms INTEGER DEFAULT 2,
      access_notes TEXT, alarm_code TEXT, key_location TEXT,
      pets_on_premises TEXT, special_instructions TEXT,
      active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS cleaning_jobs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      property_id TEXT, staff_id TEXT, contact_id TEXT,
      title TEXT NOT NULL, type TEXT DEFAULT 'regular',
      scheduled_date TEXT, scheduled_time TEXT,
      duration_minutes INTEGER DEFAULT 120,
      price REAL DEFAULT 0, status TEXT DEFAULT 'scheduled',
      recurrence TEXT DEFAULT 'none', recurrence_interval INTEGER DEFAULT 1,
      checklist_completed TEXT DEFAULT '[]',
      notes TEXT, internal_notes TEXT, completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS cleaning_checklists (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      name TEXT NOT NULL, type TEXT DEFAULT 'regular',
      items TEXT DEFAULT '[]', created_at TEXT DEFAULT (datetime('now'))
    );
  `); } catch(e) { console.error('[init] vertical tables:', e.message); }


  try { db.exec(`
    CREATE TABLE IF NOT EXISTS photo_galleries (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT, name TEXT NOT NULL, event_date TEXT, event_type TEXT DEFAULT 'photography', status TEXT DEFAULT 'uploading', share_token TEXT UNIQUE, password TEXT, watermark_text TEXT, watermark_opacity REAL DEFAULT 0.3, expires_at TEXT, download_enabled INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS photo_gallery_images (id TEXT PRIMARY KEY, gallery_id TEXT NOT NULL, user_id TEXT NOT NULL, url TEXT NOT NULL, watermarked_url TEXT, caption TEXT, approved INTEGER DEFAULT 0, order_idx INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS lesson_terms (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, student_id TEXT NOT NULL, term_name TEXT NOT NULL, start_date TEXT, end_date TEXT, lessons_per_week INTEGER DEFAULT 1, lesson_duration INTEGER DEFAULT 60, fee_per_lesson REAL DEFAULT 0, total_fee REAL DEFAULT 0, paid INTEGER DEFAULT 0, invoice_id TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS student_progress_notes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, student_id TEXT NOT NULL, lesson_date TEXT NOT NULL, notes TEXT, pieces_working_on TEXT, achievements TEXT, next_goals TEXT, homework TEXT, mood INTEGER DEFAULT 3, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS venue_events (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, client_name TEXT, client_email TEXT, client_phone TEXT, event_type TEXT DEFAULT 'wedding', event_date TEXT, start_time TEXT, end_time TEXT, guest_count INTEGER, venue_space TEXT, total_value REAL DEFAULT 0, deposit_paid REAL DEFAULT 0, status TEXT DEFAULT 'enquiry', notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS vehicle_jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, vehicle_id TEXT, contact_id TEXT, title TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'booked', scheduled_date TEXT, odometer_in INTEGER, odometer_out INTEGER, labour_cost REAL DEFAULT 0, parts_cost REAL DEFAULT 0, total_cost REAL DEFAULT 0, invoice_id TEXT, wof_due TEXT, rego_due TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS vehicle_parts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, job_id TEXT, vehicle_id TEXT, name TEXT NOT NULL, part_number TEXT, supplier TEXT, cost_price REAL DEFAULT 0, sell_price REAL DEFAULT 0, quantity REAL DEFAULT 1, total_sell REAL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS attendance_log (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, child_id TEXT NOT NULL, date TEXT NOT NULL, check_in TEXT, check_out TEXT, present INTEGER DEFAULT 1, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS occasions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT NOT NULL, occasion_type TEXT NOT NULL, occasion_date TEXT NOT NULL, notes TEXT, reminder_sent INTEGER DEFAULT 0, last_purchase TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS document_checklist (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT DEFAULT 'requested', received_at TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS retainers (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT NOT NULL, name TEXT NOT NULL, hours_per_month REAL DEFAULT 10, monthly_fee REAL DEFAULT 0, used_hours REAL DEFAULT 0, status TEXT DEFAULT 'active', start_date TEXT, billing_day INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS sla_rules (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, priority TEXT NOT NULL, response_minutes INTEGER DEFAULT 60, resolution_hours INTEGER DEFAULT 8, created_at TEXT DEFAULT (datetime('now')));
  `); } catch(e) { console.error("[init] extended tables 2:", e.message); }

  try { db.exec(`
    CREATE TABLE IF NOT EXISTS client_proof_galleries (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT,
      title TEXT NOT NULL, job_type TEXT DEFAULT 'photography',
      delivery_date TEXT, status TEXT DEFAULT 'proofing',
      password TEXT, watermark_text TEXT,
      images TEXT DEFAULT '[]',
      client_selections TEXT DEFAULT '[]',
      notes TEXT, download_url TEXT,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS broker_documents (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT NOT NULL,
      deal_id TEXT, title TEXT NOT NULL,
      doc_type TEXT DEFAULT 'general',
      status TEXT DEFAULT 'requested',
      file_url TEXT, file_name TEXT,
      notes TEXT, requested_at TEXT, received_at TEXT,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS delivery_schedules (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      order_id TEXT, contact_id TEXT,
      recipient_name TEXT, recipient_address TEXT,
      recipient_phone TEXT, delivery_date TEXT NOT NULL,
      delivery_time TEXT, status TEXT DEFAULT 'scheduled',
      driver_notes TEXT, occasion TEXT,
      card_message TEXT, price REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    -- Duplicate occasion_reminders definition removed
  `); } catch(e) { console.error('[init] industry tables 2:', e.message); }

  try { db.exec(`
    CREATE TABLE IF NOT EXISTS shoots (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT,
      title TEXT NOT NULL, type TEXT DEFAULT 'portrait',
      shoot_date TEXT, shoot_time TEXT, location TEXT,
      package_name TEXT, package_price REAL DEFAULT 0,
      deposit_paid REAL DEFAULT 0, deposit_pct INTEGER DEFAULT 30,
      status TEXT DEFAULT 'enquiry', delivery_deadline TEXT,
      notes TEXT, contract_signed INTEGER DEFAULT 0,
      contract_url TEXT, gallery_url TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS shoot_galleries (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, shoot_id TEXT NOT NULL,
      title TEXT, share_token TEXT UNIQUE, watermark INTEGER DEFAULT 1,
      status TEXT DEFAULT 'pending', client_selections TEXT DEFAULT '[]',
      images TEXT DEFAULT '[]', expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS lesson_schedules (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, student_id TEXT NOT NULL,
      day_of_week INTEGER, time TEXT, duration_minutes INTEGER DEFAULT 60,
      subject TEXT, rate_per_lesson REAL DEFAULT 0,
      term_id TEXT, active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS term_invoices (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, student_id TEXT NOT NULL,
      term_name TEXT NOT NULL, start_date TEXT, end_date TEXT,
      lessons_count INTEGER DEFAULT 0, rate_per_lesson REAL DEFAULT 0,
      total REAL DEFAULT 0, invoice_id TEXT, status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS venue_bookings (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT,
      event_name TEXT NOT NULL, event_type TEXT DEFAULT 'wedding',
      event_date TEXT NOT NULL, start_time TEXT, end_time TEXT,
      guest_count INTEGER DEFAULT 0, package_name TEXT,
      total_price REAL DEFAULT 0, deposit_paid REAL DEFAULT 0,
      status TEXT DEFAULT 'enquiry', notes TEXT,
      catering_required INTEGER DEFAULT 0, av_required INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS event_runsheets (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, venue_booking_id TEXT NOT NULL,
      time TEXT NOT NULL, duration_minutes INTEGER DEFAULT 30,
      description TEXT NOT NULL, responsible_party TEXT,
      notes TEXT, completed INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sla_configs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      priority TEXT NOT NULL, response_hours INTEGER DEFAULT 4,
      resolution_hours INTEGER DEFAULT 24,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, priority)
    );
    CREATE TABLE IF NOT EXISTS child_notes (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, child_id TEXT NOT NULL,
      date TEXT NOT NULL, note TEXT NOT NULL, type TEXT DEFAULT 'general',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS loan_files (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT,
      client_name TEXT NOT NULL, client_email TEXT, client_phone TEXT,
      loan_type TEXT DEFAULT 'home', loan_amount REAL DEFAULT 0,
      lender TEXT, interest_rate REAL, loan_term_years INTEGER,
      status TEXT DEFAULT 'initial_enquiry', referral_source TEXT,
      notes TEXT, compliance_notes TEXT, next_action TEXT,
      next_action_date TEXT, settled_date TEXT,
      commission_est REAL DEFAULT 0, commission_received REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS loan_documents (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, loan_id TEXT NOT NULL,
      document_type TEXT NOT NULL, status TEXT DEFAULT 'required',
      received_at TEXT, notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS referral_sources (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
      type TEXT DEFAULT 'agent', email TEXT, phone TEXT,
      total_referrals INTEGER DEFAULT 0, active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS delivery_orders (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, contact_id TEXT,
      recipient_name TEXT NOT NULL, recipient_phone TEXT,
      delivery_address TEXT NOT NULL, delivery_date TEXT NOT NULL,
      delivery_time TEXT, occasion TEXT,
      items TEXT DEFAULT '[]', total_price REAL DEFAULT 0,
      status TEXT DEFAULT 'pending', driver_notes TEXT,
      card_message TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
    -- Duplicate occasion_reminders definition removed
  `); } catch(e) { console.error('[init] industry tables 2:', e.message); }

  try { db.exec(`
    CREATE TABLE IF NOT EXISTS site_analytics (
      id TEXT PRIMARY KEY, site_id TEXT NOT NULL, user_id TEXT NOT NULL,
      date TEXT NOT NULL, path TEXT DEFAULT '/', count INTEGER DEFAULT 1,
      country TEXT, referrer TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS mine_control_customer_sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, customer_number TEXT NOT NULL,
      customer_name TEXT, context TEXT DEFAULT '[]',
      last_message TEXT, last_seen TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now'))
    );
  `); } catch(e) { console.error('[init] analytics/session tables:', e.message); }

  try { db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pet_appts_user ON pet_appointments(user_id);
    CREATE INDEX IF NOT EXISTS idx_vehicle_svcs_vehicle ON vehicle_services(vehicle_id);
    CREATE INDEX IF NOT EXISTS idx_child_att_child ON child_attendance(child_id);
    CREATE INDEX IF NOT EXISTS idx_child_att_date ON child_attendance(date);
    CREATE INDEX IF NOT EXISTS idx_deliveries_date ON delivery_schedules(user_id, delivery_date);
    CREATE INDEX IF NOT EXISTS idx_broker_docs_contact ON broker_documents(user_id, contact_id);
    CREATE INDEX IF NOT EXISTS idx_retainers_user ON support_retainers(user_id);
    CREATE INDEX IF NOT EXISTS idx_galleries_user ON client_proof_galleries(user_id);
    CREATE INDEX IF NOT EXISTS idx_vehicle_profiles_user ON vehicle_profiles(user_id);
    CREATE INDEX IF NOT EXISTS idx_cleaning_jobs_user ON cleaning_jobs(user_id);
    CREATE INDEX IF NOT EXISTS idx_occasion_reminders_user ON occasion_reminders(user_id);
    CREATE INDEX IF NOT EXISTS idx_site_analytics_site ON site_analytics(site_id, date);
    CREATE INDEX IF NOT EXISTS idx_mc_sessions_number ON mine_control_customer_sessions(user_id, customer_number);
  `); } catch(e) { console.error('[init] new indexes:', e.message); }

  try { db.exec(`
    CREATE TABLE IF NOT EXISTS booking_types (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
      price REAL DEFAULT 0, duration INTEGER DEFAULT 60, description TEXT,
      active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS mine_affiliates (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, affiliate_code TEXT UNIQUE,
      affiliate_name TEXT, affiliate_email TEXT,
      commission_pct REAL DEFAULT 20, total_referrals INTEGER DEFAULT 0,
      total_earnings REAL DEFAULT 0, status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now'))
    );
    -- Duplicate mine_affiliate_conversions definition removed
    CREATE TABLE IF NOT EXISTS crypto_orders (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, amount REAL NOT NULL,
      currency TEXT DEFAULT 'USDC', platform_fee REAL DEFAULT 0,
      net_amount REAL DEFAULT 0, status TEXT DEFAULT 'pending',
      tx_hash TEXT, wallet_address TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `); } catch(e) { console.error('[init] affiliate/crypto/booking tables:', e.message); }

  try {
    const db = getDb();
    try { db.exec("ALTER TABLE business_milestones ADD COLUMN celebrated TEXT"); } catch(e) {}
    try { db.exec("ALTER TABLE sites ADD COLUMN show_mine_badge INTEGER DEFAULT 1"); } catch(e) {}
    try { db.exec("ALTER TABLE cleaning_jobs ADD COLUMN staff_ids TEXT DEFAULT '[]'"); } catch(e) {}
    try { db.exec("ALTER TABLE bookings ADD COLUMN deposit_requested INTEGER DEFAULT 0"); } catch(e) {}
    try { db.exec("ALTER TABLE bookings ADD COLUMN deposit_session_id TEXT"); } catch(e) {}
    try { db.exec("ALTER TABLE bookings ADD COLUMN deposit_paid INTEGER DEFAULT 0"); } catch(e) {}
  } catch(e) {}

  try { const db=getDb(); try{db.exec("ALTER TABLE sites ADD COLUMN sections_json TEXT");}catch(e){} } catch(e) {}

  const migrations = [
    "ALTER TABLE bookings ADD COLUMN staff_id TEXT",
    "ALTER TABLE contacts ADD COLUMN pet_ids TEXT",
    "ALTER TABLE jobs ADD COLUMN property_id TEXT",
    "ALTER TABLE bookings ADD COLUMN staff_name TEXT",
    "ALTER TABLE bookings ADD COLUMN service_id TEXT",
    "ALTER TABLE invoices ADD COLUMN job_id TEXT",
    "ALTER TABLE invoices ADD COLUMN time_entry_ids TEXT",
    "ALTER TABLE deals ADD COLUMN job_id TEXT",
    "ALTER TABLE deals ADD COLUMN phase TEXT DEFAULT 'new'",
    "ALTER TABLE contacts ADD COLUMN industry TEXT",
    "ALTER TABLE contacts ADD COLUMN property_interest TEXT",
    "ALTER TABLE users ADD COLUMN stripe_connect_id TEXT",
    "ALTER TABLE users ADD COLUMN origin TEXT",
    "ALTER TABLE users ADD COLUMN last_login TEXT",
    "ALTER TABLE users ADD COLUMN avatar TEXT",
    "ALTER TABLE users ADD COLUMN avatar_url TEXT",
    "ALTER TABLE users ADD COLUMN bio TEXT",
    "ALTER TABLE users ADD COLUMN phone TEXT",
    "ALTER TABLE users ADD COLUMN timezone TEXT",
    "ALTER TABLE notifications ADD COLUMN text TEXT",
    "ALTER TABLE orders ADD COLUMN shipping_name TEXT",
    "ALTER TABLE orders ADD COLUMN stripe_session_id TEXT",
    "ALTER TABLE abandoned_carts ADD COLUMN session_id TEXT",
    "ALTER TABLE abandoned_carts ADD COLUMN customer_email TEXT",
    "ALTER TABLE abandoned_carts ADD COLUMN customer_name TEXT",
    "ALTER TABLE abandoned_carts ADD COLUMN cart_url TEXT",
    "ALTER TABLE abandoned_carts ADD COLUMN recovery_email_sent INTEGER DEFAULT 0",
    "ALTER TABLE sites ADD COLUMN logo_url TEXT",
    "ALTER TABLE sites ADD COLUMN primary_color TEXT",
    "ALTER TABLE sites ADD COLUMN secondary_color TEXT",
    "ALTER TABLE sites ADD COLUMN cat_id TEXT",
    "ALTER TABLE sites ADD COLUMN deploy_url TEXT",
    "ALTER TABLE sites ADD COLUMN deploy_method TEXT",
    "ALTER TABLE sites ADD COLUMN deployed_at TEXT",
    "ALTER TABLE sites ADD COLUMN site_meta TEXT DEFAULT '{}'",
    "ALTER TABLE bookings ADD COLUMN customer_phone TEXT",
    "ALTER TABLE bookings ADD COLUMN service TEXT",
    "ALTER TABLE bookings ADD COLUMN location TEXT",
    "ALTER TABLE bookings ADD COLUMN price REAL DEFAULT 0",
    "ALTER TABLE bookings ADD COLUMN price_paid REAL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN outreach_credits REAL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN commission_paid REAL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN google_id TEXT",
    "ALTER TABLE users ADD COLUMN apple_id TEXT",
    "ALTER TABLE bookings ADD COLUMN stripe_payment_intent TEXT",
    "ALTER TABLE invoices ADD COLUMN site_id TEXT",
    // Proposals: add columns missing from initial schema
    "ALTER TABLE proposals ADD COLUMN html TEXT",
    "ALTER TABLE proposals ADD COLUMN pdf_url TEXT",
    "ALTER TABLE proposals ADD COLUMN opened_at TEXT",
    "ALTER TABLE proposals ADD COLUMN signed_at TEXT",
    "ALTER TABLE proposals ADD COLUMN services TEXT",
    "ALTER TABLE proposals ADD COLUMN follow_up_count INTEGER DEFAULT 0",
    "ALTER TABLE proposals ADD COLUMN signer_name TEXT",
    "ALTER TABLE proposals ADD COLUMN signature_data TEXT",
    "ALTER TABLE portal_clients ADD COLUMN token_expires TEXT",
    "ALTER TABLE portal_clients ADD COLUMN site_id TEXT",
    "ALTER TABLE portal_clients ADD COLUMN user_id TEXT",
    // Contracts: add columns missing from initial schema
    "ALTER TABLE contracts ADD COLUMN sent_at TEXT",
    "ALTER TABLE contracts ADD COLUMN viewed_at TEXT",
    "ALTER TABLE contracts ADD COLUMN signature_data TEXT",
    "ALTER TABLE contracts ADD COLUMN signer_ip TEXT",
    "ALTER TABLE contracts ADD COLUMN currency TEXT DEFAULT 'USD'",
    "ALTER TABLE contracts ADD COLUMN expires_at TEXT",
    "ALTER TABLE contracts ADD COLUMN signer_name TEXT",
    "ALTER TABLE contracts ADD COLUMN signed_ip TEXT",
    // Sites SEO columns — kept here so all migrations are in one place
    "ALTER TABLE sites ADD COLUMN seo_title TEXT",
    "ALTER TABLE sites ADD COLUMN seo_description TEXT",
    "ALTER TABLE sites ADD COLUMN seo_keywords TEXT",
    "ALTER TABLE contacts ADD COLUMN last_contacted TEXT",
  "ALTER TABLE contacts ADD COLUMN lead_score INTEGER DEFAULT 0",
  "ALTER TABLE contacts ADD COLUMN lead_grade TEXT DEFAULT 'F'",
  "ALTER TABLE users ADD COLUMN account_status TEXT DEFAULT 'active'",
  "ALTER TABLE users ADD COLUMN grace_period_since TEXT",
  "ALTER TABLE users ADD COLUMN deletion_scheduled_at TEXT",
  "ALTER TABLE membership_enrollments ADD COLUMN stripe_subscription_id TEXT",
  "ALTER TABLE membership_enrollments ADD COLUMN stripe_customer_id TEXT",
  "ALTER TABLE product_sub_subscribers ADD COLUMN dunning_attempt INTEGER DEFAULT 0",
  "ALTER TABLE product_sub_subscribers ADD COLUMN dunning_paused_at TEXT",
  "ALTER TABLE reviews ADD COLUMN owner_reply TEXT",
  "ALTER TABLE reviews ADD COLUMN owner_reply_at TEXT",
  // SMS alphanumeric sender name per user (max 11 chars, letters/numbers only)
  "ALTER TABLE users ADD COLUMN sms_sender_name TEXT",
  // Per-user sender email for cold email agent
  "ALTER TABLE users ADD COLUMN sender_email TEXT",
  // Batch job tracking for Claude Batch API
  "ALTER TABLE prospector_campaigns ADD COLUMN batch_id TEXT",
  "ALTER TABLE cold_email_campaigns ADD COLUMN batch_id TEXT",
];
  // ── Time entries table (time tracking feature) ──
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS time_entries (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      contact_id TEXT,
      client_name TEXT,
      description TEXT NOT NULL,
      date TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL DEFAULT 0,
      hourly_rate REAL NOT NULL DEFAULT 0,
      billable INTEGER NOT NULL DEFAULT 1,
      invoiced INTEGER NOT NULL DEFAULT 0,
      invoice_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_time_entries_user ON time_entries(user_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_time_entries_invoiced ON time_entries(user_id, invoiced)`);
  } catch(e) { /* already exists */ }
  // ── Roadmap / Feedback Board ──
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS roadmap_items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'planned',
      priority TEXT NOT NULL DEFAULT 'medium',
      category TEXT DEFAULT 'feature',
      eta TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_roadmap_user ON roadmap_items(user_id, status)`);
  } catch(e) { /* already exists */ }

  for (const sql of migrations) {
    try { db.exec(sql); } catch (e) { /* column already exists — ignore */ }
  }

  // ── DATA FLYWHEEL — Intelligence Engine ──────────────────────────────────
  // business_events: every meaningful action logged with business context
  db.exec(`
    CREATE TABLE IF NOT EXISTS business_events (
      id               TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL,
      event_type       TEXT NOT NULL,
      plan             TEXT,
      industry         TEXT,
      days_since_join  INTEGER DEFAULT 0,
      metadata_json    TEXT DEFAULT '{}',
      created_at       TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_biz_events_user    ON business_events(user_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_biz_events_type    ON business_events(event_type, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_biz_events_industry ON business_events(industry, created_at)`);

  // business_milestones: key achievement timestamps per user
  db.exec(`
    CREATE TABLE IF NOT EXISTS business_milestones (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      milestone_key   TEXT NOT NULL,
      milestone_label TEXT NOT NULL,
      achieved_at     TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, milestone_key),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_milestones_user ON business_milestones(user_id)`);

  // cohort_benchmarks: anonymised aggregated stats per industry, updated nightly
  db.exec(`
    CREATE TABLE IF NOT EXISTS cohort_benchmarks (
      id                          TEXT PRIMARY KEY,
      industry                    TEXT NOT NULL,
      period                      TEXT NOT NULL,
      business_count              INTEGER DEFAULT 0,
      avg_revenue                 REAL DEFAULT 0,
      p25_revenue                 REAL DEFAULT 0,
      p75_revenue                 REAL DEFAULT 0,
      avg_bookings                REAL DEFAULT 0,
      avg_new_contacts            REAL DEFAULT 0,
      top_performer_actions_json  TEXT DEFAULT '{}',
      updated_at                  TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_benchmarks_industry ON cohort_benchmarks(industry, updated_at)`);

  // intelligence_briefings: generated AI briefings per user per day
  db.exec(`
    CREATE TABLE IF NOT EXISTS intelligence_briefings (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      period          TEXT NOT NULL,
      briefing_json   TEXT NOT NULL,
      context_json    TEXT DEFAULT '{}',
      delivered_email INTEGER DEFAULT 0,
      delivered_push  INTEGER DEFAULT 0,
      delivered_at    TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, period),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_briefings_user   ON intelligence_briefings(user_id, period)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_briefings_deliver ON intelligence_briefings(delivered_email, period)`);

  // ── Additional performance indices ────────────────────────────────────────
  db.exec("CREATE INDEX IF NOT EXISTS idx_campaigns_campaign_id ON email_campaigns(campaign_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_milestones_key ON business_milestones(key)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_job_id ON jobs(job_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_event_attendees_event_id ON event_attendees(event_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id)");

  // ── Missing indexes for hot query paths ──────────────────────────────────
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_proposals_user     ON proposals(user_id);
      CREATE INDEX IF NOT EXISTS idx_blog_posts_user    ON blog_posts(user_id);
      CREATE INDEX IF NOT EXISTS idx_funnels_user       ON funnels(user_id);
      CREATE INDEX IF NOT EXISTS idx_staff_user         ON staff_profiles(user_id);
      CREATE INDEX IF NOT EXISTS idx_memberships_user   ON memberships(user_id);
      CREATE INDEX IF NOT EXISTS idx_leads_user         ON leads(user_id);
      CREATE INDEX IF NOT EXISTS idx_reviews_user       ON reviews(user_id, site_id);
      CREATE INDEX IF NOT EXISTS idx_automations_user   ON automations(user_id);
      CREATE INDEX IF NOT EXISTS idx_outreach_camp_user ON outreach_campaigns(user_id);
      CREATE INDEX IF NOT EXISTS idx_appointments_user  ON appointments(user_id);
    `);
  } catch(e) { /* tables may not exist yet — created on first use */ }

    // ── High-priority route-level table indexes ─────────────────────────
  try {
    db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sms_sequences_user ON sms_sequences(user_id);
  CREATE INDEX IF NOT EXISTS idx_sms_conversations_user ON sms_conversations(user_id);
  CREATE INDEX IF NOT EXISTS idx_sms_messages_user ON sms_messages(user_id);
  CREATE INDEX IF NOT EXISTS idx_sms_broadcasts_user ON sms_broadcasts(user_id);
  CREATE INDEX IF NOT EXISTS idx_outreach_campaigns_user ON outreach_campaigns(user_id);
  CREATE INDEX IF NOT EXISTS idx_outreach_lists_user ON outreach_lists(user_id);
  CREATE INDEX IF NOT EXISTS idx_automations_user ON automations(user_id);
  CREATE INDEX IF NOT EXISTS idx_contracts_user ON contracts(user_id);
  CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id);
  CREATE INDEX IF NOT EXISTS idx_chatbot_config_user ON chatbot_config(user_id);
  CREATE INDEX IF NOT EXISTS idx_kb_articles_user ON kb_articles(user_id);
  CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);
  CREATE INDEX IF NOT EXISTS idx_email_funnels_user ON email_funnels(user_id);
  CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id);
  CREATE INDEX IF NOT EXISTS idx_ai_employees_user ON ai_employees(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_social_tokens_user ON user_social_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_mine_control_config_user ON mine_control_config(user_id);
  CREATE INDEX IF NOT EXISTS idx_mine_control_messages_user ON mine_control_messages(user_id);
  CREATE INDEX IF NOT EXISTS idx_growth_agent_config_user ON growth_agent_config(user_id);
  CREATE INDEX IF NOT EXISTS idx_overage_charges_user ON overage_charges(user_id);
  CREATE INDEX IF NOT EXISTS idx_sms_messages_conv ON sms_messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_outreach_camp_status ON outreach_campaigns(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_bookings_site ON bookings(site_id, user_id);
  CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_kb_articles_site ON kb_articles(site_id);
  CREATE INDEX IF NOT EXISTS idx_email_tracking_camp ON email_tracking(campaign_id);
  CREATE INDEX IF NOT EXISTS idx_overage_charges_period ON overage_charges(user_id, period, status);
    `);
  } catch(e) { /* tables may not exist yet */ }


  // ── Auto-promote ADMIN_EMAIL user to admin role on startup ──
  if (process.env.ADMIN_EMAIL) {
    try {
      const adminUser = db.prepare("SELECT id, role FROM users WHERE LOWER(email) = LOWER(?)").get(process.env.ADMIN_EMAIL.trim());
      if (adminUser && adminUser.role !== "admin") {
        db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminUser.id);
      }
    } catch (e) { /* Users table may not exist yet on first run */ }
  }

  // ── VERTICALS 4 TABLES ────────────────────────────────────────────────────
  db.prepare(`CREATE TABLE IF NOT EXISTS vehicle_job_parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, service_id INTEGER,
    part_name TEXT, part_number TEXT, qty REAL DEFAULT 1,
    unit_cost REAL DEFAULT 0, supplier TEXT,
    created_at DATETIME DEFAULT (datetime('now'))
  )`).run();

  // Duplicate sla_rules definition removed
  

  // Duplicate retainers definition removed
  

  db.prepare(`CREATE TABLE IF NOT EXISTS retainer_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, retainer_id INTEGER,
    hours REAL DEFAULT 0, description TEXT, date TEXT,
    created_at DATETIME DEFAULT (datetime('now'))
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS doc_checklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, contact_id INTEGER,
    doc_name TEXT, required INTEGER DEFAULT 1, status TEXT DEFAULT 'pending',
    notes TEXT, updated_at DATETIME DEFAULT (datetime('now')),
    created_at DATETIME DEFAULT (datetime('now'))
  )`).run();

  // Duplicate referrals definition removed
  

  db.prepare(`CREATE TABLE IF NOT EXISTS student_lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, student_id INTEGER,
    term_id INTEGER, lesson_date TEXT, lesson_time TEXT DEFAULT '09:00',
    status TEXT DEFAULT 'scheduled', notes TEXT,
    created_at DATETIME DEFAULT (datetime('now'))
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS venue_blocked_dates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER,
    block_date TEXT, reason TEXT,
    created_at DATETIME DEFAULT (datetime('now'))
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS childcare_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, child_id INTEGER,
    parent_email TEXT, subject TEXT, message TEXT,
    created_at DATETIME DEFAULT (datetime('now'))
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS floral_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER,
    name TEXT, description TEXT, variants TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT (datetime('now'))
  )`).run();


  // ── Change 10: defensive columns for read-side filters (queries that filtered on a
  //    non-existent column would throw; adding the column makes them return empty instead).
  db.exec("ALTER TABLE affiliate_conversions ADD COLUMN affiliate_user_id TEXT");
  db.exec("ALTER TABLE agencies ADD COLUMN owner_user_id TEXT");
  db.exec("ALTER TABLE agency_clients ADD COLUMN agency_user_id TEXT");
  db.exec("ALTER TABLE bookings ADD COLUMN client_email TEXT");
  db.exec("ALTER TABLE cold_email_replies ADD COLUMN handled INTEGER DEFAULT 0");
  db.exec("ALTER TABLE contacts ADD COLUMN score REAL");
  db.exec("ALTER TABLE drm_download_log ADD COLUMN created_at TEXT");
  db.exec("ALTER TABLE drm_download_log ADD COLUMN user_id TEXT");
  db.exec("ALTER TABLE email_sends ADD COLUMN sent_at TEXT");
  db.exec("ALTER TABLE email_sends ADD COLUMN to_email TEXT");
  db.exec("ALTER TABLE email_tracking ADD COLUMN to_email TEXT");
  db.exec("ALTER TABLE mine_retainers ADD COLUMN owner_user_id TEXT");
  db.exec("ALTER TABLE oauth_tokens ADD COLUMN platform TEXT");
  db.exec("ALTER TABLE orders ADD COLUMN discount_amount REAL DEFAULT 0");
  db.exec("ALTER TABLE orders ADD COLUMN stripe_charge_id TEXT");
  db.exec("ALTER TABLE orders ADD COLUMN stripe_payment_intent TEXT");
  db.exec("ALTER TABLE prospector_campaigns ADD COLUMN demo_slug TEXT");
  db.exec("ALTER TABLE reviews ADD COLUMN reply TEXT");
  db.exec("ALTER TABLE sites ADD COLUMN seo_indexed INTEGER DEFAULT 0");
  db.exec("ALTER TABLE social_posts ADD COLUMN likes INTEGER DEFAULT 0");
  db.exec("ALTER TABLE users ADD COLUMN owner_id TEXT");
  db.exec("ALTER TABLE videos ADD COLUMN owner_user_id TEXT");
  // ── July 2026 schema-drift migrations (Change 9): columns used by INSERTs but absent from CREATEs.
  //    db.exec here is error-swallowing (see line ~26), so re-running on an already-migrated DB is a no-op.
  db.exec("ALTER TABLE referrals ADD COLUMN commission_paid INTEGER DEFAULT 0");
  db.exec("ALTER TABLE retainers ADD COLUMN hours_used REAL DEFAULT 0");
  db.exec("ALTER TABLE users ADD COLUMN ai_edits_used INTEGER DEFAULT 0");
  db.exec("ALTER TABLE users ADD COLUMN brand_font TEXT");
  db.exec("ALTER TABLE users ADD COLUMN brand_primary_color TEXT");
  db.exec("ALTER TABLE users ADD COLUMN stripe_account_id TEXT");
  db.exec("ALTER TABLE users ADD COLUMN white_label_config TEXT");
  db.exec("ALTER TABLE users ADD COLUMN ai_edits_limit INTEGER");  // Change 16: per-user edits override read by site-templates
  db.exec("ALTER TABLE audit_log ADD COLUMN event TEXT");
  db.exec("ALTER TABLE audit_log ADD COLUMN meta TEXT");
  db.exec("ALTER TABLE coupons ADD COLUMN uses_remaining INTEGER");
  db.exec("ALTER TABLE loan_applications ADD COLUMN amount REAL");
  db.exec("ALTER TABLE loan_applications ADD COLUMN rate REAL");
  db.exec("ALTER TABLE referrals ADD COLUMN client_id TEXT");
  db.exec("ALTER TABLE referrals ADD COLUMN deal_value REAL");
  db.exec("ALTER TABLE referrals ADD COLUMN notes TEXT");
  db.exec("ALTER TABLE referrals ADD COLUMN source TEXT");
  db.exec("ALTER TABLE referrals ADD COLUMN user_id TEXT");
  db.exec("ALTER TABLE retainers ADD COLUMN hours_included REAL");
  db.exec("ALTER TABLE retainers ADD COLUMN notes TEXT");
  db.exec("ALTER TABLE sites ADD COLUMN data TEXT");
  db.exec("ALTER TABLE sla_rules ADD COLUMN name TEXT");
  db.exec("ALTER TABLE sla_rules ADD COLUMN response_hours REAL");
  db.exec("ALTER TABLE student_profiles ADD COLUMN started_date TEXT");

  return db;

  // ───── SEO Agent tables ─────
  try { db.exec(`-- Append these CREATE TABLE statements to backend/db/init.js inside the schema string.
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
`); } catch(e) { console.error('[init] seo-agent tables:', e.message); }
}
function getDb() { if (!db) throw new Error("Call init() first"); return db; }

// Shared getSetting helper — reads from platform_settings table
// Exported so all routes can use the same implementation consistently
function getSetting(key) {
  try {
    const row = getDb().prepare("SELECT value FROM platform_settings WHERE key = ?").get(key);
    return row?.value || process.env[key] || null;
  } catch (e) {
    return process.env[key] || null;
  }
}



  // Migration: add followup_sent to voice_sessions for existing DBs (idempotent)
  try { db.exec("ALTER TABLE voice_sessions ADD COLUMN followup_sent TEXT"); } catch(e) { /* column already exists */ }

module.exports = { init, getDb, getSetting };
