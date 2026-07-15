#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// MINE — Create Admin User
// Creates an admin account you can use to log into the Admin Dashboard.
// Usage: node scripts/create-admin.js <email> <password> [name]
// ═══════════════════════════════════════════════════════════════════

const path = require('path');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');

const email = process.argv[2];
const password = process.argv[3];
const name = process.argv[4] || 'Admin';

if (!email || !password) {
  console.error('Usage: node scripts/create-admin.js <email> <password> [name]');
  process.exit(1);
}

if (password.length < 12) {
  console.error('✗ Password must be at least 12 characters');
  process.exit(1);
}

if (!email.includes('@')) {
  console.error('✗ Invalid email');
  process.exit(1);
}

const { init } = require('../db/init.js');
const db = init();

(async () => {
  try {
    // Check if user exists
    const existing = db.prepare('SELECT id, role FROM users WHERE email = ?').get(email);
    if (existing) {
      // Promote to admin if not already
      if (existing.role !== 'admin') {
        db.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', existing.id);
        console.log(`✓ Promoted existing user ${email} to admin`);
      } else {
        console.log(`↻ User ${email} is already admin`);
      }
      process.exit(0);
    }

    // Create new admin user
    const hash = await bcrypt.hash(password, 12);
    const id = randomUUID();
    const referralCode = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '') + Math.random().toString(36).slice(2, 6);

    db.prepare(`
      INSERT INTO users (id, email, password_hash, name, role, account_status, plan, referral_code, created_at)
      VALUES (?, ?, ?, ?, 'admin', 'active', 'enterprise', ?, datetime('now'))
    `).run(id, email, hash, name, referralCode);

    console.log(`✓ Created admin user:`);
    console.log(`    Email:    ${email}`);
    console.log(`    Name:     ${name}`);
    console.log(`    Role:     admin`);
    console.log(`    Plan:     enterprise (no caps)`);
    console.log(`    ID:       ${id}`);
    console.log(`\n  Log in at /admin with these credentials.`);
  } catch (err) {
    console.error('✗ Error creating admin:', err.message);
    process.exit(1);
  }
})();
