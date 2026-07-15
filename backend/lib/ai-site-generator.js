// ═══════════════════════════════════════════════════════════════════
// MINE — AI Site HTML Generator (v1)
//
// Produces a full, responsive HTML site from onboarding data.
// Uses a hybrid approach: structural templates (reliable) + AI-filled
// content blocks (rich). Integrates with mine-store.js runtime via
// data-mine-* attributes on products, bookings, and forms.
//
// Entry point: generateSiteHTML(siteSpec) → string
//
// siteSpec shape:
//   {
//     businessName, businessType, description, targetAudience,
//     tagline, heroText, aboutText,
//     products: [{id, name, price, description}],
//     bookingType: {id, name, duration, description},
//     primaryColor, secondaryColor,
//     designStyle,
//     features: ['products', 'bookings', 'chatbot', 'email', ...]
//   }
// ═══════════════════════════════════════════════════════════════════

const STYLE_TOKENS = {
  minimal: {
    font: "'Inter', system-ui, sans-serif",
    headingFont: "'Inter', system-ui, sans-serif",
    radius: '2px',
    heroBg: 'linear-gradient(180deg, #fafafa 0%, #fff 100%)',
    cardBg: '#fff',
    cardShadow: '0 1px 2px rgba(0,0,0,.04)',
    cardBorder: '1px solid #f0f0f0',
    accent: '#000',
    textDim: '#666',
    spacing: '80px',
    buttonStyle: 'background:#000;color:#fff;padding:12px 28px;border-radius:2px;font-weight:500;border:none;',
  },
  luxury: {
    font: "'Cormorant Garamond', Georgia, serif",
    headingFont: "'Cormorant Garamond', Georgia, serif",
    radius: '0px',
    heroBg: '#0e0e0e',
    heroText: '#fff',
    cardBg: '#1a1a1a',
    cardShadow: '0 8px 32px rgba(201,169,110,.15)',
    cardBorder: '1px solid #2a2a2a',
    accent: '#C9A96E',
    textDim: '#aaa',
    spacing: '120px',
    bg: '#0e0e0e',
    text: '#fff',
    buttonStyle: 'background:transparent;color:#C9A96E;padding:14px 36px;border:1px solid #C9A96E;letter-spacing:2px;text-transform:uppercase;font-size:13px;',
  },
  tech: {
    font: "'JetBrains Mono', 'Fira Code', monospace",
    headingFont: "'Space Grotesk', sans-serif",
    radius: '8px',
    heroBg: 'radial-gradient(circle at 20% 30%, rgba(0,255,200,.15), transparent 50%), #0A0A0F',
    heroText: '#fff',
    cardBg: 'rgba(255,255,255,0.03)',
    cardShadow: '0 0 24px rgba(0,255,200,.08)',
    cardBorder: '1px solid rgba(0,255,200,.2)',
    accent: '#00FFC8',
    textDim: '#8a8a9a',
    spacing: '100px',
    bg: '#0A0A0F',
    text: '#e4e4e7',
    buttonStyle: 'background:#00FFC8;color:#0A0A0F;padding:14px 32px;border-radius:8px;font-weight:700;font-family:inherit;border:none;box-shadow:0 0 20px rgba(0,255,200,.4);',
  },
  playful: {
    font: "'Fraunces', Georgia, serif",
    headingFont: "'Fraunces', Georgia, serif",
    radius: '24px',
    heroBg: 'linear-gradient(135deg, #FFD93D 0%, #FF6B9D 50%, #C147E9 100%)',
    heroText: '#0A0A0F',
    cardBg: '#fff',
    cardShadow: '0 12px 32px rgba(193,71,233,.18)',
    cardBorder: '3px solid #0A0A0F',
    accent: '#C147E9',
    textDim: '#555',
    spacing: '100px',
    buttonStyle: 'background:#0A0A0F;color:#FFD93D;padding:16px 36px;border-radius:100px;font-weight:700;border:none;transform:rotate(-2deg);display:inline-block;',
  },
  brutalist: {
    font: "'Space Mono', monospace",
    headingFont: "'Space Mono', monospace",
    radius: '0px',
    heroBg: '#fff',
    cardBg: '#fff',
    cardShadow: '6px 6px 0 #000',
    cardBorder: '3px solid #000',
    accent: '#FF3D00',
    textDim: '#222',
    spacing: '100px',
    buttonStyle: 'background:#000;color:#fff;padding:14px 28px;border:3px solid #000;box-shadow:4px 4px 0 #FF3D00;font-family:inherit;font-weight:700;text-transform:uppercase;',
  },
  editorial: {
    font: "'Lora', Georgia, serif",
    headingFont: "'Playfair Display', Georgia, serif",
    radius: '0px',
    heroBg: '#f8f5ef',
    cardBg: '#fff',
    cardShadow: '0 1px 3px rgba(0,0,0,.08)',
    cardBorder: '1px solid #e8e3d9',
    accent: '#2a2a2a',
    textDim: '#666',
    spacing: '120px',
    buttonStyle: 'background:#2a2a2a;color:#fff;padding:14px 32px;font-family:inherit;font-weight:400;letter-spacing:1px;border:none;',
  },
  organic: {
    font: "'Nunito', system-ui, sans-serif",
    headingFont: "'Nunito', system-ui, sans-serif",
    radius: '32px',
    heroBg: 'linear-gradient(135deg, #F5E6D3 0%, #E8D4B8 100%)',
    cardBg: '#FDF8F3',
    cardShadow: '0 8px 24px rgba(139,94,60,.12)',
    cardBorder: 'none',
    accent: '#8B5E3C',
    textDim: '#6b5b4c',
    spacing: '100px',
    buttonStyle: 'background:#8B5E3C;color:#FDF8F3;padding:14px 36px;border-radius:100px;font-weight:600;border:none;',
  },
  retro: {
    font: "'Rubik', system-ui, sans-serif",
    headingFont: "'Rubik', system-ui, sans-serif",
    radius: '12px',
    heroBg: 'linear-gradient(180deg, #D4A574 0%, #C97B4C 100%)',
    heroText: '#2A1810',
    cardBg: '#F5E6D3',
    cardShadow: '4px 4px 0 #8B5A2B',
    cardBorder: '3px solid #8B5A2B',
    accent: '#C97B4C',
    textDim: '#5a4535',
    spacing: '100px',
    buttonStyle: 'background:#2A1810;color:#F5E6D3;padding:14px 28px;border:3px solid #8B5A2B;border-radius:12px;font-weight:700;',
  },
  corporate: {
    font: "'Inter', system-ui, sans-serif",
    headingFont: "'Inter', system-ui, sans-serif",
    radius: '8px',
    heroBg: 'linear-gradient(180deg, #0052CC 0%, #003D99 100%)',
    heroText: '#fff',
    cardBg: '#fff',
    cardShadow: '0 4px 12px rgba(0,82,204,.1)',
    cardBorder: '1px solid #e5e7eb',
    accent: '#0052CC',
    textDim: '#4b5563',
    spacing: '90px',
    buttonStyle: 'background:#0052CC;color:#fff;padding:12px 28px;border-radius:8px;font-weight:600;border:none;',
  },
  glassmorphic: {
    font: "'Inter', system-ui, sans-serif",
    headingFont: "'Inter', system-ui, sans-serif",
    radius: '20px',
    heroBg: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    heroText: '#fff',
    cardBg: 'rgba(255,255,255,0.15)',
    cardShadow: '0 8px 32px rgba(31,38,135,.2)',
    cardBorder: '1px solid rgba(255,255,255,.3)',
    accent: '#667eea',
    textDim: 'rgba(255,255,255,.7)',
    spacing: '100px',
    bg: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    text: '#fff',
    buttonStyle: 'background:rgba(255,255,255,.2);color:#fff;padding:14px 32px;border-radius:20px;backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.3);font-weight:600;',
  },
};

// Helper: escape HTML special chars
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Helper: price formatting (consistent with mine-store.js expectations)
function fmtPrice(n, currency = 'USD') {
  const symbols = { USD: '$', EUR: '€', GBP: '£', AUD: 'A$', CAD: 'C$' };
  const sym = symbols[currency.toUpperCase()] || '$';
  return `${sym}${Number(n).toFixed(2)}`;
}

// ─── Section builders ─────────────────────────────────────────────────

function buildNav(spec, tokens) {
  const sections = [];
  if (spec.features?.includes('products') && spec.products?.length) sections.push({ href: '#products', label: spec.businessType === 'service' ? 'Services' : 'Shop' });
  if (spec.features?.includes('bookings') && spec.bookingType) sections.push({ href: '#book', label: 'Book' });
  sections.push({ href: '#about', label: 'About' });
  sections.push({ href: '#contact', label: 'Contact' });
  const navBg = tokens.bg === '#0A0A0F' || tokens.bg === '#0e0e0e' ? 'rgba(10,10,15,0.8)' : 'rgba(255,255,255,0.85)';
  const navText = tokens.text === '#fff' || tokens.text === '#e4e4e7' ? '#fff' : '#111';
  return `
<nav style="position:sticky;top:0;z-index:100;backdrop-filter:blur(12px);background:${navBg};padding:16px 32px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(0,0,0,.05)">
  <a href="#top" style="font-family:${tokens.headingFont};font-weight:700;font-size:20px;color:${navText};text-decoration:none">${esc(spec.businessName)}</a>
  <div class="nav-links" style="display:flex;gap:28px;align-items:center">
    ${sections.map(s => `<a href="${s.href}" style="color:${navText};text-decoration:none;font-size:14px;font-weight:500;opacity:.8">${esc(s.label)}</a>`).join('')}
    ${spec.features?.includes('products') && spec.products?.length ? `<button data-mine-open-cart style="background:none;border:none;cursor:pointer;position:relative;font-size:20px;color:${navText}">🛒<span data-mine-cart-count style="position:absolute;top:-4px;right:-4px;background:${tokens.accent};color:#fff;border-radius:50%;width:18px;height:18px;font-size:10px;display:none;align-items:center;justify-content:center;font-weight:700">0</span></button>` : ''}
  </div>
</nav>`;
}

function buildHero(spec, tokens) {
  const heroText = tokens.heroText || tokens.text || '#111';
  const heroDim = heroText === '#fff' ? 'rgba(255,255,255,.7)' : tokens.textDim;
  return `
<section id="top" class="hero" style="padding:${tokens.spacing} clamp(20px,5vw,48px);background:${tokens.heroBg};color:${heroText};text-align:center;position:relative;overflow:hidden">
  <div style="max-width:900px;margin:0 auto;position:relative;z-index:2">
    <div style="font-size:13px;font-weight:600;color:${tokens.accent};margin-bottom:20px;letter-spacing:2px;text-transform:uppercase">${esc(spec.businessType || 'Welcome')}</div>
    <h1 style="font-family:${tokens.headingFont};font-size:clamp(36px,6vw,72px);line-height:1.1;margin-bottom:24px;font-weight:${tokens.headingFont.includes('Space Mono') || tokens.headingFont.includes('Cormorant') ? '400' : '700'}">${esc(spec.tagline || spec.businessName)}</h1>
    <p style="font-size:clamp(16px,2vw,20px);line-height:1.6;color:${heroDim};margin-bottom:40px;max-width:640px;margin-left:auto;margin-right:auto">${esc(spec.heroText || spec.description || '')}</p>
    <div class="flex-row" style="display:flex;gap:16px;justify-content:center;flex-wrap:wrap">
      ${spec.features?.includes('products') && spec.products?.length ? `<a href="#products" style="${tokens.buttonStyle};text-decoration:none;display:inline-block">Explore</a>` : ''}
      ${spec.features?.includes('bookings') && spec.bookingType ? `<a href="#book" style="${tokens.buttonStyle};text-decoration:none;display:inline-block;${spec.features?.includes('products') ? 'background:transparent;color:' + (heroText === '#fff' ? '#fff' : '#111') + ';border:2px solid ' + (heroText === '#fff' ? '#fff' : '#111') + ';' : ''}">Book Now</a>` : ''}
      ${!spec.features?.includes('products') && !spec.features?.includes('bookings') ? `<a href="#contact" style="${tokens.buttonStyle};text-decoration:none;display:inline-block">Get in Touch</a>` : ''}
    </div>
  </div>
</section>`;
}

function buildFeatures(spec, tokens, features) {
  if (!features || !features.length) return '';
  return `
<section style="padding:${tokens.spacing} clamp(20px,5vw,48px);background:${tokens.bg || '#fff'};color:${tokens.text || '#111'}">
  <div style="max-width:1200px;margin:0 auto">
    <div style="text-align:center;margin-bottom:60px">
      <div style="font-size:13px;font-weight:600;color:${tokens.accent};margin-bottom:12px;letter-spacing:2px;text-transform:uppercase">What We Offer</div>
      <h2 style="font-family:${tokens.headingFont};font-size:clamp(28px,4vw,44px);line-height:1.2">${esc(spec.featuresHeading || 'Why choose us')}</h2>
    </div>
    <div class="grid-3" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:32px">
      ${features.map(f => `
        <div style="background:${tokens.cardBg};border:${tokens.cardBorder};box-shadow:${tokens.cardShadow};border-radius:${tokens.radius};padding:32px">
          <div style="font-size:32px;margin-bottom:16px">${esc(f.icon || '✨')}</div>
          <h3 style="font-family:${tokens.headingFont};font-size:20px;margin-bottom:12px">${esc(f.title)}</h3>
          <p style="color:${tokens.textDim};line-height:1.6;font-size:15px">${esc(f.description)}</p>
        </div>
      `).join('')}
    </div>
  </div>
</section>`;
}

function buildProducts(spec, tokens) {
  if (!spec.features?.includes('products') || !spec.products?.length) return '';
  const productLabel = spec.businessType === 'service' ? 'Services' : spec.businessType === 'courses' ? 'Courses' : 'Shop';
  return `
<section id="products" style="padding:${tokens.spacing} clamp(20px,5vw,48px);background:${tokens.bg || '#fafafa'};color:${tokens.text || '#111'}">
  <div style="max-width:1200px;margin:0 auto">
    <div style="text-align:center;margin-bottom:60px">
      <div style="font-size:13px;font-weight:600;color:${tokens.accent};margin-bottom:12px;letter-spacing:2px;text-transform:uppercase">${esc(productLabel)}</div>
      <h2 style="font-family:${tokens.headingFont};font-size:clamp(28px,4vw,44px);line-height:1.2">${esc(spec.productsHeading || 'Our offerings')}</h2>
    </div>
    <div class="grid-3" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:28px">
      ${spec.products.map(p => `
        <article style="background:${tokens.cardBg};border:${tokens.cardBorder};box-shadow:${tokens.cardShadow};border-radius:${tokens.radius};padding:28px;display:flex;flex-direction:column">
          <div style="width:100%;aspect-ratio:1;border-radius:${tokens.radius};background:linear-gradient(135deg,${tokens.accent}22,${tokens.accent}08);display:flex;align-items:center;justify-content:center;font-size:48px;margin-bottom:20px">${esc((p.emoji || '📦'))}</div>
          <h3 style="font-family:${tokens.headingFont};font-size:20px;margin-bottom:8px">${esc(p.name)}</h3>
          <p style="color:${tokens.textDim};font-size:14px;line-height:1.6;margin-bottom:20px;flex:1">${esc(p.description || '')}</p>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:auto">
            <div style="font-size:22px;font-weight:700;color:${tokens.accent};font-family:${tokens.headingFont}">${fmtPrice(p.price, spec.currency)}</div>
            <button data-mine-add-to-cart data-mine-id="${esc(p.id)}" data-mine-name="${esc(p.name)}" data-mine-price="${p.price}" style="${tokens.buttonStyle};cursor:pointer">Add to Cart</button>
          </div>
        </article>
      `).join('')}
    </div>
  </div>
</section>`;
}

function buildBooking(spec, tokens) {
  if (!spec.features?.includes('bookings') || !spec.bookingType) return '';
  const b = spec.bookingType;
  return `
<section id="book" style="padding:${tokens.spacing} clamp(20px,5vw,48px);background:${tokens.bg || '#fff'};color:${tokens.text || '#111'}">
  <div style="max-width:720px;margin:0 auto;text-align:center">
    <div style="font-size:13px;font-weight:600;color:${tokens.accent};margin-bottom:12px;letter-spacing:2px;text-transform:uppercase">Book</div>
    <h2 style="font-family:${tokens.headingFont};font-size:clamp(28px,4vw,44px);line-height:1.2;margin-bottom:16px">${esc(b.name)}</h2>
    <p style="color:${tokens.textDim};font-size:17px;line-height:1.6;margin-bottom:40px">${esc(b.description || `Schedule a ${b.duration}-minute session`)}</p>
    <div style="background:${tokens.cardBg};border:${tokens.cardBorder};box-shadow:${tokens.cardShadow};border-radius:${tokens.radius};padding:32px;text-align:left">
      <form data-mine-booking-form data-mine-type="${esc(b.id)}">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:16px">
          <div>
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Your name</label>
            <input name="name" required style="width:100%;padding:12px 14px;border:1px solid #e5e7eb;border-radius:${tokens.radius};font-family:inherit;font-size:15px">
          </div>
          <div>
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Email</label>
            <input name="email" type="email" required style="width:100%;padding:12px 14px;border:1px solid #e5e7eb;border-radius:${tokens.radius};font-family:inherit;font-size:15px">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:16px">
          <div>
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Preferred date</label>
            <input name="date" type="date" required style="width:100%;padding:12px 14px;border:1px solid #e5e7eb;border-radius:${tokens.radius};font-family:inherit;font-size:15px">
          </div>
          <div>
            <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Preferred time</label>
            <input name="time" type="time" required style="width:100%;padding:12px 14px;border:1px solid #e5e7eb;border-radius:${tokens.radius};font-family:inherit;font-size:15px">
          </div>
        </div>
        <div style="margin-bottom:20px">
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Notes (optional)</label>
          <textarea name="notes" rows="3" style="width:100%;padding:12px 14px;border:1px solid #e5e7eb;border-radius:${tokens.radius};font-family:inherit;font-size:15px;resize:vertical"></textarea>
        </div>
        <button type="submit" data-mine-book style="${tokens.buttonStyle};width:100%;cursor:pointer;font-size:16px">Request Booking</button>
      </form>
    </div>
  </div>
</section>`;
}

function buildAbout(spec, tokens) {
  return `
<section id="about" style="padding:${tokens.spacing} clamp(20px,5vw,48px);background:${tokens.bg || '#fafafa'};color:${tokens.text || '#111'}">
  <div style="max-width:860px;margin:0 auto">
    <div style="text-align:center">
      <div style="font-size:13px;font-weight:600;color:${tokens.accent};margin-bottom:12px;letter-spacing:2px;text-transform:uppercase">About</div>
      <h2 style="font-family:${tokens.headingFont};font-size:clamp(28px,4vw,44px);line-height:1.2;margin-bottom:32px">${esc(spec.aboutHeading || `About ${spec.businessName}`)}</h2>
      <p style="font-size:clamp(16px,2vw,19px);line-height:1.8;color:${tokens.textDim}">${esc(spec.aboutText || '')}</p>
    </div>
  </div>
</section>`;
}

function buildFAQ(spec, tokens, faqs) {
  if (!faqs || !faqs.length) return '';
  return `
<section style="padding:${tokens.spacing} clamp(20px,5vw,48px);background:${tokens.bg || '#fff'};color:${tokens.text || '#111'}">
  <div style="max-width:780px;margin:0 auto">
    <div style="text-align:center;margin-bottom:48px">
      <div style="font-size:13px;font-weight:600;color:${tokens.accent};margin-bottom:12px;letter-spacing:2px;text-transform:uppercase">FAQ</div>
      <h2 style="font-family:${tokens.headingFont};font-size:clamp(28px,4vw,44px);line-height:1.2">Frequently asked</h2>
    </div>
    <div style="display:flex;flex-direction:column;gap:12px">
      ${faqs.map(f => `
        <details style="background:${tokens.cardBg};border:${tokens.cardBorder};border-radius:${tokens.radius};padding:20px 24px">
          <summary style="cursor:pointer;font-weight:600;font-size:16px;font-family:${tokens.headingFont};list-style:none;display:flex;justify-content:space-between;align-items:center">
            <span>${esc(f.q)}</span>
            <span style="color:${tokens.accent};font-size:20px;transition:transform .2s">+</span>
          </summary>
          <p style="color:${tokens.textDim};line-height:1.6;margin-top:16px;font-size:15px">${esc(f.a)}</p>
        </details>
      `).join('')}
    </div>
  </div>
</section>
<style>details[open] summary span:last-child { transform:rotate(45deg); }</style>`;
}

function buildContact(spec, tokens) {
  return `
<section id="contact" style="padding:${tokens.spacing} clamp(20px,5vw,48px);background:${tokens.heroBg};color:${tokens.heroText || tokens.text || '#111'};text-align:center">
  <div style="max-width:640px;margin:0 auto">
    <h2 style="font-family:${tokens.headingFont};font-size:clamp(28px,4vw,44px);line-height:1.2;margin-bottom:16px">${esc(spec.contactHeading || 'Get in touch')}</h2>
    <p style="font-size:clamp(16px,2vw,19px);line-height:1.6;margin-bottom:32px;opacity:.85">${esc(spec.contactText || `Questions? We're here to help.`)}</p>
    <form data-mine-form style="display:flex;flex-direction:column;gap:12px;max-width:480px;margin:0 auto;text-align:left">
      <input name="name" placeholder="Your name" required style="padding:14px 16px;border:1px solid rgba(0,0,0,.15);border-radius:${tokens.radius};font-family:inherit;font-size:15px;background:${tokens.cardBg};color:${tokens.text || '#111'}">
      <input name="email" type="email" placeholder="Your email" required style="padding:14px 16px;border:1px solid rgba(0,0,0,.15);border-radius:${tokens.radius};font-family:inherit;font-size:15px;background:${tokens.cardBg};color:${tokens.text || '#111'}">
      <textarea name="message" placeholder="Your message" rows="4" required style="padding:14px 16px;border:1px solid rgba(0,0,0,.15);border-radius:${tokens.radius};font-family:inherit;font-size:15px;resize:vertical;background:${tokens.cardBg};color:${tokens.text || '#111'}"></textarea>
      <button type="submit" style="${tokens.buttonStyle};cursor:pointer;font-size:16px;margin-top:8px">Send message</button>
    </form>
  </div>
</section>`;
}

function buildFooter(spec, tokens) {
  const year = new Date().getFullYear();
  return `
<footer style="padding:40px clamp(20px,5vw,48px);background:${tokens.text === '#fff' ? '#000' : '#0a0a0a'};color:rgba(255,255,255,.7);text-align:center;font-size:14px">
  <div style="max-width:1200px;margin:0 auto">
    <div style="font-family:${tokens.headingFont};font-size:18px;font-weight:700;color:#fff;margin-bottom:8px">${esc(spec.businessName)}</div>
    <p style="opacity:.6;margin-bottom:16px">© ${year} ${esc(spec.businessName)}. All rights reserved.</p>
  </div>
</footer>`;
}

// ─── AI content enrichment (second Claude call) ────────────────────────
async function enrichContentWithAI(spec, claudeKey) {
  if (!claudeKey) return { features: null, faqs: null };
  try {
    const fetch = (await import('node-fetch')).default;
    const prompt = `You are generating enriched content for a business website. Given this business, return JSON with 3 features and 4 FAQs that would resonate with this specific business type and audience.

Business: ${spec.businessName}
Type: ${spec.businessType}
Description: ${spec.description || ''}
Target audience: ${spec.targetAudience || 'general'}

Return ONLY this JSON structure, no markdown:
{
  "features": [
    {"icon": "relevant emoji", "title": "short feature title (3-5 words)", "description": "1-2 sentence description specific to this business"},
    {"icon": "emoji", "title": "title", "description": "description"},
    {"icon": "emoji", "title": "title", "description": "description"}
  ],
  "faqs": [
    {"q": "realistic customer question", "a": "concise helpful answer (1-3 sentences)"},
    {"q": "question", "a": "answer"},
    {"q": "question", "a": "answer"},
    {"q": "question", "a": "answer"}
  ]
}`;

    // Hard 30s timeout — don't let a hung Claude call block onboarding indefinitely
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': claudeKey,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL_CONTENT || 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!resp.ok) return { features: null, faqs: null };
    const data = await resp.json();
    const text = data.content?.[0]?.text || '';
    const match = text.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/);
    if (!match) return { features: null, faqs: null };
    const parsed = JSON.parse(match[0]);
    return {
      features: Array.isArray(parsed.features) ? parsed.features.slice(0, 3) : null,
      faqs: Array.isArray(parsed.faqs) ? parsed.faqs.slice(0, 6) : null,
    };
  } catch (e) {
    return { features: null, faqs: null };
  }
}

// ─── Main entry point ─────────────────────────────────────────────────
async function generateAISiteHTML(spec, claudeKey) {
  const style = STYLE_TOKENS[spec.designStyle] || STYLE_TOKENS.minimal;

  // Resolve per-site colour overrides if provided
  const tokens = { ...style };
  if (spec.primaryColor && /^#[0-9a-fA-F]{3,8}$/.test(spec.primaryColor)) {
    tokens.accent = spec.primaryColor;
  }

  // Fallback features (used if AI enrichment fails)
  const fallbackFeatures = [
    { icon: '✨', title: 'Quality service', description: `We pride ourselves on delivering exceptional ${spec.businessType || 'results'} every time.` },
    { icon: '⚡', title: 'Fast & reliable', description: 'Quick response times and dependable service you can count on.' },
    { icon: '💬', title: 'Real support', description: `Have questions? Reach out — a real person will get back to you.` },
  ];
  const fallbackFaqs = [
    { q: `How do I get started with ${spec.businessName}?`, a: `Browse our ${spec.features?.includes('products') ? 'offerings' : 'site'} and ${spec.features?.includes('bookings') ? 'book a time to chat' : 'reach out via the contact form'} — we'll take it from there.` },
    { q: 'What payment methods do you accept?', a: 'We accept all major credit and debit cards via secure checkout. Payment is only taken on confirmed orders.' },
    { q: 'How quickly will I hear back?', a: 'We respond to enquiries within one business day, usually sooner.' },
    { q: 'Do you offer refunds?', a: 'Please reach out via the contact form with your question and we\'ll work with you on a case-by-case basis.' },
  ];

  // Attempt AI enrichment (non-blocking — falls back if it fails)
  const enriched = await enrichContentWithAI(spec, claudeKey);
  const features = enriched.features || fallbackFeatures;
  const faqs = enriched.faqs || fallbackFaqs;

  // Compose
  const body = [
    buildNav(spec, tokens),
    buildHero(spec, tokens),
    buildFeatures(spec, tokens, features),
    buildProducts(spec, tokens),
    buildBooking(spec, tokens),
    buildAbout(spec, tokens),
    buildFAQ(spec, tokens, faqs),
    buildContact(spec, tokens),
    buildFooter(spec, tokens),
  ].filter(Boolean).join('\n');

  const pageBg = tokens.bg || '#fff';
  const pageText = tokens.text || '#111';

  // Return BODY CONTENT ONLY — hosting.js wraps this in the full document shell.
  // We include fonts via @import at the top of our style block (valid HTML5),
  // and we set body font/bg via CSS so hosting.js's outer <body> inherits our styling.
  return `<style>
@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Cormorant+Garamond:wght@400;600&family=Space+Mono:wght@400;700&family=Space+Grotesk:wght@400;700&family=JetBrains+Mono:wght@400;700&family=Fraunces:wght@400;700&family=Playfair+Display:wght@400;700&family=Lora:wght@400;600&family=Nunito:wght@400;600;700&family=Rubik:wght@400;600;700&display=swap");
body { font-family: ${tokens.font}; color: ${pageText}; background: ${pageBg}; -webkit-font-smoothing: antialiased; }
a { color: inherit; }
button { font-family: inherit; cursor: pointer; }
details summary::-webkit-details-marker { display: none; }
@media (max-width:640px) {
  nav .nav-links a { display: none; }
  nav .nav-links a:last-child { display: inline; }
}
</style>
${body}`;
}

module.exports = { generateAISiteHTML, STYLE_TOKENS };
