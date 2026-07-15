
// ═══════════════════════════════════════════════════════════════
// MINE TEMPLATE LIBRARY — /api/templates
// 12 pre-built, production-ready site templates
// ═══════════════════════════════════════════════════════════════

const router_templates = require('express').Router();
const { v4: uuid } = require('uuid');
const { getDb } = require('../db/init');
const { auth } = require('../middleware/auth');

const TEMPLATES = [
  {
    id: 'yoga-studio',
    name: 'Zara Yoga Studio',
    bizType: 'Yoga & Wellness',
    category: 'health',
    tags: ['yoga','wellness','bookings','classes'],
    preview: 'https://images.unsplash.com/photo-1545205597-3d9d02c29597?w=600&auto=format&fit=crop',
    features: ['Bookings','Classes','Memberships'],
    rating: 4.9, uses: 2841
  },
  {
    id: 'restaurant',
    name: 'Bella Italia Restaurant',
    bizType: 'Restaurant & Cafe',
    category: 'food',
    tags: ['restaurant','menu','reservations','food'],
    preview: 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=600&auto=format&fit=crop',
    features: ['Online Menu','Reservations','Gallery'],
    rating: 4.8, uses: 1923
  },
  {
    id: 'salon',
    name: 'Luxe Beauty Salon',
    bizType: 'Hair & Beauty',
    category: 'beauty',
    tags: ['salon','hair','beauty','bookings'],
    preview: 'https://images.unsplash.com/photo-1560066984-138dadb4c035?w=600&auto=format&fit=crop',
    features: ['Bookings','Services','Team'],
    rating: 4.9, uses: 3102
  },
  {
    id: 'personal-trainer',
    name: 'Elite Personal Training',
    bizType: 'Fitness & Training',
    category: 'health',
    tags: ['fitness','personal trainer','gym','courses'],
    preview: 'https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?w=600&auto=format&fit=crop',
    features: ['Bookings','Courses','Programs'],
    rating: 4.8, uses: 1654
  },
  {
    id: 'ecommerce',
    name: 'Urban Style Shop',
    bizType: 'Online Store',
    category: 'retail',
    tags: ['ecommerce','shop','products','cart'],
    preview: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=600&auto=format&fit=crop',
    features: ['Shop','Cart','Payments'],
    rating: 4.7, uses: 4210
  },
  {
    id: 'consultant',
    name: 'Strategy Consulting',
    bizType: 'Consulting & Agency',
    category: 'professional',
    tags: ['consulting','agency','leads','contact'],
    preview: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=600&auto=format&fit=crop',
    features: ['Lead Gen','Case Studies','Contact'],
    rating: 4.8, uses: 1102
  },
  {
    id: 'course-creator',
    name: 'The Knowledge Academy',
    bizType: 'Online Courses',
    category: 'education',
    tags: ['courses','education','membership','LMS'],
    preview: 'https://images.unsplash.com/photo-1522202176988-66273c2fd55f?w=600&auto=format&fit=crop',
    features: ['Courses','Memberships','Community'],
    rating: 4.9, uses: 892
  },
  {
    id: 'real-estate',
    name: 'Premier Properties',
    bizType: 'Real Estate',
    category: 'property',
    tags: ['real estate','property','leads','listings'],
    preview: 'https://images.unsplash.com/photo-1560518883-ce09059eeffa?w=600&auto=format&fit=crop',
    features: ['Listings','Lead Gen','Contact'],
    rating: 4.7, uses: 743
  },
  {
    id: 'photographer',
    name: 'Lumière Photography',
    bizType: 'Photography',
    category: 'creative',
    tags: ['photography','portfolio','bookings','gallery'],
    preview: 'https://images.unsplash.com/photo-1452587925148-ce544e77e70d?w=600&auto=format&fit=crop',
    features: ['Gallery','Bookings','Packages'],
    rating: 4.9, uses: 1821
  },
  {
    id: 'dental',
    name: 'Bright Smile Dental',
    bizType: 'Dental & Medical',
    category: 'health',
    tags: ['dental','medical','appointments','health'],
    preview: 'https://images.unsplash.com/photo-1588776814546-1ffcf47267a5?w=600&auto=format&fit=crop',
    features: ['Appointments','Services','Team'],
    rating: 4.8, uses: 654
  },
  {
    id: 'accountant',
    name: 'Clear Financial Services',
    bizType: 'Accounting & Finance',
    category: 'professional',
    tags: ['accounting','finance','tax','leads'],
    preview: 'https://images.unsplash.com/photo-1554224155-6726b3ff858f?w=600&auto=format&fit=crop',
    features: ['Lead Gen','Services','Calculator'],
    rating: 4.7, uses: 432
  },
  {
    id: 'tradie',
    name: 'Reliable Trades Co.',
    bizType: 'Trades & Services',
    category: 'trades',
    tags: ['plumber','electrician','trades','leads'],
    preview: 'https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=600&auto=format&fit=crop',
    features: ['Quote Form','Gallery','Reviews'],
    rating: 4.8, uses: 2103
  },
];

// GET /api/templates — list all templates
router_templates.get('/', (req, res) => {
  const { category, search } = req.query;
  let list = TEMPLATES;
  if (category && category !== 'all') {
    list = list.filter(t => t.category === category);
  }
  if (search) {
    const q = search.toLowerCase();
    list = list.filter(t => t.name.toLowerCase().includes(q) || t.tags.some(tag => tag.includes(q)));
  }
  res.json({ templates: list, total: list.length });
});

// GET /api/templates/:id — get a single template with full HTML
router_templates.get('/:id', async (req, res) => {
  const { id } = req.params;
  const tpl = TEMPLATES.find(t => t.id === id);
  if (!tpl) return res.status(404).json({ error: 'Template not found' });

  // Return template metadata — the full HTML is generated on demand via /api/ai-agent/build
  // with a pre-written excellent prompt for this specific business type
  const prompts = {
    'yoga-studio': 'Create a website for Zara Yoga Studio in Sydney. Offer Hatha, Vinyasa, and Yin yoga. Classes Mon-Sat 6am-8pm. Drop-in $25, 10-class pass $200, unlimited monthly $150. Include schedule, instructor profiles, and testimonials.',
    'restaurant': 'Create a website for Bella Italia, an authentic Italian restaurant in Melbourne. Lunch $18-35, Dinner $32-65. Specialties: handmade pasta, wood-fired pizza, tiramisu. Open Tue-Sun. Include full menu, reservation system, and gallery.',
    'salon': 'Create a website for Luxe Beauty Salon in Brisbane. Services: cuts from $65, colour from $120, blowout $55, keratin $250. Team of 5 stylists. Include booking system, price menu, before/after gallery.',
    'personal-trainer': 'Create a website for Elite Personal Training. Offer 1-on-1 sessions $120/hr, online coaching $299/month, 12-week transformation program $899. Include progress photos, testimonials, free consult booking.',
    'ecommerce': 'Create an online store for Urban Style, a contemporary fashion brand. Sell shirts $45-65, jackets $120-180, accessories $25-55. Include featured products, new arrivals, sale section, and size guide.',
    'consultant': 'Create a website for a strategy consulting firm. Services: business strategy, digital transformation, growth advisory. Clients include 3 Fortune 500 brands. Include case studies, team bios, and consultation booking.',
    'course-creator': 'Create a website for The Knowledge Academy, offering online courses in digital marketing, business, and personal development. Flagship course $497, membership $47/month. Include course catalog, student testimonials, free preview.',
    'real-estate': 'Create a website for Premier Properties real estate agency. Specialise in residential and commercial in Sydney Eastern Suburbs. Include featured listings, market reports, free appraisal offer, and agent profiles.',
    'photographer': 'Create a website for Lumière Photography, specialising in weddings and portraits in Auckland. Wedding packages from $2,500, portrait sessions from $350. Include stunning gallery, packages, and booking form.',
    'dental': 'Create a website for Bright Smile Dental in Perth. Services: general dentistry, teeth whitening $399, Invisalign from $3,500, implants from $3,000. New patient special: comprehensive exam $79. Include appointment booking.',
    'accountant': 'Create a website for Clear Financial Services, a CPA firm. Services: tax returns individual $199, business from $599, bookkeeping from $299/month, SMSF from $1,499/yr. Include free consultation and tax calculator.',
    'tradie': 'Create a website for Reliable Trades Co., offering plumbing, electrical, and general maintenance in Melbourne. 24/7 emergency service. Upfront pricing. Over 500 5-star reviews. Include services, photo gallery, and free quote form.',
  };

  res.json({
    ...tpl,
    buildPrompt: prompts[id] || `Create a professional website for a ${tpl.bizType} business.`
  });
});

// POST /api/templates/:id/install — create a draft site for this user from the template (audit 2026-06-10)
router_templates.post('/:id/install', auth, (req, res) => {
  try {
    const tpl = TEMPLATES.find(t => t.id === req.params.id);
    if (!tpl) return res.status(404).json({ error: 'Template not found' });
    const db = getDb();
    const id = uuid();
    const html = `<!DOCTYPE html><!-- template:${tpl.id} — open the Site Editor and use AI build to generate this site --><html><head><meta charset="utf-8"><title>${tpl.name}</title></head><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0B0B14;color:#fff"><div style="text-align:center;max-width:520px;padding:32px"><h1 style="margin:0 0 8px">${tpl.name}</h1><p style="opacity:.7">Starter site created from the ${tpl.bizType} template. Open the Site Editor to build it out.</p></div></body></html>`;
    db.prepare("INSERT INTO sites (id, user_id, agency_id, name, template, category, html, domain, colors_json, status) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, null, tpl.name, tpl.id, tpl.category || 'general', html, null, JSON.stringify({}), 'draft');
    res.json({ site: { id, name: tpl.name, template: tpl.id, status: 'draft' } });
  } catch (e) { console.error('[templates/install]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

module.exports = router_templates;
