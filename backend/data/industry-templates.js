/**
 * industry-templates.js — Industry-specific configurations for MINE.
 *
 * Each industry comes with:
 *   - recommended_agents: AI Employees pre-tuned for this vertical
 *   - kpis: industry-specific dashboard KPIs to track
 *   - automations: pre-built automation templates
 *   - compliance: regulatory defaults (HIPAA, PCI, GDPR, etc.)
 *   - site_template: default site structure
 *   - tone: brand voice defaults
 *
 * Used by:
 *   - Onboarding wizard (user picks industry on signup)
 *   - AI Employee setup (industry-aware system prompts)
 *   - Site builder (industry-aware default content)
 *   - Compliance defaults (auto-enables right safeguards)
 */

const INDUSTRY_TEMPLATES = {

  // ─── HEALTH & WELLNESS ────────────────────────────────────────────
  yoga_studio: {
    name: "Yoga / Pilates studio",
    icon: "🧘",
    category: "health-wellness",
    recommended_agents: {
      receptionist:   { priority: 1, custom_prompt: "You schedule yoga classes, answer questions about styles (Vinyasa, Hatha, Yin), recommend appropriate levels, and handle membership inquiries warmly." },
      socialmanager:  { priority: 2, voice: "calm, inclusive, wellness-focused — never aggressive marketing language" },
      community:      { priority: 3, custom_prompt: "Reply to reviews and comments with gratitude, share class highlights, never use sales-y language." },
      bookkeeper:     { priority: 4 },
    },
    kpis: ["weekly attendance", "membership churn", "class fill rate", "drop-in conversion", "instructor utilization"],
    automations: [
      "new_member_welcome_series",
      "missed_class_followup",
      "subscription_renewal_reminder",
      "instructor_substitute_alert",
      "milestone_celebration_50_classes",
    ],
    compliance: ["liability_waiver_required", "injury_log_recommended"],
    site_template: { hero_style: "calm-imagery", default_sections: ["classes", "schedule", "instructors", "memberships", "first-class-free", "testimonials"] },
    tone: { keywords: ["mindful", "balanced", "welcoming", "transformative"], avoid: ["bootcamp", "shredded", "intense"] },
  },

  dental_clinic: {
    name: "Dental clinic",
    icon: "🦷",
    category: "health-wellness",
    recommended_agents: {
      receptionist:   { priority: 1, custom_prompt: "You book dental appointments, answer insurance questions carefully (never guarantee coverage — direct to billing dept), handle emergencies by routing to on-call number." },
      customersuccess:{ priority: 2 },
      bookkeeper:     { priority: 3 },
    },
    kpis: ["appointment fill rate", "no-show rate", "treatment plan acceptance", "insurance claim approval", "patient retention"],
    automations: ["recall_6month_cleaning", "treatment_plan_followup", "no_show_recovery", "birthday_card", "insurance_renewal_reminder"],
    compliance: ["hipaa_required", "phi_redaction_enabled", "secure_messaging_only", "encrypted_storage_required"],
    site_template: { hero_style: "professional-trust", default_sections: ["services", "team", "insurance-accepted", "new-patient-form", "emergency-info", "reviews"] },
    tone: { keywords: ["professional", "reassuring", "evidence-based"], avoid: ["cheap", "deals", "limited-time"] },
  },

  therapist_counselor: {
    name: "Therapist / counselor",
    icon: "💚",
    category: "health-wellness",
    recommended_agents: {
      receptionist:   { priority: 1, custom_prompt: "You help with scheduling but NEVER provide therapy advice. If a client is in crisis, immediately direct them to 988 (US) or local emergency services. Maintain confidentiality strictly." },
      bookkeeper:     { priority: 2 },
    },
    kpis: ["weekly session count", "no-show rate", "client retention", "intake-to-first-session", "referral source"],
    automations: ["intake_form_send", "session_reminder_24h", "post_session_resources", "anniversary_check_in"],
    compliance: ["hipaa_required", "confidentiality_strict", "no_marketing_to_clients_without_consent", "session_notes_encrypted"],
    site_template: { hero_style: "calm-professional", default_sections: ["approach", "services", "rates-insurance", "good-fit", "contact-confidential"] },
    tone: { keywords: ["compassionate", "evidence-based", "judgment-free"], avoid: ["fix", "cure", "guaranteed"] },
  },

  // ─── FITNESS & SPORTS ─────────────────────────────────────────────
  gym_personal_trainer: {
    name: "Gym / personal trainer",
    icon: "💪",
    category: "fitness-sports",
    recommended_agents: {
      socialmanager:  { priority: 1, voice: "energetic, motivating, transformation-focused" },
      salesrep:       { priority: 2 },
      community:      { priority: 3 },
    },
    kpis: ["new memberships", "PT session bookings", "trial-to-member conversion", "retention >6 months", "referral rate"],
    automations: ["trial_followup", "expired_membership_winback", "milestone_celebration", "12week_progress_check"],
    compliance: ["health_questionnaire_required", "liability_waiver_required"],
    site_template: { hero_style: "high-energy", default_sections: ["transformations", "services", "trainers", "free-trial", "schedule"] },
    tone: { keywords: ["strength", "transformation", "discipline", "results"], avoid: ["lazy", "fat-shaming language"] },
  },

  martial_arts_dojo: {
    name: "Martial arts dojo",
    icon: "🥋",
    category: "fitness-sports",
    recommended_agents: {
      receptionist:   { priority: 1 },
      community:      { priority: 2 },
      socialmanager:  { priority: 3 },
    },
    kpis: ["class attendance", "rank progressions", "trial-to-enrolled", "kids program enrollment", "tournament participation"],
    automations: ["trial_class_followup", "rank_test_reminder", "tournament_signup", "summer_camp_promo"],
    compliance: ["minor_consent_required", "liability_waiver_required"],
    site_template: { hero_style: "disciplined-strong", default_sections: ["styles", "kids-program", "adults-program", "schedule", "trial-class"] },
    tone: { keywords: ["discipline", "respect", "tradition", "growth"], avoid: ["fighting", "aggressive"] },
  },

  // ─── FOOD & HOSPITALITY ───────────────────────────────────────────
  restaurant: {
    name: "Restaurant",
    icon: "🍽️",
    category: "food-hospitality",
    recommended_agents: {
      receptionist:   { priority: 1, custom_prompt: "You take reservations, answer menu questions including allergens, handle group bookings. Always check OpenTable/Resy for availability before promising a table." },
      socialmanager:  { priority: 2, voice: "appetizing, seasonal, inviting" },
      community:      { priority: 3 },
      bookkeeper:     { priority: 4 },
    },
    kpis: ["covers per night", "average ticket", "table turn rate", "no-show rate", "online order conversion"],
    automations: ["reservation_confirmation", "no_show_followup", "birthday_offer", "review_request_post_visit", "weekly_menu_email"],
    compliance: ["allergen_disclosure", "food_safety_certifications_display", "alcohol_license_visible"],
    site_template: { hero_style: "appetizing-imagery", default_sections: ["menu", "reservations", "private-events", "team", "press", "hours-map"] },
    tone: { keywords: ["seasonal", "crafted", "fresh", "welcoming"], avoid: ["cheap", "fast-food"] },
  },

  cafe_coffee_shop: {
    name: "Café / coffee shop",
    icon: "☕",
    category: "food-hospitality",
    recommended_agents: {
      socialmanager:  { priority: 1, voice: "cozy, neighborhood, regular-customer-feel" },
      receptionist:   { priority: 2 },
      community:      { priority: 3 },
    },
    kpis: ["daily transactions", "average ticket", "loyalty signups", "morning vs afternoon split", "merch sales"],
    automations: ["loyalty_milestone_free_drink", "new_seasonal_menu_alert", "weather_promo_rainy_day"],
    compliance: ["food_safety", "allergen_disclosure"],
    site_template: { hero_style: "warm-inviting", default_sections: ["menu", "story", "beans-online", "hours-location", "events"] },
    tone: { keywords: ["craft", "neighborhood", "comforting"], avoid: ["fast", "chain"] },
  },

  catering_business: {
    name: "Catering business",
    icon: "🥗",
    category: "food-hospitality",
    recommended_agents: {
      receptionist:   { priority: 1 },
      proposal:       { priority: 2, custom_prompt: "You draft catering quotes with per-head pricing, dietary accommodations, delivery vs serve options, and clear payment terms." },
      bookkeeper:     { priority: 3 },
    },
    kpis: ["events per month", "average event size", "repeat client rate", "lead conversion", "deposit collection"],
    automations: ["inquiry_response_within_1hr", "quote_followup", "event_week_reminder", "post_event_review_request"],
    compliance: ["food_safety_certs_displayed", "insurance_certs_required", "allergen_documentation"],
    site_template: { hero_style: "event-photography", default_sections: ["sample-menus", "events-served", "pricing-guide", "request-quote", "gallery"] },
    tone: { keywords: ["custom", "memorable", "professional"], avoid: ["cheap", "bargain"] },
  },

  food_truck: {
    name: "Food truck",
    icon: "🚚",
    category: "food-hospitality",
    recommended_agents: {
      socialmanager:  { priority: 1, voice: "fun, location-based, story-rich" },
      community:      { priority: 2 },
    },
    kpis: ["daily revenue", "location performance", "social engagement", "private event bookings"],
    automations: ["daily_location_post", "weather_alert_pivot", "private_event_inquiry"],
    site_template: { hero_style: "punchy-food-photography", default_sections: ["todays-location", "menu", "private-events", "where-weve-been"] },
    tone: { keywords: ["bold", "fresh", "street-style"], avoid: ["formal", "stuffy"] },
  },

  // ─── BEAUTY & PERSONAL CARE ───────────────────────────────────────
  hair_salon: {
    name: "Hair salon / barbershop",
    icon: "💇",
    category: "beauty",
    recommended_agents: {
      receptionist:   { priority: 1, custom_prompt: "You book hair appointments, suggest service durations (cut: 30-45min, color: 2-3hr), confirm deposit policy, handle reschedules with empathy." },
      socialmanager:  { priority: 2, voice: "trendy, transformation-focused, visual" },
      community:      { priority: 3 },
    },
    kpis: ["bookings per stylist", "rebook rate", "color/cut split", "no-show rate", "average ticket"],
    automations: ["6week_rebook_reminder", "color_refresh_alert_8weeks", "birthday_offer", "review_request_post_visit"],
    site_template: { hero_style: "transformation-gallery", default_sections: ["services-prices", "stylists", "before-after", "book-now", "products"] },
    tone: { keywords: ["transformative", "expert", "trend"], avoid: ["cheap", "discount"] },
  },

  nail_salon: {
    name: "Nail salon",
    icon: "💅",
    category: "beauty",
    recommended_agents: {
      receptionist:   { priority: 1 },
      socialmanager:  { priority: 2, voice: "trendy, creative, design-led" },
      community:      { priority: 3 },
    },
    kpis: ["bookings per chair", "service mix", "retail attach rate", "rebook rate"],
    automations: ["2week_rebook_reminder", "birthday_glam_offer", "seasonal_design_promo"],
    compliance: ["sanitation_practices_visible", "tool_sterilization_certs"],
    site_template: { hero_style: "creative-portfolio", default_sections: ["designs-gallery", "services-prices", "book-now", "team"] },
    tone: { keywords: ["creative", "polished", "trend"], avoid: [] },
  },

  med_spa: {
    name: "Med spa / aesthetic clinic",
    icon: "✨",
    category: "beauty",
    recommended_agents: {
      receptionist:   { priority: 1, custom_prompt: "You book consultations and treatments. Never make medical claims. Direct medical questions to licensed practitioner. Confirm intake forms before appointments." },
      customersuccess:{ priority: 2 },
      socialmanager:  { priority: 3, voice: "results-focused, professional, never over-promising" },
    },
    kpis: ["consultation-to-treatment", "treatment package sales", "retention 6m", "average ticket"],
    automations: ["consultation_intake_form", "pre_treatment_prep", "post_treatment_aftercare", "results_check_2weeks"],
    compliance: ["medical_director_disclosed", "scope_of_practice_clear", "hipaa_for_medical_records"],
    site_template: { hero_style: "clean-medical", default_sections: ["treatments", "before-after", "team-credentials", "consultations", "financing"] },
    tone: { keywords: ["clinical", "natural-results", "expert"], avoid: ["miracle", "guaranteed"] },
  },

  // ─── PROFESSIONAL SERVICES ────────────────────────────────────────
  law_firm: {
    name: "Law firm / attorney",
    icon: "⚖️",
    category: "professional-services",
    recommended_agents: {
      receptionist:   { priority: 1, custom_prompt: "You schedule consultations and intake. NEVER provide legal advice — always say 'I'll have an attorney follow up.' For urgent matters, route to on-call attorney." },
      legal:          { priority: 2 },
      bookkeeper:     { priority: 3 },
    },
    kpis: ["consultations booked", "conversion to retainer", "case load per attorney", "trust account compliance"],
    automations: ["intake_questionnaire", "consultation_confirmation", "conflict_check_reminder", "trust_account_balance_alert"],
    compliance: ["bar_compliant_marketing", "attorney_advertising_disclosures", "trust_accounting_required", "conflict_check_required", "confidentiality_strict"],
    site_template: { hero_style: "authoritative-professional", default_sections: ["practice-areas", "attorneys", "case-results-disclaimer", "consultation", "reviews"] },
    tone: { keywords: ["experienced", "results-driven", "advocate"], avoid: ["guaranteed", "win", "best"] },
  },

  accounting_firm: {
    name: "Accountant / CPA firm",
    icon: "📊",
    category: "professional-services",
    recommended_agents: {
      receptionist:   { priority: 1 },
      bookkeeper:     { priority: 2 },
      proposal:       { priority: 3 },
    },
    kpis: ["active clients", "monthly recurring revenue", "tax season throughput", "advisory revenue %"],
    automations: ["new_client_intake", "quarterly_estimates_reminder", "tax_doc_request_january", "year_end_planning_meeting"],
    compliance: ["aicpa_standards", "client_data_encryption_required", "irs_circular_230_disclosures"],
    site_template: { hero_style: "trustworthy-clean", default_sections: ["services", "industries-served", "team-credentials", "client-portal-login", "tax-resources"] },
    tone: { keywords: ["trusted", "proactive", "transparent"], avoid: ["loopholes", "tricks"] },
  },

  real_estate_agent: {
    name: "Real estate agent",
    icon: "🏡",
    category: "professional-services",
    recommended_agents: {
      receptionist:   { priority: 1 },
      socialmanager:  { priority: 2, voice: "neighborhood expert, lifestyle, never pushy" },
      proposal:       { priority: 3 },
      community:      { priority: 4 },
    },
    kpis: ["active listings", "average days on market", "closing rate", "referral source", "GCI per month"],
    automations: ["new_listing_alert", "open_house_invite", "post_showing_followup", "closing_anniversary", "neighborhood_market_report"],
    compliance: ["fair_housing_required", "license_displayed", "brokerage_disclosure", "transaction_logs_required"],
    site_template: { hero_style: "lifestyle-aspirational", default_sections: ["listings", "neighborhood-guides", "buyer-guide", "seller-guide", "testimonials"] },
    tone: { keywords: ["local-expert", "informed", "patient"], avoid: ["pressure", "hot-deal"] },
  },

  // ─── E-COMMERCE & RETAIL ──────────────────────────────────────────
  ecommerce_dtc_brand: {
    name: "DTC e-commerce brand",
    icon: "📦",
    category: "ecommerce",
    recommended_agents: {
      socialmanager:  { priority: 1, voice: "brand-story-led, lifestyle, community" },
      customersuccess:{ priority: 2 },
      supportagent:   { priority: 3 },
      bookkeeper:     { priority: 4 },
      marketing:      { priority: 5 },
    },
    kpis: ["AOV", "conversion rate", "CAC", "LTV:CAC", "repeat purchase rate", "cart abandonment", "ad ROAS"],
    automations: ["abandoned_cart_3email", "post_purchase_thank_you", "review_request_14days", "winback_60day_lapsed", "low_stock_alert"],
    compliance: ["gdpr_for_eu_customers", "pci_compliance_via_stripe", "shipping_disclosures", "returns_policy_clear"],
    site_template: { hero_style: "product-imagery-strong", default_sections: ["bestsellers", "shop-all", "brand-story", "reviews", "rewards-program"] },
    tone: { keywords: ["authentic", "purposeful", "high-quality"], avoid: ["dropshipping", "cheap"] },
  },

  streetwear_brand: {
    name: "Streetwear / fashion brand",
    icon: "👕",
    category: "ecommerce",
    recommended_agents: {
      socialmanager:  { priority: 1, voice: "bold, drop-culture, hype-aware, never corporate" },
      community:      { priority: 2 },
      marketing:      { priority: 3 },
      bookkeeper:     { priority: 4 },
    },
    kpis: ["drop sellthrough", "AOV", "size-out rate", "social engagement", "wishlist conversion", "restock conversion"],
    automations: ["drop_announcement", "restock_alert_signup", "abandoned_cart_urgency", "size_back_in_stock", "VIP_early_access"],
    site_template: { hero_style: "editorial-fashion", default_sections: ["latest-drop", "lookbook", "shop", "the-brand", "size-guide"] },
    tone: { keywords: ["bold", "exclusive", "limited", "crafted"], avoid: ["basic", "everyday"] },
  },

  artisan_maker: {
    name: "Artisan / handmade goods",
    icon: "🎨",
    category: "ecommerce",
    recommended_agents: {
      socialmanager:  { priority: 1, voice: "behind-the-scenes, process-led, story" },
      supportagent:   { priority: 2 },
      bookkeeper:     { priority: 3 },
    },
    kpis: ["pieces sold", "AOV", "commissions in queue", "social engagement"],
    automations: ["new_piece_announcement", "commission_status_updates", "studio_tour_invite", "annual_collector_followup"],
    site_template: { hero_style: "craft-process-imagery", default_sections: ["latest-work", "process", "commission-info", "events", "studio-visits"] },
    tone: { keywords: ["handcrafted", "story", "soulful"], avoid: ["mass-produced", "factory"] },
  },

  // ─── SAAS & TECH ──────────────────────────────────────────────────
  saas_startup: {
    name: "SaaS / software product",
    icon: "💻",
    category: "tech",
    recommended_agents: {
      salesrep:       { priority: 1, custom_prompt: "You qualify B2B leads on company size, use case, and budget. Move qualified leads to demo. Never discount before discovery." },
      supportagent:   { priority: 2 },
      socialmanager:  { priority: 3, voice: "thought-leadership, technical, founder-led" },
      customersuccess:{ priority: 4 },
      marketing:      { priority: 5 },
    },
    kpis: ["MRR", "ARR", "churn rate", "NDR", "CAC payback", "trial-to-paid", "feature adoption"],
    automations: ["trial_signup_onboard", "feature_announcement", "activation_milestone", "renewal_30d_before", "churn_save_workflow"],
    compliance: ["soc2_aspirational", "gdpr_required", "data_processing_addendums", "subprocessor_list_public"],
    site_template: { hero_style: "product-screenshot-feature-led", default_sections: ["how-it-works", "features", "pricing", "integrations", "case-studies", "free-trial"] },
    tone: { keywords: ["powerful", "intuitive", "scalable"], avoid: ["revolutionary", "disrupt", "10x"] },
  },

  // ─── EDUCATION & COACHING ─────────────────────────────────────────
  online_coach_consultant: {
    name: "Online coach / consultant",
    icon: "🎓",
    category: "education",
    recommended_agents: {
      salesrep:       { priority: 1 },
      socialmanager:  { priority: 2, voice: "authority-building, vulnerability-balanced, transformation" },
      proposal:       { priority: 3 },
      bookkeeper:     { priority: 4 },
    },
    kpis: ["discovery calls", "discovery-to-client conversion", "client revenue mix", "content engagement", "list growth"],
    automations: ["lead_magnet_delivery", "nurture_email_series", "discovery_call_booking", "client_anniversary_check"],
    site_template: { hero_style: "personal-brand-strong", default_sections: ["my-story", "who-i-help", "programs", "success-stories", "book-call"] },
    tone: { keywords: ["transformative", "proven", "authentic"], avoid: ["secret", "easy", "fast-money"] },
  },

  online_course_creator: {
    name: "Online course creator",
    icon: "📚",
    category: "education",
    recommended_agents: {
      socialmanager:  { priority: 1, voice: "educational, value-led, generous-with-info" },
      community:      { priority: 2 },
      customersuccess:{ priority: 3 },
      supportagent:   { priority: 4 },
    },
    kpis: ["enrollments", "completion rate", "refund rate", "student satisfaction", "affiliate revenue"],
    automations: ["abandoned_checkout", "module_progress_nudge", "completion_celebration", "course_certificate", "affiliate_share_prompt"],
    site_template: { hero_style: "curriculum-clear", default_sections: ["course-curriculum", "instructor", "student-results", "enroll", "faq", "guarantee"] },
    tone: { keywords: ["practical", "proven", "step-by-step"], avoid: ["secret", "guru"] },
  },

  // ─── TRADES & HOME SERVICES ───────────────────────────────────────
  plumbing_hvac: {
    name: "Plumber / HVAC / electrician",
    icon: "🔧",
    category: "trades",
    recommended_agents: {
      receptionist:   { priority: 1, custom_prompt: "You schedule service calls, prioritize emergencies, give time-windows (never exact times), confirm address and access. For emergencies after hours, route to on-call." },
      socialmanager:  { priority: 2, voice: "local-expert, trustworthy, never salesy" },
      community:      { priority: 3 },
      bookkeeper:     { priority: 4 },
    },
    kpis: ["jobs per day", "average ticket", "callback rate", "rebook rate", "lead-to-job conversion"],
    automations: ["appointment_reminder_day_before", "on_the_way_text", "post_job_review_request", "annual_maintenance_reminder", "emergency_after_hours_routing"],
    compliance: ["license_displayed", "insurance_certs", "permit_pull_disclosure"],
    site_template: { hero_style: "trust-local-pros", default_sections: ["services", "service-area", "emergency-line", "reviews", "financing", "team"] },
    tone: { keywords: ["licensed", "responsive", "fair-pricing"], avoid: ["cheap", "deal"] },
  },

  landscaping_lawn_care: {
    name: "Landscaping / lawn care",
    icon: "🌿",
    category: "trades",
    recommended_agents: {
      receptionist:   { priority: 1 },
      socialmanager:  { priority: 2, voice: "transformation-photos, seasonal, local" },
      bookkeeper:     { priority: 3 },
    },
    kpis: ["recurring contracts", "one-off jobs", "average property value", "seasonal revenue split"],
    automations: ["seasonal_service_reminder", "winter_prep_email", "post_job_photo_share", "annual_contract_renewal"],
    site_template: { hero_style: "before-after-imagery", default_sections: ["services", "portfolio", "service-area", "request-quote", "reviews"] },
    tone: { keywords: ["reliable", "professional", "transformative"], avoid: ["cheap"] },
  },

  cleaning_service: {
    name: "Cleaning service (home or commercial)",
    icon: "🧽",
    category: "trades",
    recommended_agents: {
      receptionist:   { priority: 1 },
      socialmanager:  { priority: 2 },
      community:      { priority: 3 },
    },
    kpis: ["recurring vs one-off split", "cleaner utilization", "client retention", "average ticket"],
    automations: ["booking_confirmation", "day_before_reminder", "post_clean_review_request", "subscription_renewal"],
    site_template: { hero_style: "clean-bright-spaces", default_sections: ["services", "pricing-by-bedrooms", "team", "trust-safety", "book-online", "reviews"] },
    tone: { keywords: ["thorough", "trusted", "background-checked"], avoid: ["cheap"] },
  },

  // ─── CREATIVE & MEDIA ─────────────────────────────────────────────
  photographer: {
    name: "Photographer / videographer",
    icon: "📸",
    category: "creative",
    recommended_agents: {
      receptionist:   { priority: 1 },
      proposal:       { priority: 2 },
      community:      { priority: 3 },
      socialmanager:  { priority: 4, voice: "visual, behind-the-scenes, story-led" },
    },
    kpis: ["bookings per month", "average package value", "referral rate", "gallery delivery time"],
    automations: ["inquiry_response_within_2hr", "session_prep_guide", "gallery_delivery_followup", "anniversary_photoshoot_offer"],
    site_template: { hero_style: "portfolio-led", default_sections: ["portfolio", "packages-pricing", "process", "testimonials", "book-consultation"] },
    tone: { keywords: ["timeless", "documentary", "authentic"], avoid: ["cheap", "deal"] },
  },

  music_production: {
    name: "Music production / DJ",
    icon: "🎵",
    category: "creative",
    recommended_agents: {
      receptionist:   { priority: 1 },
      proposal:       { priority: 2 },
      socialmanager:  { priority: 3 },
      community:      { priority: 4 },
    },
    kpis: ["bookings per month", "studio session hours", "release/post cadence", "stream-to-merch conversion"],
    automations: ["inquiry_quote_within_4hr", "session_recap_email", "release_promo_schedule"],
    site_template: { hero_style: "audio-visual-immersive", default_sections: ["work", "services", "studio", "book-session", "press"] },
    tone: { keywords: ["sonic", "crafted", "versatile"], avoid: [] },
  },

  // ─── AGENCY / CONSULTING ──────────────────────────────────────────
  marketing_agency: {
    name: "Marketing / creative agency",
    icon: "🎯",
    category: "agency",
    recommended_agents: {
      salesrep:       { priority: 1 },
      proposal:       { priority: 2 },
      bookkeeper:     { priority: 3 },
      socialmanager:  { priority: 4, voice: "thought-leader, case-study-led" },
      marketing:      { priority: 5 },
    },
    kpis: ["MRR per client", "client retention", "utilization rate", "win rate on proposals", "average engagement length"],
    automations: ["lead_qualification_form", "discovery_call_booking", "proposal_followup_3day", "monthly_client_report", "annual_retainer_review"],
    compliance: ["confidentiality_with_clients", "competitor_client_conflicts"],
    site_template: { hero_style: "case-study-led", default_sections: ["services", "case-studies", "team", "process", "book-strategy-call"] },
    tone: { keywords: ["results-driven", "strategic", "creative"], avoid: ["cheap", "guaranteed-results"] },
  },

  // ─── PETS & ANIMAL CARE ───────────────────────────────────────────
  pet_grooming_boarding: {
    name: "Pet grooming / boarding",
    icon: "🐾",
    category: "pets",
    recommended_agents: {
      receptionist:   { priority: 1 },
      socialmanager:  { priority: 2, voice: "warm, pet-photo-heavy, community" },
      community:      { priority: 3 },
    },
    kpis: ["recurring grooming clients", "boarding occupancy", "rebook rate", "average ticket"],
    automations: ["6week_grooming_reminder", "boarding_holiday_promo", "vaccination_check_reminder", "post_visit_photo_share"],
    compliance: ["vaccination_records_required", "liability_waivers"],
    site_template: { hero_style: "pet-photography", default_sections: ["services", "pricing", "team", "facility-tour", "book-online", "client-pets-gallery"] },
    tone: { keywords: ["caring", "expert", "fun"], avoid: ["cheap"] },
  },

  // ─── DEFAULT FALLBACK ─────────────────────────────────────────────
  general_business: {
    name: "Other / general business",
    icon: "🏢",
    category: "general",
    recommended_agents: {
      receptionist: { priority: 1 },
      bookkeeper:   { priority: 2 },
      socialmanager:{ priority: 3 },
    },
    kpis: ["revenue", "leads", "customer count", "retention"],
    automations: ["new_lead_welcome", "review_request"],
    site_template: { hero_style: "professional-clean", default_sections: ["services", "about", "contact"] },
    tone: { keywords: ["professional", "reliable"], avoid: [] },
  },
};

function getIndustry(key) {
  return INDUSTRY_TEMPLATES[key] || INDUSTRY_TEMPLATES.general_business;
}

function listIndustries() {
  return Object.entries(INDUSTRY_TEMPLATES).map(([key, val]) => ({
    key,
    name: val.name,
    icon: val.icon,
    category: val.category,
  }));
}

function getCategorized() {
  const out = {};
  for (const [key, val] of Object.entries(INDUSTRY_TEMPLATES)) {
    const cat = val.category || "other";
    if (!out[cat]) out[cat] = [];
    out[cat].push({ key, name: val.name, icon: val.icon });
  }
  return out;
}

module.exports = {
  INDUSTRY_TEMPLATES,
  getIndustry,
  listIndustries,
  getCategorized,
};
