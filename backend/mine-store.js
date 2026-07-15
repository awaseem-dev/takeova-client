// ═══════════════════════════════════════════════════════════════════
// MINE STORE — auto-injected into every generated site
// Wires up: cart, checkout, bookings, course purchases
// Reads data-mine-* attributes that the AI/editor puts on elements
// ═══════════════════════════════════════════════════════════════════
(function(){
'use strict';

var SITE_ID  = window.MINE_SITE_ID  || '';
var API_BASE = window.MINE_API_BASE || '';
var CURRENCY = window.MINE_CURRENCY || 'USD';

// ── Cart state ────────────────────────────────────────────────────
var cart = { items: [], siteId: SITE_ID };
try { var saved = sessionStorage.getItem('mine_cart_' + SITE_ID); if (saved) cart = JSON.parse(saved); } catch(e){}

function saveCart(){ try { sessionStorage.setItem('mine_cart_' + SITE_ID, JSON.stringify(cart)); } catch(e){} }
function cartCount(){ return cart.items.reduce(function(s,i){ return s + (i.qty||1); }, 0); }
function cartTotal(){ return cart.items.reduce(function(s,i){ return s + (i.price||0) * (i.qty||1); }, 0); }

// ── Cart UI ───────────────────────────────────────────────────────
function getCartEl(){ return document.getElementById('mine-cart-panel'); }

function renderCart(){
  var panel = getCartEl();
  if (!panel) return;
  var count = cartCount();
  var total = cartTotal();

  // Update all cart count badges
  document.querySelectorAll('[data-mine-cart-count]').forEach(function(el){
    el.textContent = count;
    el.style.display = count > 0 ? 'inline-flex' : 'none';
  });

  if (!panel.classList.contains('open')) return;

  panel.innerHTML =
    '<div style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:99998" id="mine-cart-overlay"></div>' +
    '<div style="position:fixed;top:0;right:0;bottom:0;width:min(400px,100vw);background:#fff;z-index:99999;display:flex;flex-direction:column;box-shadow:-4px 0 24px rgba(0,0,0,.15)">' +
      '<div style="padding:18px 20px;border-bottom:1px solid #F1F5F9;display:flex;align-items:center;justify-content:space-between">' +
        '<div style="font-weight:800;font-size:16px">Your Cart (' + count + ')</div>' +
        '<button data-mine-close-cart style="border:none;background:none;font-size:24px;color:#94A3B8;cursor:pointer;line-height:1;padding:0">&times;</button>' +
      '</div>' +
      '<div style="flex:1;overflow-y:auto;padding:16px">' +
        (cart.items.length === 0 ?
          '<div style="text-align:center;padding:48px 20px;color:#94A3B8"><div style="font-size:40px;margin-bottom:12px">🛒</div><div style="font-weight:600;font-size:14px">Your cart is empty</div></div>' :
          cart.items.map(function(item, idx){
            return '<div style="display:flex;gap:12px;padding:14px 0;border-bottom:1px solid #F1F5F9">' +
              '<div style="flex:1"><div style="font-size:14px;font-weight:700;color:#111827;margin-bottom:2px">' + item.name + '</div>' +
                '<div style="font-size:13px;color:#6B7280">$' + (item.price||0).toFixed(2) + ' × ' + (item.qty||1) + '</div></div>' +
              '<div style="display:flex;align-items:center;gap:8px">' +
                '<button data-mine-qty="' + idx + '" data-mine-delta="-1" style="width:26px;height:26px;border-radius:50%;border:1.5px solid #E5E7EB;background:#fff;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;font-family:inherit">-</button>' +
                '<span style="font-size:14px;font-weight:700;min-width:20px;text-align:center">' + (item.qty||1) + '</span>' +
                '<button data-mine-qty="' + idx + '" data-mine-delta="1" style="width:26px;height:26px;border-radius:50%;border:1.5px solid #E5E7EB;background:#fff;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;font-family:inherit">+</button>' +
              '</div>' +
            '</div>';
          }).join('')
        ) +
      '</div>' +
      '<div style="padding:16px 20px;border-top:1px solid #F1F5F9">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">' +
          '<div style="font-size:14px;color:#6B7280">Total</div>' +
          '<div style="font-size:18px;font-weight:800;color:#111827">$' + total.toFixed(2) + '</div>' +
        '</div>' +
        '<input id="mine-cart-email" type="email" placeholder="Your email address" style="width:100%;padding:11px 13px;border:1.5px solid #E5E7EB;border-radius:9px;font-size:14px;box-sizing:border-box;margin-bottom:10px;font-family:inherit;outline:none">' +
        '<button data-mine-checkout style="width:100%;padding:14px;background:linear-gradient(135deg,#2563EB,#7C3AED);color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit">' +
          (count > 0 ? 'Checkout — $' + total.toFixed(2) : 'Cart is empty') +
        '</button>' +
        '<div id="mine-checkout-status" style="font-size:12px;color:#6B7280;text-align:center;margin-top:8px"></div>' +
      '</div>' +
    '</div>';
  
  document.getElementById('mine-cart-overlay').addEventListener('click', closeCart);
}

function openCart(){
  var panel = getCartEl();
  if (!panel) { createCartPanel(); } else { panel.classList.add('open'); }
  renderCart();
}

function closeCart(){
  var panel = getCartEl();
  if (panel) { panel.classList.remove('open'); panel.innerHTML = ''; }
}

function createCartPanel(){
  var div = document.createElement('div');
  div.id = 'mine-cart-panel';
  div.classList.add('open');
  document.body.appendChild(div);
}

// ── Add to cart ───────────────────────────────────────────────────
function addToCart(name, price, type, id){
  var existing = cart.items.find(function(i){ return i.name === name; });
  if (existing) { existing.qty = (existing.qty||1) + 1; }
  else { cart.items.push({ name: name, price: parseFloat(price)||0, type: type||'physical', id: id||'', qty: 1 }); }
  saveCart();
  renderCart();
  openCart();
  showAddedToast(name);
}

function showAddedToast(name){
  var t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#111827;color:#fff;padding:12px 20px;border-radius:10px;font-size:14px;font-weight:600;z-index:999999;pointer-events:none;transition:opacity .3s';
  t.textContent = '✅ ' + name + ' added to cart';
  document.body.appendChild(t);
  setTimeout(function(){ t.style.opacity='0'; setTimeout(function(){ t.remove(); }, 300); }, 2200);
}

// ── Checkout ──────────────────────────────────────────────────────
async function checkout(){
  var emailEl = document.getElementById('mine-cart-email');
  var email = emailEl && emailEl.value.trim();
  if (!email || !email.includes('@')) {
    if (emailEl) { emailEl.style.borderColor='#EF4444'; emailEl.focus(); }
    showStatus('Please enter your email address', 'error');
    return;
  }
  if (cart.items.length === 0) return;

  var btn = document.querySelector('[data-mine-checkout]');
  var origText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Processing...'; }
  showStatus('Creating secure checkout...', '');

  try {
    var r = await fetch(API_BASE + '/api/payments/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteId: SITE_ID,
        items: cart.items.map(function(i){ return { name:i.name, price:i.price, quantity:i.qty||1, type:i.type||'physical' }; }),
        customerEmail: email,
      })
    });
    var data = await r.json();
    if (data.url) {
      cart.items = []; saveCart();
      window.location.href = data.url; // Stripe checkout page
    } else {
      showStatus(data.error || 'Checkout failed — please try again', 'error');
      if (btn) { btn.disabled = false; btn.textContent = origText; }
    }
  } catch(e) {
    showStatus('Connection error — please try again', 'error');
    if (btn) { btn.disabled = false; btn.textContent = origText; }
  }
}

function showStatus(msg, type){
  var el = document.getElementById('mine-checkout-status');
  if (el) { el.textContent = msg; el.style.color = type === 'error' ? '#EF4444' : '#6B7280'; }
}

// ── Booking form ──────────────────────────────────────────────────
async function submitBooking(form){
  var btn = form.querySelector('[type=submit],[data-mine-book]');
  if (btn) { btn.disabled = true; btn.textContent = 'Booking...'; }

  var data = {
    siteId: SITE_ID,
    service: form.querySelector('[name=service],[data-field=service]') && form.querySelector('[name=service],[data-field=service]').value,
    customerName: (form.querySelector('[name=name],[name=customer_name],[type=text]') || {}).value || '',
    customerEmail: (form.querySelector('[type=email]') || {}).value || '',
    customerPhone: (form.querySelector('[type=tel]') || {}).value || '',
    date: (form.querySelector('[type=date]') || {}).value || '',
    time: (form.querySelector('[type=time]') || {}).value || '',
    notes: (form.querySelector('textarea') || {}).value || '',
  };

  try {
    var r = await fetch(API_BASE + '/api/public/book/' + SITE_ID, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    var res = await r.json();
    if (res.id || res.booking) {
      form.innerHTML = '<div style="text-align:center;padding:32px 20px"><div style="font-size:48px;margin-bottom:12px">✅</div><div style="font-size:18px;font-weight:800;margin-bottom:8px">Booking confirmed!</div><div style="font-size:14px;color:#6B7280">Check your email for confirmation details.</div></div>';
    } else {
      if (btn) { btn.disabled = false; btn.textContent = 'Book Now'; }
      alert(res.error || 'Booking failed — please try again');
    }
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Book Now'; }
    alert('Connection error — please try again');
  }
}

// ── Course purchase ───────────────────────────────────────────────
async function buyCourse(courseId, courseName, price){
  var email = prompt('Enter your email to purchase "' + courseName + '" for $' + price);
  if (!email || !email.includes('@')) return;

  var btn = document.querySelector('[data-mine-course="' + courseId + '"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Processing...'; }

  try {
    var r = await fetch(API_BASE + '/api/payments/course-checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId: courseId, customerEmail: email })
    });
    var data = await r.json();
    if (data.url) { window.location.href = data.url; }
    else if (data.enrolled) { alert('You are already enrolled! Check your email for access.'); }
    else { alert(data.error || 'Failed — please try again'); if(btn){btn.disabled=false;btn.textContent='Enrol Now';} }
  } catch(e) {
    alert('Connection error — please try again');
    if(btn){btn.disabled=false;btn.textContent='Enrol Now';}
  }
}

// ── Event-level delegation — wire ALL buttons ─────────────────────
document.addEventListener('click', function(e){
  var el = e.target;

  // Cart open
  if (el.closest('[data-mine-open-cart]')) { e.preventDefault(); openCart(); return; }

  // Cart close
  if (el.closest('[data-mine-close-cart]')) { closeCart(); return; }

  // Qty change
  var qtyBtn = el.closest('[data-mine-qty]');
  if (qtyBtn) {
    var idx = parseInt(qtyBtn.getAttribute('data-mine-qty'));
    var delta = parseInt(qtyBtn.getAttribute('data-mine-delta'));
    if (cart.items[idx]) {
      cart.items[idx].qty = Math.max(0, (cart.items[idx].qty||1) + delta);
      if (cart.items[idx].qty === 0) cart.items.splice(idx, 1);
      saveCart(); renderCart();
    }
    return;
  }

  // Checkout
  if (el.closest('[data-mine-checkout]')) { checkout(); return; }

  // Add to cart — matches any button with data-mine-product or common patterns
  var addBtn = el.closest('[data-mine-product],[data-mine-add-to-cart]') ||
    ((/add to cart|buy now|add to bag/i.test(el.textContent.trim())) ? el : null);
  if (addBtn) {
    e.preventDefault();
    var name  = addBtn.getAttribute('data-mine-product') || addBtn.getAttribute('data-name') ||
                addBtn.closest('[data-mine-name]')?.getAttribute('data-mine-name') ||
                addBtn.closest('.product-card,[class*=product]')?.querySelector('h2,h3,[class*=title],[class*=name]')?.textContent?.trim() || 'Product';
    var price = parseFloat(addBtn.getAttribute('data-mine-price') || addBtn.getAttribute('data-price') ||
                addBtn.closest('[data-mine-price]')?.getAttribute('data-mine-price') ||
                addBtn.closest('.product-card,[class*=product]')?.querySelector('[class*=price],[data-price]')?.textContent?.replace(/[^0-9.]/g,'') || '0');
    var type  = addBtn.getAttribute('data-mine-type') || 'physical';
    var id    = addBtn.getAttribute('data-mine-id') || '';
    addToCart(name, price, type, id);
    return;
  }

  // Booking form submit
  var bookBtn = el.closest('[data-mine-book],[data-mine-booking]');
  if (bookBtn) {
    e.preventDefault();
    var form = bookBtn.closest('form') || bookBtn.closest('[data-mine-booking-form]');
    if (form) submitBooking(form);
    return;
  }

  // Course enrol
  var courseBtn = el.closest('[data-mine-course]');
  if (courseBtn) {
    e.preventDefault();
    buyCourse(
      courseBtn.getAttribute('data-mine-course'),
      courseBtn.getAttribute('data-mine-course-name') || 'Course',
      courseBtn.getAttribute('data-mine-price') || '0'
    );
    return;
  }

  // Membership join
  var memBtn = el.closest('[data-mine-membership]');
  if (memBtn) {
    e.preventDefault();
    joinMembership(
      memBtn.getAttribute('data-mine-membership'),
      memBtn.getAttribute('data-mine-interval') || 'month',
      memBtn.getAttribute('data-mine-price') || ''
    );
    return;
  }

  // Generic "Book Now" / "Enrol" / "Buy" buttons — auto-detect
  if (/^(book now|book a|enrol|enroll|get started|sign up|join now|register)$/i.test(el.textContent.trim())) {
    var nearForm = el.closest('form');
    if (nearForm) { e.preventDefault(); submitBooking(nearForm); }
  }
});

// ── Form auto-intercept ───────────────────────────────────────────
document.addEventListener('submit', function(e){
  var form = e.target;
  // Booking forms
  if (form.getAttribute('data-mine-booking') !== null ||
      form.querySelector('[data-mine-book]') ||
      /booking|appointment|schedule|reserve/i.test(form.className + (form.id||''))) {
    e.preventDefault();
    submitBooking(form);
    return;
  }
  // Contact/lead forms — submit to MINE CRM
  if (form.getAttribute('data-mine-form') !== null ||
      /contact|enquiry|inquiry|lead|newsletter|subscribe/i.test(form.className + (form.id||''))) {
    e.preventDefault();
    var fields = {};
    new FormData(form).forEach(function(v,k){ fields[k]=v; });
    fetch(API_BASE + '/api/features/forms/submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId: SITE_ID, fields: fields })
    }).then(function(){
      form.innerHTML = '<div style="text-align:center;padding:24px;color:#111827"><div style="font-size:32px;margin-bottom:8px">✅</div><div style="font-weight:700">Thanks! We\'ll be in touch.</div></div>';
    }).catch(function(){});
  }
});

// ── Cart icon injection ───────────────────────────────────────────
// Auto-add floating cart button if site has products
function injectCartIcon(){
  var hasProducts = document.querySelector('[data-mine-product],[data-mine-add-to-cart]') ||
    document.querySelector('.product-card,[class*=product-grid],[class*=shop]');
  if (!hasProducts || document.getElementById('mine-cart-icon')) return;
  var icon = document.createElement('button');
  icon.id = 'mine-cart-icon';
  icon.setAttribute('data-mine-open-cart','');
  icon.style.cssText = 'position:fixed;bottom:24px;right:24px;width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#2563EB,#7C3AED);color:#fff;border:none;font-size:22px;cursor:pointer;box-shadow:0 4px 16px rgba(37,99,235,.35);z-index:9997;display:flex;align-items:center;justify-content:center';
  icon.innerHTML = '🛒<span data-mine-cart-count style="position:absolute;top:-4px;right:-4px;background:#EF4444;color:#fff;border-radius:50%;width:18px;height:18px;font-size:10px;font-weight:800;display:none;align-items:center;justify-content:center;font-family:system-ui">0</span>';
  document.body.appendChild(icon);
}

// Run after DOM is ready

// -- Membership join (recurring subscription via Stripe) --
async function joinMembership(planName, interval, price){
  if (!planName) return;
  var email = prompt('Enter your email to join "' + planName + '"' + (price ? ' ($' + price + (String(interval).indexOf('year')===0?'/yr':'/mo') + ')' : ''));
  if (!email || !email.includes('@')) return;
  try {
    var r = await fetch(API_BASE + '/api/payments/connect/subscription', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId: SITE_ID, planName: planName, interval: (String(interval).indexOf('year')===0?'year':'month'), customerEmail: email })
    });
    var data = await r.json();
    if (data.url) { window.location.href = data.url; }
    else { alert(data.error || 'Could not start signup - please try again'); }
  } catch(e) { alert('Connection error - please try again'); }
}

// -- Membership tiers auto-render (opt-in: add an element with data-mine-memberships) --
async function renderMemberships(){
  var box = document.querySelector('[data-mine-memberships]');
  if (!box || box.getAttribute('data-mine-wired')) return;
  box.setAttribute('data-mine-wired','1');
  try {
    var r = await fetch(API_BASE + '/api/public/memberships/' + SITE_ID);
    var data = await r.json();
    var tiers = (data && data.memberships) || [];
    if (!tiers.length) return;
    box.innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:16px;justify-content:center;align-items:stretch">' + tiers.map(function(t){
      var perks = '';
      try { var pk = typeof t.perks === 'string' ? JSON.parse(t.perks) : (t.perks || []); if (pk && pk.length) perks = '<ul style="list-style:none;padding:0;margin:12px 0;font-size:14px;color:#4B5563;text-align:left">' + pk.map(function(x){ return '<li style="margin:6px 0">&#10003; ' + String(x) + '</li>'; }).join('') + '</ul>'; } catch(e){}
      var yearly = String(t.interval||'').indexOf('year') === 0;
      var per = yearly ? '/yr' : '/mo';
      var nm = String(t.name || 'Membership').replace(/"/g,'&quot;');
      return '<div style="border:1px solid #E5E7EB;border-radius:14px;padding:24px;min-width:240px;max-width:300px;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.04);display:flex;flex-direction:column;text-align:center">' +
        '<div style="font-size:18px;font-weight:800;margin-bottom:6px">' + nm + '</div>' +
        '<div style="font-size:30px;font-weight:800;margin-bottom:4px">$' + (t.price||0) + '<span style="font-size:14px;font-weight:600;color:#6B7280">' + per + '</span></div>' +
        perks +
        '<button data-mine-membership="' + nm + '" data-mine-interval="' + (yearly?'year':'month') + '" data-mine-price="' + (t.price||0) + '" style="margin-top:auto;width:100%;padding:12px;background:linear-gradient(135deg,#2563EB,#7C3AED);color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit">Join now</button>' +
      '</div>';
    }).join('') + '</div>';
  } catch(e){}
}

// -- Products auto-render (opt-in: add an element with data-mine-products) --
async function renderProducts(){
  var box = document.querySelector('[data-mine-products]');
  if (!box || box.getAttribute('data-mine-wired')) return;
  box.setAttribute('data-mine-wired','1');
  try {
    var r = await fetch(API_BASE + '/api/public/products/' + SITE_ID);
    var data = await r.json();
    var products = (data && data.products) || [];
    if (!products.length) return;
    box.innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:16px;justify-content:center;align-items:stretch">' + products.map(function(p){
      var nm = String(p.name || 'Product').replace(/"/g,'&quot;');
      var desc = p.description ? '<div style="font-size:14px;color:#6B7280;margin:8px 0;text-align:left">' + String(p.description).slice(0,140) + '</div>' : '';
      var img = '';
      try { var imgs = typeof p.images_json === 'string' ? JSON.parse(p.images_json) : (p.images_json || []); if (imgs && imgs.length) img = '<img src="' + String(imgs[0]) + '" style="width:100%;height:160px;object-fit:cover;border-radius:10px;margin-bottom:12px" alt="' + nm + '">'; } catch(e){}
      return '<div style="border:1px solid #E5E7EB;border-radius:14px;padding:20px;min-width:240px;max-width:300px;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.04);display:flex;flex-direction:column;text-align:center">' +
        img +
        '<div style="font-size:17px;font-weight:800;margin-bottom:4px">' + nm + '</div>' +
        desc +
        '<div style="font-size:24px;font-weight:800;margin:8px 0">$' + (p.price||0) + '</div>' +
        '<button data-mine-product="' + nm + '" data-mine-price="' + (p.price||0) + '" data-mine-id="' + (p.id||'') + '" style="margin-top:auto;width:100%;padding:12px;background:linear-gradient(135deg,#2563EB,#7C3AED);color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit">Add to cart</button>' +
      '</div>';
    }).join('') + '</div>';
  } catch(e){}
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function(){ injectCartIcon(); renderMemberships(); renderProducts(); });
} else {
  injectCartIcon(); renderMemberships(); renderProducts();
}

// Expose globals
window.MINE_STORE = { addToCart: addToCart, openCart: openCart, closeCart: closeCart, cart: cart, checkout: checkout, joinMembership: joinMembership };

})();

/* ── Booking time-slot grid (2026-06-11): live availability under the date field ── */
(function () {
  function enhance(form) {
    if (form.getAttribute('data-mine-slots-wired')) return;
    var dateInp = form.querySelector('[type=date]');
    var hasBook = form.querySelector('[data-mine-book]');
    if (!dateInp || !hasBook) return;
    form.setAttribute('data-mine-slots-wired', '1');
    var timeInp = form.querySelector('[type=time]');
    if (!timeInp) { timeInp = document.createElement('input'); timeInp.type = 'time'; timeInp.name = 'time'; timeInp.style.display = 'none'; dateInp.parentNode.insertBefore(timeInp, dateInp.nextSibling); }
    var grid = document.createElement('div');
    grid.setAttribute('data-mine-slots', '1');
    grid.style.cssText = 'display:none;flex-wrap:wrap;gap:8px;margin:10px 0;align-items:center';
    (timeInp.nextSibling ? timeInp.parentNode.insertBefore(grid, timeInp.nextSibling) : timeInp.parentNode.appendChild(grid));
    function load() {
      var d = dateInp.value; if (!d) { grid.style.display = 'none'; return; }
      grid.style.display = 'flex';
      grid.innerHTML = '<span style="font-size:12px;opacity:.7;width:100%">Pick a time \u2014 loading\u2026</span>';
      fetch(API_BASE + '/api/public/book/' + SITE_ID + '/slots?date=' + encodeURIComponent(d))
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j || !j.slots) { grid.style.display = 'none'; return; }
          grid.innerHTML = '<span style="font-size:12px;opacity:.7;width:100%">Pick a time</span>';
          j.slots.forEach(function (s) {
            var b = document.createElement('button');
            b.type = 'button'; b.textContent = s.time;
            b.style.cssText = 'padding:8px 12px;border-radius:8px;border:1px solid rgba(0,0,0,.25);background:transparent;font:inherit;font-size:13px;cursor:pointer';
            if (!s.available) { b.disabled = true; b.style.opacity = '.35'; b.style.textDecoration = 'line-through'; b.style.cursor = 'not-allowed'; }
            else b.addEventListener('click', function () {
              timeInp.value = s.time;
              Array.prototype.forEach.call(grid.querySelectorAll('button'), function (x) { x.style.background = 'transparent'; x.style.color = ''; });
              b.style.background = '#111'; b.style.color = '#fff';
            });
            grid.appendChild(b);
          });
        })
        .catch(function () { grid.style.display = 'none'; });
    }
    dateInp.addEventListener('change', load);
    if (dateInp.value) load();
  }
  function scan() { var forms = document.querySelectorAll('form'); Array.prototype.forEach.call(forms, function (f) { try { if (f.querySelector('[data-mine-book]')) enhance(f); } catch (e) {} }); }
  if (document.readyState !== 'loading') scan(); else document.addEventListener('DOMContentLoaded', scan);
  setTimeout(scan, 1200);
})();


// ══════════════════════════════
// SALES POPUP — exit-intent / timed offer, rendered on the live site
// Reads the owner's config from /api/public/popup/:siteId and shows it once per rule.
// ══════════════════════════════
(function(){
  'use strict';
  var SITE_ID  = window.MINE_SITE_ID  || '';
  var API_BASE = window.MINE_API_BASE || '';
  if (!SITE_ID) return;

  function seenKey(){ return 'mine_popup_seen_' + SITE_ID; }
  function alreadySeen(rule){
    try {
      if (rule === 'always') return false;
      var store = (rule === 'ever') ? window.localStorage : window.sessionStorage;
      return store.getItem(seenKey()) === '1';
    } catch(e){ return false; }
  }
  function markSeen(rule){
    try {
      var store = (rule === 'ever') ? window.localStorage : window.sessionStorage;
      store.setItem(seenKey(), '1');
    } catch(e){}
  }

  function build(cfg){
    if (document.getElementById('mine-popup-overlay')) return;
    var esc = function(t){ var d = document.createElement('div'); d.textContent = t == null ? '' : String(t); return d.innerHTML; };
    var overlay = document.createElement('div');
    overlay.id = 'mine-popup-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:20px;opacity:0;transition:opacity .25s ease;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif';
    var codeBlock = cfg.code
      ? '<div style="margin:16px 0 4px;padding:12px;border:2px dashed #cbd5e1;border-radius:10px;background:#f8fafc"><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#64748b;font-weight:700">Your code</div><div id="mine-popup-code" style="font-size:22px;font-weight:800;letter-spacing:.05em;color:#0f172a;margin-top:2px">' + esc(cfg.code) + '</div><button id="mine-popup-copy" style="margin-top:8px;background:#0f172a;color:#fff;border:none;border-radius:8px;padding:7px 14px;font-size:13px;font-weight:600;cursor:pointer">Copy code</button></div>'
      : '';
    overlay.innerHTML =
      '<div id="mine-popup-card" style="position:relative;background:#fff;border-radius:18px;max-width:400px;width:100%;padding:28px 26px;box-shadow:0 24px 60px rgba(15,23,42,.3);transform:translateY(12px) scale(.98);transition:transform .25s ease;text-align:center">' +
        '<button id="mine-popup-x" aria-label="Close" style="position:absolute;top:12px;right:14px;background:none;border:none;font-size:22px;line-height:1;color:#94a3b8;cursor:pointer">&times;</button>' +
        '<div style="font-size:19px;font-weight:800;color:#0f172a;line-height:1.35;margin-top:4px">' + esc(cfg.offer || 'Wait — here\u2019s a special offer!') + '</div>' +
        codeBlock +
        '<button id="mine-popup-cta" style="margin-top:16px;width:100%;background:#2563EB;color:#fff;border:none;border-radius:10px;padding:12px;font-size:15px;font-weight:700;cursor:pointer">Shop the deal</button>' +
        '<button id="mine-popup-dismiss" style="margin-top:8px;background:none;border:none;color:#94a3b8;font-size:12.5px;cursor:pointer">No thanks</button>' +
      '</div>';
    document.body.appendChild(overlay);
    requestAnimationFrame(function(){
      overlay.style.opacity = '1';
      var card = document.getElementById('mine-popup-card');
      if (card) card.style.transform = 'translateY(0) scale(1)';
    });
    function close(){ overlay.style.opacity = '0'; setTimeout(function(){ try { overlay.remove(); } catch(e){} }, 250); }
    overlay.addEventListener('click', function(e){ if (e.target === overlay) close(); });
    var x = document.getElementById('mine-popup-x'); if (x) x.onclick = close;
    var dm = document.getElementById('mine-popup-dismiss'); if (dm) dm.onclick = close;
    var cta = document.getElementById('mine-popup-cta'); if (cta) cta.onclick = close;
    var cp = document.getElementById('mine-popup-copy');
    if (cp) cp.onclick = function(){
      try { navigator.clipboard.writeText(cfg.code); cp.textContent = 'Copied!'; setTimeout(function(){ cp.textContent = 'Copy code'; }, 1500); } catch(e){}
    };
    markSeen(cfg.showOncePer);
  }

  function arm(cfg){
    if (alreadySeen(cfg.showOncePer)) return;
    var fired = false;
    function fire(){ if (fired) return; fired = true; build(cfg); }
    var trig = (cfg.trigger || 'exit').toLowerCase();
    if (trig.indexOf('time') === 0 || trig.indexOf('delay') === 0) {
      setTimeout(fire, 15000); // timed: 15s
    } else if (trig.indexOf('scroll') === 0) {
      window.addEventListener('scroll', function onScroll(){
        var p = (window.scrollY + window.innerHeight) / document.body.scrollHeight;
        if (p > 0.5) { window.removeEventListener('scroll', onScroll); fire(); }
      }, { passive: true });
    } else {
      // exit intent (desktop) + mobile fallback timer
      document.addEventListener('mouseout', function(e){ if (!e.relatedTarget && e.clientY <= 0) fire(); });
      setTimeout(fire, 40000); // fallback so mobile visitors still see it
    }
  }

  function init(){
    fetch(API_BASE + '/api/public/popup/' + SITE_ID)
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){ if (d && d.popup && (d.popup.offer || d.popup.code)) arm(d.popup); })
      .catch(function(){});
  }
  if (document.readyState !== 'loading') init(); else document.addEventListener('DOMContentLoaded', init);
})();
