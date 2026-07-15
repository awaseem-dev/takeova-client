#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// MINE v49.1 — Stripe Product Seeder
// Creates all plan Products + Prices + AI Employee add-ons in Stripe
// in one command. Safe to re-run (idempotent via metadata lookup).
//
// Usage:
//   export STRIPE_SECRET_KEY=sk_test_...   # or sk_live_... for production
//   node scripts/seed-stripe-products.js
//
// After running, copy the output priceIds into backend/config/plans.js
// and frontend/.env so checkout sessions use the right prices.
// ═══════════════════════════════════════════════════════════════════

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('✗ STRIPE_SECRET_KEY env var is required');
  process.exit(1);
}
const isLive = key.startsWith('sk_live_');
console.log(`\nSeeding Stripe products in ${isLive ? 'LIVE' : 'TEST'} mode...\n`);

const stripe = require('stripe')(key);

// ═══ PLAN DEFINITIONS (v50 — rebalanced for 85% margin @ 30% utilization) ═══
const PLANS = [
  {
    key: 'starter',
    name: 'MINE Starter',
    description: 'For new small businesses. 2 AI-built sites, 30 tool uses, 400 chatbot msgs.',
    monthly_price: 7900,   // $79/mo
    annual_price: 75600,   // $63/mo × 12 = $756/yr (20% off)
  },
  {
    key: 'growth',
    name: 'MINE Growth',
    description: '3 AI-built sites, 75 tool uses, 800 chatbot msgs, 75 AI edits.',
    monthly_price: 12900,  // $129/mo
    annual_price: 123600,  // $103/mo × 12 = $1,236/yr (20% off)
  },
  {
    key: 'pro',
    name: 'MINE Pro',
    description: '5 AI-built sites, 200 tool uses, 1,500 chatbot msgs, 150 AI edits, A/B testing.',
    monthly_price: 19900,  // $199/mo (was $179)
    annual_price: 190800,  // $159/mo × 12 = $1,908/yr (20% off)
  },
  {
    key: 'enterprise',
    name: 'MINE Enterprise',
    description: '12 AI-built sites, 400 tool uses, 3,000 chatbot msgs, priority support.',
    monthly_price: 39900,  // $399/mo (was $299)
    annual_price: 382800,  // $319/mo × 12 = $3,828/yr (20% off)
  },
  {
    key: 'agency',
    name: 'MINE Agency',
    description: 'Pooled caps across unlimited clients. 1,000 tool uses, 30 sites, generous included quotas.',
    monthly_price: 99900,  // $999/mo (was $799)
    annual_price: 958800,  // $799/mo × 12 = $9,588/yr (20% off)
  }
];

// ═══ AI EMPLOYEE ADD-ONS (separate subscriptions, unchanged from v48) ═══
const AI_EMPLOYEES = [
  { key: 'sales_rep',        name: 'AI Sales Rep',        price: 7900, description: 'Follows up every lead 24/7' },
  { key: 'support_agent',    name: 'AI Support Agent',    price: 7900, description: 'Handles customer tickets round the clock' },
  { key: 'social_manager',   name: 'AI Social Manager',   price: 8900, description: 'Posts daily branded content' },
  { key: 'bookkeeper',       name: 'AI Bookkeeper',       price: 7900, description: 'Reconciles Xero/QuickBooks nightly' },
  { key: 'marketing',        name: 'AI Marketing',        price: 8900, description: 'Ad copy, emails, landing pages' },
  { key: 'receptionist',     name: 'AI Receptionist',     price: 9900, description: 'Answers calls, books appointments' },
  { key: 'mine_control',     name: 'MINE Control',        price: 8900, description: 'WhatsApp control of your business' },
  { key: 'growth_agent',     name: 'AI Growth Agent',     price: 8900, description: 'Competitor watch + SEO actions' },
  { key: 'customer_success', name: 'AI Customer Success', price: 4900, description: 'Identifies churn risks, sends win-backs' },
  { key: 'legal',            name: 'AI Legal',            price: 8900, description: 'Contract review, NDA generation' },
  { key: 'community',        name: 'AI Community',        price: 7900, description: 'Manages Reddit/LinkedIn engagement' },
  { key: 'prospector',       name: 'AI Prospector',       price: 7900, description: 'Finds new customers + demos' },
  { key: 'proposal_agent',   name: 'AI Proposal Agent',   price: 4900, description: 'Generates + follows up proposals' },
  { key: 'cold_email',       name: 'AI Cold Email',       price: 6900, description: 'Sends sequenced cold outreach' },
  { key: 'browser_agent',    name: 'AI Browser Agent',    price: 7900, description: 'Operates any website on your behalf — navigates, fills forms, extracts data, monitors prices. Not available on Starter.' }
];

// ═══ OVERAGE METERED PRICES (for usage-based billing) ═══
const OVERAGE_PRICES = [
  { key: 'overage_tool',    name: 'AI Tool Use Overage',    unit_amount: 20,   description: 'Per use beyond plan cap' },
  { key: 'overage_site',    name: 'AI Site Build Overage',  unit_amount: 300,  description: 'Per site beyond plan cap' },
  { key: 'overage_edit',    name: 'AI Site Edit Overage',   unit_amount: 50,   description: 'Per edit beyond plan cap' },
  { key: 'overage_image',   name: 'AI Image Overage',       unit_amount: 40,   description: 'Per image beyond plan cap' },
  { key: 'overage_chatbot', name: 'Chatbot Msg Overage',    unit_amount: 2,    description: 'Per chatbot message beyond plan cap' }
];

async function findOrCreateProduct(key, name, description) {
  const search = await stripe.products.search({
    query: `metadata['mine_key']:'${key}'`
  });
  if (search.data.length > 0) {
    console.log(`  ↻ Product exists: ${name} (${search.data[0].id})`);
    return search.data[0];
  }
  const product = await stripe.products.create({
    name,
    description,
    metadata: { mine_key: key, mine_version: 'v50' }
  });
  console.log(`  ✓ Created product: ${name} (${product.id})`);
  return product;
}

async function findOrCreatePrice(productId, unitAmount, interval, currency, nickname, meta = {}) {
  const search = await stripe.prices.search({
    query: `product:'${productId}' AND active:'true'`
  });
  const existing = search.data.find(p =>
    p.unit_amount === unitAmount &&
    p.recurring?.interval === interval &&
    p.currency === currency
  );
  if (existing) {
    console.log(`    ↻ Price exists: ${nickname} ${existing.id}`);
    return existing;
  }
  const price = await stripe.prices.create({
    product: productId,
    unit_amount: unitAmount,
    currency,
    recurring: interval ? { interval } : undefined,
    nickname,
    metadata: meta
  });
  console.log(`    ✓ Created price: ${nickname} ${price.id}`);
  return price;
}

async function run() {
  const output = {
    plans: {},
    ai_employees: {},
    overages: {}
  };

  // ═══ Plans ═══
  console.log('═══ PLANS ═══');
  for (const plan of PLANS) {
    const product = await findOrCreateProduct(plan.key, plan.name, plan.description);
    const monthly = await findOrCreatePrice(product.id, plan.monthly_price, 'month', 'usd',
      `${plan.name} — Monthly`, { mine_plan: plan.key, mine_cycle: 'monthly' });
    const annual = await findOrCreatePrice(product.id, plan.annual_price, 'year', 'usd',
      `${plan.name} — Annual`, { mine_plan: plan.key, mine_cycle: 'annual' });
    output.plans[plan.key] = {
      productId: product.id,
      monthlyPriceId: monthly.id,
      annualPriceId: annual.id
    };
  }

  // ═══ AI Employees ═══
  console.log('\n═══ AI EMPLOYEES ═══');
  for (const emp of AI_EMPLOYEES) {
    const product = await findOrCreateProduct('ai_' + emp.key, emp.name, emp.description);
    const price = await findOrCreatePrice(product.id, emp.price, 'month', 'usd',
      `${emp.name} — Monthly`, { mine_employee: emp.key });
    output.ai_employees[emp.key] = {
      productId: product.id,
      priceId: price.id
    };
  }

  // ═══ Overages (metered billing) ═══
  console.log('\n═══ OVERAGES (metered) ═══');
  for (const ov of OVERAGE_PRICES) {
    const product = await findOrCreateProduct(ov.key, ov.name, ov.description);
    const search = await stripe.prices.search({
      query: `product:'${product.id}' AND active:'true'`
    });
    let price = search.data.find(p => p.recurring?.usage_type === 'metered');
    if (!price) {
      price = await stripe.prices.create({
        product: product.id,
        unit_amount: ov.unit_amount,
        currency: 'usd',
        recurring: { interval: 'month', usage_type: 'metered' },
        billing_scheme: 'per_unit',
        nickname: ov.name,
        metadata: { mine_overage: ov.key }
      });
      console.log(`    ✓ Created metered price: ${ov.name} ${price.id}`);
    } else {
      console.log(`    ↻ Metered price exists: ${ov.name} ${price.id}`);
    }
    output.overages[ov.key] = { productId: product.id, priceId: price.id };
  }

  // ═══ Write output to file for easy copy-paste ═══
  const fs = require('fs');
  const path = require('path');
  const outFile = path.join(__dirname, '..', 'config', `stripe-prices.${isLive ? 'live' : 'test'}.json`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));

  console.log('\n═══════════════════════════════════════════════════');
  console.log(`✓ DONE. ${Object.keys(output.plans).length} plans, ${Object.keys(output.ai_employees).length} employees, ${Object.keys(output.overages).length} overages`);
  console.log(`✓ Price IDs written to: ${outFile}`);
  console.log('═══════════════════════════════════════════════════');
  console.log('\nNEXT STEPS:');
  console.log('  1. Set STRIPE_PRICE_IDS_PATH in .env to point to this file');
  console.log('  2. Create a webhook endpoint in Stripe Dashboard pointing to');
  console.log('     https://yourdomain.com/api/payments/webhook');
  console.log('  3. Copy the webhook signing secret to STRIPE_WEBHOOK_SECRET in .env');
  console.log('  4. Run a test checkout to verify end-to-end billing works');
}

run().catch(err => {
  console.error('\n✗ Seeder failed:', err.message);
  if (err.raw) console.error(err.raw);
  process.exit(1);
});
