// ═══════════════════════════════════════════════════════════════════════════
// MINE — Unified Site Catalog
// One source of truth for the "Start from a template" experience.
//
// Every vertical here:
//   • is shown in the Templates picker (grouped by category),
//   • on create, gives the user a real site — either one of our 3 hand-built
//     DESIGNED templates (instant, no AI cost) or an AI-GENERATED site built
//     from a bespoke, business-specific prompt (no generic fallbacks), and
//   • provisions the real business objects that vertical needs (a coach gets a
//     course + bookable calls + a membership; a salon its bookable services; a
//     shop its products) via routes/site-templates.js → provisionStarterData.
//
// `designed`  → key into the DESIGNED map in routes/site-templates.js
//               (one of: "coaching", "local-service", "ecommerce"); null = AI.
// `industry`  → key into data/industry-templates.js, used to switch on the
//               recommended AI Employees for that vertical at create time.
// ═══════════════════════════════════════════════════════════════════════════

// Per-category accent (the 3 designed templates keep their own template accent).
const CAT = {
  "Health & Wellness":      { accent: "#0E9F6E" },
  "Fitness & Sports":       { accent: "#E8590C" },
  "Food & Hospitality":     { accent: "#E03131" },
  "Beauty & Personal Care": { accent: "#D6336C" },
  "Professional Services":  { accent: "#1971C2" },
  "E-commerce & Retail":    { accent: "#7048E8" },
  "Tech & SaaS":            { accent: "#1098AD" },
  "Education & Coaching":   { accent: "#6C5CE7" },
  "Trades & Home Services": { accent: "#F08C00" },
  "Creative & Media":       { accent: "#0CA678" },
  "Agency & Consulting":    { accent: "#4263EB" },
  "Pets & Animal Care":     { accent: "#9C36B5" },
  "General":                { accent: "#495057" },
};

// One ordered list, grouped by category in display order.
const CATALOG = [
  // ─── Health & Wellness ───────────────────────────────────────────────────
  {
    key: "yoga-studio", industry: "yoga_studio", name: "Yoga / Pilates Studio", icon: "🧘",
    category: "Health & Wellness", tagline: "Class schedule, memberships, and online booking for a yoga or pilates studio.",
    designed: null,
    buildPrompt: "Create a website for a yoga & pilates studio. Offer Hatha, Vinyasa, and Yin classes, Mon–Sat 6am–8pm. Drop-in $25, 10-class pass $200, unlimited monthly $150. Include a class schedule, instructor profiles, a free first class offer, and testimonials.",
    provision: {
      services: [
        { name: "Vinyasa Flow", description: "A dynamic 60-minute flow for all levels.", duration_minutes: 60, price: 25, category: "Class" },
        { name: "Yin & Restore", description: "A slow, deep 75-minute stretch and release.", duration_minutes: 75, price: 25, category: "Class" },
        { name: "Beginners Intro Class", description: "Your free first class — no experience needed.", duration_minutes: 60, price: 0, category: "Class" },
      ],
      memberships: [{ name: "Unlimited Monthly", price: 150, interval_type: "monthly", features: ["Unlimited classes", "Member-only workshops", "Bring-a-friend passes"] }],
      coupons: [{ code: "NEWYOGI", type: "percent", value: 20 }],
    },
  },
  {
    key: "dental", industry: "dental_clinic", name: "Dental Clinic", icon: "🦷",
    category: "Health & Wellness", tagline: "Appointment booking, services and team for a dental or medical practice.",
    designed: null,
    buildPrompt: "Create a website for a dental clinic. Services: general dentistry, teeth whitening $399, Invisalign from $3,500, implants from $3,000. New patient special: comprehensive exam $79. Reassuring, professional tone. Include appointment booking, services, the team, and insurance info.",
    provision: {
      services: [
        { name: "New Patient Exam & Clean", description: "Comprehensive exam, clean and X-rays for new patients.", duration_minutes: 60, price: 79, category: "General" },
        { name: "Teeth Whitening", description: "In-chair professional whitening.", duration_minutes: 60, price: 399, category: "Cosmetic" },
        { name: "Consultation", description: "Discuss treatment options with our team.", duration_minutes: 30, price: 0, category: "Consult" },
      ],
      coupons: [{ code: "NEWPATIENT", type: "percent", value: 10 }],
    },
  },
  {
    key: "therapist", industry: "therapist_counselor", name: "Therapist / Counselor", icon: "💚",
    category: "Health & Wellness", tagline: "A calm, confidential site for a therapy or counseling practice.",
    designed: null,
    buildPrompt: "Create a calm, reassuring website for a private therapy & counseling practice. Approach is warm, evidence-based and judgement-free. 50-minute sessions $160, free 15-minute intro call. Include the approach, areas helped (anxiety, relationships, burnout), rates & insurance, a 'good fit' section, and a confidential contact form. Avoid words like cure or guaranteed.",
    provision: {
      services: [
        { name: "Free 15-min Consult", description: "A short, no-pressure call to see if we are a good fit.", duration_minutes: 15, price: 0, category: "Consult" },
        { name: "Therapy Session", description: "A confidential 50-minute counseling session.", duration_minutes: 50, price: 160, category: "Therapy" },
      ],
    },
  },

  // ─── Fitness & Sports ──────────────────────────────────────────────────────
  {
    key: "personal-trainer", industry: "gym_personal_trainer", name: "Gym / Personal Trainer", icon: "💪",
    category: "Fitness & Sports", tagline: "Programs, 1:1 sessions and a transformation course for a trainer or gym.",
    designed: null,
    buildPrompt: "Create a high-energy website for a personal trainer / gym. Offer 1-on-1 sessions $120/hr, online coaching $299/month, and a 12-week transformation program $899. Include before/after transformations, services, trainer bios, a free consult booking, and the class schedule. Motivating tone, never fat-shaming.",
    provision: {
      courses: [{
        title: "12-Week Transformation", price: 899,
        description: "A structured 12-week program covering training, nutrition and accountability. Edit the modules to match your method.",
        modules: [
          { title: "Phase 1 — Foundations", lessons: ["Assessment & goal setting", "Movement fundamentals"] },
          { title: "Phase 2 — Build", lessons: ["Progressive overload", "Dialing in nutrition"] },
          { title: "Phase 3 — Peak", lessons: ["Pushing intensity", "Locking in the habits"] },
        ],
      }],
      services: [
        { name: "Free Consultation", description: "A 30-minute chat about your goals and how we can hit them.", duration_minutes: 30, price: 0, category: "Consult" },
        { name: "1:1 Training Session", description: "A focused 60-minute personal training session.", duration_minutes: 60, price: 120, category: "Training" },
      ],
      memberships: [{ name: "Online Coaching", price: 299, interval_type: "monthly", features: ["Custom training plan", "Nutrition guidance", "Weekly check-ins"] }],
      coupons: [{ code: "FIRSTSESSION", type: "percent", value: 20 }],
    },
  },
  {
    key: "martial-arts", industry: "martial_arts_dojo", name: "Martial Arts Dojo", icon: "🥋",
    category: "Fitness & Sports", tagline: "Kids and adults programs, trial classes and memberships for a dojo.",
    designed: null,
    buildPrompt: "Create a website for a martial arts dojo built on discipline, respect and growth. Offer kids and adults programs, a free trial class, and monthly membership $99. Include the styles taught, the kids program, the adults program, the class schedule, and a free trial signup. Tone is disciplined and welcoming, never about fighting.",
    provision: {
      services: [
        { name: "Free Trial Class", description: "Try a class on us — no experience needed.", duration_minutes: 60, price: 0, category: "Trial" },
        { name: "Kids Class", description: "Focus, confidence and fun for ages 5–12.", duration_minutes: 45, price: 20, category: "Kids" },
        { name: "Adults Class", description: "Technique, fitness and discipline for adults.", duration_minutes: 60, price: 25, category: "Adults" },
      ],
      memberships: [{ name: "Monthly Membership", price: 99, interval_type: "monthly", features: ["Unlimited classes", "Belt testing included", "Open mat access"] }],
      coupons: [{ code: "FAMILY10", type: "percent", value: 10 }],
    },
  },

  // ─── Food & Hospitality ──────────────────────────────────────────────────
  {
    key: "restaurant", industry: "restaurant", name: "Restaurant", icon: "🍽️",
    category: "Food & Hospitality", tagline: "Menu, reservations and gallery for a restaurant.",
    designed: null,
    buildPrompt: "Create a website for an authentic Italian restaurant. Lunch $18–35, dinner $32–65. Specialties: handmade pasta, wood-fired pizza, tiramisu. Open Tue–Sun. Include the full menu, a reservation system, private events, the team, press, and hours & map. Warm, seasonal, appetizing tone.",
    provision: {
      products: [
        { name: "Margherita Pizza", price: 18, description: "Wood-fired, San Marzano tomato, fior di latte, basil." },
        { name: "Handmade Tagliatelle", price: 26, description: "Fresh egg pasta with a slow-cooked ragù." },
        { name: "Tiramisu", price: 12, description: "Classic mascarpone, espresso and cocoa." },
      ],
      coupons: [{ code: "WELCOME10", type: "percent", value: 10 }],
    },
  },
  {
    key: "cafe", industry: "cafe_coffee_shop", name: "Café / Coffee Shop", icon: "☕",
    category: "Food & Hospitality", tagline: "Menu, story and online beans for a neighborhood café.",
    designed: null,
    buildPrompt: "Create a warm, neighborhood website for a specialty coffee shop. Single-origin and house-blend coffee, fresh pastries, all-day brunch. Include the menu, the story, beans available online, hours & location, and events. Cozy, regular-customer feel — not a chain.",
    provision: {
      products: [
        { name: "House Blend Beans 250g", price: 18, description: "Our signature roast — chocolate, caramel, low acidity." },
        { name: "Cold Brew Concentrate", price: 14, description: "Smooth 1L concentrate, makes 8 cups." },
        { name: "Ceramic Keep Cup", price: 24, description: "Double-walled, 12oz, branded." },
      ],
      coupons: [{ code: "WELCOME10", type: "percent", value: 10 }],
    },
  },
  {
    key: "catering", industry: "catering_business", name: "Catering Business", icon: "🥗",
    category: "Food & Hospitality", tagline: "Sample menus, gallery and quote requests for a caterer.",
    designed: null,
    buildPrompt: "Create a website for a catering company that does weddings, corporate and private events. Custom menus, dietary accommodations, delivery or full-service. Include sample menus, events served, a pricing guide, a request-a-quote form, and a gallery. Tone is custom, memorable and professional.",
    provision: {
      services: [
        { name: "Catering Consultation", description: "A free 45-minute call to plan your event menu and budget.", duration_minutes: 45, price: 0, category: "Consult" },
      ],
      coupons: [{ code: "FIRSTEVENT", type: "percent", value: 10 }],
    },
  },
  {
    key: "food-truck", industry: "food_truck", name: "Food Truck", icon: "🚚",
    category: "Food & Hospitality", tagline: "Today's location, menu and event bookings for a food truck.",
    designed: null,
    buildPrompt: "Create a bold, punchy website for a street-food truck. Include today's location, the menu, private event bookings, and a 'where we've been' map. Fun, street-style, story-rich tone — never formal.",
    provision: {
      products: [
        { name: "Signature Burger", price: 14, description: "Smash patty, house sauce, pickles, brioche." },
        { name: "Loaded Fries", price: 9, description: "Hand-cut fries, cheese, scallions." },
        { name: "Daily Special", price: 12, description: "Ask the window — it changes daily." },
      ],
      coupons: [{ code: "TRUCKLOVE", type: "percent", value: 10 }],
    },
  },

  // ─── Beauty & Personal Care ────────────────────────────────────────────────
  {
    key: "salon", industry: "hair_salon", name: "Hair Salon / Barbershop", icon: "💇",
    category: "Beauty & Personal Care", tagline: "Booking-first design with real bookable services. Hand-designed.",
    designed: "local-service",
    buildPrompt: "Create a website for a hair salon / barbershop. Services: cuts from $65, colour from $120, blowout $55, keratin $250. Team of 5 stylists. Include online booking, a price menu, a before/after gallery, and the team.",
    provision: null, // provided by the designed "local-service" template's own provision
  },
  {
    key: "nail-salon", industry: "nail_salon", name: "Nail Salon", icon: "💅",
    category: "Beauty & Personal Care", tagline: "Design gallery, service menu and booking for a nail salon.",
    designed: null,
    buildPrompt: "Create a creative, trend-led website for a nail salon. Manicures, gel, pedicures and nail art. Include a designs gallery, a service & price menu, online booking, and the team. Polished, creative tone.",
    provision: {
      services: [
        { name: "Classic Manicure", description: "Shape, cuticle care and polish.", duration_minutes: 45, price: 35, category: "Nails" },
        { name: "Gel Manicure", description: "Long-lasting gel finish in any colour.", duration_minutes: 60, price: 55, category: "Nails" },
        { name: "Spa Pedicure", description: "Soak, scrub, massage and polish.", duration_minutes: 60, price: 65, category: "Nails" },
      ],
      coupons: [{ code: "FIRSTSET10", type: "percent", value: 10 }],
    },
  },
  {
    key: "med-spa", industry: "med_spa", name: "Med Spa / Aesthetic Clinic", icon: "✨",
    category: "Beauty & Personal Care", tagline: "Treatments, before/after and consultations for a med spa.",
    designed: null,
    buildPrompt: "Create a clean, clinical website for a medical aesthetic spa. Treatments include facials, injectables and skin therapies. Always offer consultations first, never make medical claims or promise miracles. Include treatments, before/after, team credentials, consultations, and financing.",
    provision: {
      services: [
        { name: "Consultation", description: "A 30-minute consult to plan the right treatment for you.", duration_minutes: 30, price: 0, category: "Consult" },
        { name: "Signature Facial", description: "A tailored 60-minute results-focused facial.", duration_minutes: 60, price: 180, category: "Treatment" },
      ],
      coupons: [{ code: "NEWCLIENT", type: "percent", value: 15 }],
    },
  },

  // ─── Professional Services ─────────────────────────────────────────────────
  {
    key: "law", industry: "law_firm", name: "Law Firm / Attorney", icon: "⚖️",
    category: "Professional Services", tagline: "Practice areas, attorney bios and consultations for a law firm.",
    designed: null,
    buildPrompt: "Create an authoritative, professional website for a law firm. Include practice areas, the attorneys, a results section with the appropriate disclaimer, a consultation booking, and reviews. Experienced and results-driven tone — never use the words guaranteed, win, or best.",
    provision: {
      services: [
        { name: "Initial Consultation", description: "A confidential 30-minute consultation with an attorney.", duration_minutes: 30, price: 0, category: "Consult" },
      ],
    },
  },
  {
    key: "accountant", industry: "accounting_firm", name: "Accountant / CPA Firm", icon: "📊",
    category: "Professional Services", tagline: "Services, a tax-return offering and a bookkeeping plan for a CPA firm.",
    designed: null,
    buildPrompt: "Create a trustworthy, clean website for a CPA / accounting firm. Services: individual tax returns $199, business from $599, bookkeeping from $299/month, SMSF from $1,499/yr. Include services, industries served, team credentials, a client-portal login, and tax resources. Trusted, proactive, transparent tone.",
    provision: {
      services: [
        { name: "Free Consultation", description: "A 30-minute call to understand your needs.", duration_minutes: 30, price: 0, category: "Consult" },
        { name: "Individual Tax Return", description: "Preparation and lodgement of your personal tax return.", duration_minutes: 60, price: 199, category: "Tax" },
      ],
      memberships: [{ name: "Monthly Bookkeeping", price: 299, interval_type: "monthly", features: ["Reconciliations", "Monthly reports", "Year-round support"] }],
    },
  },
  {
    key: "real-estate", industry: "real_estate_agent", name: "Real Estate Agent", icon: "🏡",
    category: "Professional Services", tagline: "Listings, neighborhood guides and a free appraisal for an agent.",
    designed: null,
    buildPrompt: "Create a lifestyle-led, aspirational website for a real estate agent specialising in residential and commercial property. Include featured listings, neighborhood guides, a buyer guide, a seller guide, and testimonials, plus a free appraisal offer. Local-expert and patient tone — never pushy.",
    provision: {
      services: [
        { name: "Free Home Appraisal", description: "A no-obligation 45-minute market appraisal of your property.", duration_minutes: 45, price: 0, category: "Appraisal" },
        { name: "Buyer Consultation", description: "A 30-minute chat about what you are looking for.", duration_minutes: 30, price: 0, category: "Consult" },
      ],
    },
  },

  // ─── E-commerce & Retail ───────────────────────────────────────────────────
  {
    key: "ecommerce", industry: "ecommerce_dtc_brand", name: "Online Store / DTC Brand", icon: "📦",
    category: "E-commerce & Retail", tagline: "Product-grid storefront, stocked and cart-ready. Hand-designed.",
    designed: "ecommerce",
    buildPrompt: "Create an online store for a contemporary DTC brand. Bestsellers, shop-all, brand story, reviews and a rewards program. Authentic, purposeful, high-quality tone.",
    provision: null, // provided by the designed "ecommerce" template's own provision
  },
  {
    key: "streetwear", industry: "streetwear_brand", name: "Streetwear / Fashion Brand", icon: "👕",
    category: "E-commerce & Retail", tagline: "Drop-culture storefront with a stocked apparel catalog.",
    designed: null,
    buildPrompt: "Create a bold, editorial streetwear brand website built around drops. Sell tees $45, hoodies $120, cargo pants $95. Include the latest drop, a lookbook, the shop, the brand story, and a size guide. Hype-aware, exclusive, never corporate.",
    provision: {
      products: [
        { name: "Box Logo Tee", price: 45, description: "240gsm heavyweight cotton, boxy fit." },
        { name: "Heavyweight Hoodie", price: 120, description: "480gsm brushed fleece, oversized." },
        { name: "Cargo Pants", price: 95, description: "Utility cargos with adjustable hem." },
      ],
      coupons: [{ code: "DROP10", type: "percent", value: 10 }],
    },
  },
  {
    key: "artisan", industry: "artisan_maker", name: "Artisan / Handmade Goods", icon: "🎨",
    category: "E-commerce & Retail", tagline: "Process-led shop for a maker, stocked with handmade pieces.",
    designed: null,
    buildPrompt: "Create a craft-led website for an artisan maker of handmade goods. Show the latest work, the making process, commission info, events, and studio visits. Handcrafted, soulful, story-rich tone — never mass-produced.",
    provision: {
      products: [
        { name: "Hand-thrown Vase", price: 68, description: "Wheel-thrown stoneware, reactive glaze. One of a kind." },
        { name: "Ceramic Bowl Set", price: 84, description: "Set of four hand-glazed bowls." },
        { name: "Woven Wall Hanging", price: 120, description: "Hand-woven natural fibres, 60cm." },
      ],
      coupons: [{ code: "MADEBYHAND10", type: "percent", value: 10 }],
    },
  },

  // ─── Tech & SaaS ───────────────────────────────────────────────────────────
  {
    key: "saas", industry: "saas_startup", name: "SaaS / Software Product", icon: "💻",
    category: "Tech & SaaS", tagline: "Feature-led landing page with subscription plans wired up.",
    designed: null,
    buildPrompt: "Create a feature-led website for a B2B SaaS product. Include how-it-works, features, pricing, integrations, case studies, and a free-trial CTA. Powerful, intuitive, scalable tone — avoid words like revolutionary, disrupt, or 10x. Use product-screenshot placeholders.",
    provision: {
      memberships: [
        { name: "Starter", price: 29, interval_type: "monthly", features: ["Up to 3 seats", "Core features", "Email support"] },
        { name: "Pro", price: 99, interval_type: "monthly", features: ["Unlimited seats", "Advanced analytics", "Priority support", "Integrations"] },
      ],
      coupons: [{ code: "LAUNCH20", type: "percent", value: 20 }],
    },
  },

  // ─── Education & Coaching ──────────────────────────────────────────────────
  {
    key: "online-coach", industry: "online_coach_consultant", name: "Online Coach / Consultant", icon: "🎓",
    category: "Education & Coaching", tagline: "Personal-brand site with a course, bookable calls and a membership. Hand-designed.",
    designed: "coaching",
    buildPrompt: "Create a personal-brand website for an online coach / consultant. My story, who I help, programs, success stories, and a book-a-call CTA. Transformative, proven, authentic tone — never secret, easy, or fast-money.",
    provision: null, // provided by the designed "coaching" template's own provision
  },
  {
    key: "course-creator", industry: "online_course_creator", name: "Online Course Creator", icon: "📚",
    category: "Education & Coaching", tagline: "Course site with a flagship course and an all-access membership.",
    designed: null,
    buildPrompt: "Create a clear, curriculum-led website for an online course creator. Flagship course $497, membership $47/month. Include the course curriculum, the instructor, student results, an enroll section, an FAQ, and a guarantee. Practical, proven, step-by-step tone — never guru-speak.",
    provision: {
      courses: [{
        title: "Flagship Course", price: 497,
        description: "Your signature course. Edit the modules and lessons to match your curriculum.",
        modules: [
          { title: "Module 1 — Getting started", lessons: ["Welcome & orientation", "The big picture"] },
          { title: "Module 2 — Core skills", lessons: ["The method, step by step", "Practice & feedback"] },
          { title: "Module 3 — Putting it together", lessons: ["Real-world application", "Next steps"] },
        ],
      }],
      memberships: [{ name: "All-Access Membership", price: 47, interval_type: "monthly", features: ["All current & future courses", "Monthly live Q&A", "Private community"] }],
      coupons: [{ code: "LEARN20", type: "percent", value: 20 }],
    },
  },

  // ─── Trades & Home Services ────────────────────────────────────────────────
  {
    key: "tradie", industry: "plumbing_hvac", name: "Plumber / HVAC / Electrician", icon: "🔧",
    category: "Trades & Home Services", tagline: "Service call-outs, quotes and reviews for a trades business.",
    designed: null,
    buildPrompt: "Create a trustworthy, local website for a trades business offering plumbing, electrical, and general maintenance. 24/7 emergency service, upfront pricing, 500+ 5-star reviews. Include services, the service area, an emergency line, reviews, financing, and a free quote form. Licensed, responsive, fair-pricing tone.",
    provision: {
      services: [
        { name: "Free Quote", description: "A 30-minute on-site or phone quote, no obligation.", duration_minutes: 30, price: 0, category: "Quote" },
        { name: "Service Call-Out", description: "Standard call-out and first hour of labour.", duration_minutes: 60, price: 99, category: "Service" },
        { name: "Emergency Call-Out", description: "After-hours priority response.", duration_minutes: 60, price: 189, category: "Emergency" },
      ],
      coupons: [{ code: "FIRSTJOB10", type: "percent", value: 10 }],
    },
  },
  {
    key: "landscaping", industry: "landscaping_lawn_care", name: "Landscaping / Lawn Care", icon: "🌿",
    category: "Trades & Home Services", tagline: "Portfolio, quotes and a seasonal maintenance plan.",
    designed: null,
    buildPrompt: "Create a website for a landscaping & lawn care business. Show before/after work, services, the service area, a request-a-quote form, and reviews. Reliable, professional, transformative tone.",
    provision: {
      services: [
        { name: "Free On-site Quote", description: "We visit, measure and quote — no obligation.", duration_minutes: 30, price: 0, category: "Quote" },
        { name: "Lawn Care Visit", description: "Mow, edge and tidy for a standard yard.", duration_minutes: 60, price: 65, category: "Lawn" },
      ],
      memberships: [{ name: "Seasonal Maintenance", price: 180, interval_type: "monthly", features: ["Scheduled visits", "Priority booking", "Seasonal clean-ups"] }],
      coupons: [{ code: "SPRING10", type: "percent", value: 10 }],
    },
  },
  {
    key: "cleaning", industry: "cleaning_service", name: "Cleaning Service", icon: "🧽",
    category: "Trades & Home Services", tagline: "Online booking, pricing and a recurring clean plan.",
    designed: null,
    buildPrompt: "Create a bright, trustworthy website for a home & commercial cleaning service. Pricing by bedrooms, background-checked team. Include services, pricing, the team, trust & safety, online booking, and reviews. Thorough, trusted, background-checked tone.",
    provision: {
      services: [
        { name: "Standard Home Clean", description: "A thorough clean of a standard home.", duration_minutes: 120, price: 120, category: "Clean" },
        { name: "Deep Clean", description: "Top-to-bottom deep clean, ideal for move-in/out.", duration_minutes: 180, price: 220, category: "Clean" },
      ],
      memberships: [{ name: "Weekly Clean Plan", price: 400, interval_type: "monthly", features: ["Weekly visits", "Same trusted cleaner", "Priority scheduling"] }],
      coupons: [{ code: "FIRSTCLEAN15", type: "percent", value: 15 }],
    },
  },

  // ─── Creative & Media ──────────────────────────────────────────────────────
  {
    key: "photographer", industry: "photographer", name: "Photographer / Videographer", icon: "📸",
    category: "Creative & Media", tagline: "Portfolio, packages and session booking for a photographer.",
    designed: null,
    buildPrompt: "Create a portfolio-led website for a photographer specialising in weddings and portraits. Wedding packages from $2,500, portrait sessions from $350. Include a stunning gallery, packages & pricing, the process, testimonials, and a consultation booking. Timeless, documentary, authentic tone.",
    provision: {
      services: [
        { name: "Wedding Consultation", description: "A free 45-minute call to plan your day.", duration_minutes: 45, price: 0, category: "Consult" },
        { name: "Portrait Session", description: "A 90-minute portrait session, edited gallery included.", duration_minutes: 90, price: 350, category: "Portrait" },
      ],
    },
  },
  {
    key: "music", industry: "music_production", name: "Music Production / DJ", icon: "🎵",
    category: "Creative & Media", tagline: "Work, studio sessions and booking enquiries for a producer or DJ.",
    designed: null,
    buildPrompt: "Create an immersive, audio-visual website for a music producer / DJ. Show the work, services, the studio, a book-a-session flow, and press. Sonic, crafted, versatile tone.",
    provision: {
      services: [
        { name: "DJ Booking Enquiry", description: "Tell us about your event and we will quote.", duration_minutes: 30, price: 0, category: "Booking" },
        { name: "Studio Session", description: "Per-hour recording & production time.", duration_minutes: 60, price: 80, category: "Studio" },
      ],
    },
  },

  // ─── Agency & Consulting ───────────────────────────────────────────────────
  {
    key: "marketing-agency", industry: "marketing_agency", name: "Marketing / Creative Agency", icon: "🎯",
    category: "Agency & Consulting", tagline: "Case-study-led site with a strategy call and a retainer plan.",
    designed: null,
    buildPrompt: "Create a case-study-led website for a marketing / creative agency. Services like strategy, digital and growth, with results-driven case studies. Include services, case studies, the team, the process, and a book-a-strategy-call CTA. Strategic, creative, results-driven tone — never guarantee results.",
    provision: {
      services: [
        { name: "Free Strategy Call", description: "A 30-minute call to scope your goals and fit.", duration_minutes: 30, price: 0, category: "Strategy" },
      ],
      memberships: [{ name: "Monthly Retainer", price: 2500, interval_type: "monthly", features: ["Dedicated team", "Monthly strategy & reporting", "Priority delivery"] }],
    },
  },

  // ─── Pets & Animal Care ────────────────────────────────────────────────────
  {
    key: "pet-grooming", industry: "pet_grooming_boarding", name: "Pet Grooming / Boarding", icon: "🐾",
    category: "Pets & Animal Care", tagline: "Services, a facility tour and online booking for pet care.",
    designed: null,
    buildPrompt: "Create a warm, pet-photo-heavy website for a pet grooming & boarding business. Include services, pricing, the team, a facility tour, online booking, and a client-pets gallery. Caring, expert, fun tone.",
    provision: {
      services: [
        { name: "Full Groom", description: "Bath, brush, trim and nails for your dog.", duration_minutes: 90, price: 75, category: "Grooming" },
        { name: "Bath & Tidy", description: "A quick freshen-up between full grooms.", duration_minutes: 45, price: 45, category: "Grooming" },
        { name: "Boarding (per night)", description: "Safe, supervised overnight boarding.", duration_minutes: 60, price: 55, category: "Boarding" },
      ],
      coupons: [{ code: "FIRSTGROOM10", type: "percent", value: 10 }],
    },
  },

  // ─── General ───────────────────────────────────────────────────────────────
  {
    key: "general", industry: "general_business", name: "Other / General Business", icon: "🏢",
    category: "General", tagline: "A clean, professional site for any business — a flexible starting point.",
    designed: null,
    buildPrompt: "Create a clean, professional single-page website for a general small business. Include a hero, services, about, social proof, pricing, an FAQ, a clear call to action, and contact. Professional and reliable tone. Use a palette that suits a modern, trustworthy small business.",
    provision: {
      services: [
        { name: "Free Consultation", description: "A 30-minute call to see how we can help.", duration_minutes: 30, price: 0, category: "Consult" },
      ],
      coupons: [{ code: "WELCOME10", type: "percent", value: 10 }],
    },
  },
];

// Attach the per-category accent (designed templates override with their own).
const DESIGNED_ACCENT = { coaching: "#6C5CE7", "local-service": "#0E9F6E", ecommerce: "#E8590C" };
for (const t of CATALOG) {
  t.accent = t.designed ? (DESIGNED_ACCENT[t.designed] || (CAT[t.category] || {}).accent) : (CAT[t.category] || {}).accent || "#635BFF";
}

function listCatalog() {
  return CATALOG.map(t => ({
    key: t.key, name: t.name, icon: t.icon, category: t.category,
    accent: t.accent, tagline: t.tagline, designed: !!t.designed,
  }));
}
function getCatalogEntry(key) {
  return CATALOG.find(t => t.key === key) || null;
}

// Map a free-text business description to the best-fit catalog key (keyword matcher,
// most-specific-first). Returns a key that exists in CATALOG, or "general". Used by the
// landing preview and (recommended) the post-signup builder so a prompt routes to the
// right template. An LLM classifier can replace/augment this later — same signature.
function matchTemplate(text) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return "general";
  const rules = [
    [/med.?spa|medspa|aesthetic clinic|botox|dermal filler|skin clinic|cosmetic inject/, "med-spa"],
    [/nail|manicure|pedicure/, "nail-salon"],
    [/salon|barber|barbershop|hairdress|blow.?dry|\bhair\b/, "salon"],
    [/food.?truck|food van/, "food-truck"],
    [/cater/, "catering"],
    [/coffee|espresso|roastery|roaster|\bcaf[e\u00e9]\b/, "cafe"],
    [/restaurant|bistro|eatery|\bdiner\b|fine dining|\bmenu\b/, "restaurant"],
    [/yoga|pilates/, "yoga-studio"],
    [/martial art|karate|jiu.?jitsu|\bbjj\b|taekwondo|\bmma\b|\bdojo\b|boxing|kickbox/, "martial-arts"],
    [/personal train|\bgym\b|fitness|workout|crossfit|bootcamp|strength coach/, "personal-trainer"],
    [/dentist|dental|orthodont|\bteeth\b/, "dental"],
    [/therapist|counsel|psycholog|mental health|counsell/, "therapist"],
    [/lawyer|attorney|law firm|solicitor|\blegal\b|\blaw\b/, "law"],
    [/accountant|accounting|\bcpa\b|bookkeep|tax return|tax agent/, "accountant"],
    [/real estate|realtor|estate agent|property agent|realty/, "real-estate"],
    [/streetwear|clothing brand|fashion brand|apparel|\bhoodie\b|\btee\b/, "streetwear"],
    [/artisan|handmade|pottery|ceramic|hand.?thrown|\bmaker\b/, "artisan"],
    [/online course|course creator|\bcourses\b|e-?learning|curriculum|masterclass|\bcohort\b/, "course-creator"],
    [/\bcoach\b|coaching|\bmentor\b|consultant/, "online-coach"],
    [/\bsaas\b|software product|web app|mobile app|\bplatform\b|tech startup/, "saas"],
    [/plumb|\bhvac\b|electrician|electrical|handyman|tradie|tradesman|contractor|roofing/, "tradie"],
    [/landscap|lawn care|\bgarden\b|mowing|\byard\b/, "landscaping"],
    [/cleaning|cleaner|\bmaid\b|janitor/, "cleaning"],
    [/photograph|videograph|\bvideo\b|wedding film/, "photographer"],
    [/\bdj\b|music produc|\bband\b|recording studio|beat.?maker/, "music"],
    [/marketing agency|creative agency|\bad agency\b|digital agency|design agency|\bagency\b/, "marketing-agency"],
    [/pet groom|dog groom|\bkennel\b|pet boarding|\bgroomer\b|\bdoggy\b/, "pet-grooming"],
    [/e-?commerce|online store|online shop|\bdtc\b|drop.?ship|sell products?|\bstore\b|\bshop\b/, "ecommerce"],
  ];
  for (var i = 0; i < rules.length; i++) {
    if (rules[i][0].test(t)) { var k = rules[i][1]; if (CATALOG.find(function(x){ return x.key === k; })) return k; }
  }
  return "general";
}

module.exports = { CATALOG, listCatalog, getCatalogEntry, matchTemplate, CAT };
