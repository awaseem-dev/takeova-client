"use strict";
const express = require("express");
const router  = express.Router();
const { v4: uuid } = require("uuid");
const { getDb, getSetting } = require("../db/init");
const { auth } = require("../middleware/auth");

// ── Email helper ──────────────────────────────────────────────────────────────
async function ivEmail(userId, to, subject, html) {
  try {
    const sgKey = getSetting("SENDGRID_API_KEY") || process.env.SENDGRID_API_KEY;
    if (!sgKey || !to) return false;
    const from = getSetting("EMAIL_FROM") || "noreply@takeova.ai";
    const site = getDb().prepare("SELECT name FROM sites WHERE user_id=? LIMIT 1").get(userId);
    const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));
    const _sgResp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { "Authorization": `Bearer ${sgKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: from, name: site?.name || "MINE" }, subject, content: [{ type: "text/html", value: html }] })
    });
    if (!_sgResp.ok) {
      let _sgErr = ""; try { _sgErr = (await _sgResp.text()).slice(0, 300); } catch(_) {}
      console.error(`[sendgrid] ${_sgResp.status}: ${_sgErr}`);
    }
    return true;
  } catch(e) { return false; }
}

// ════════════════════════════════════════════════════════════════════════════
//  PET SERVICES
// ════════════════════════════════════════════════════════════════════════════

router.get("/pets", auth, (req, res) => {
  try {
    const db = getDb();
    const { contact_id } = req.query;
    let q = "SELECT p.*, c.name as owner_name, c.email as owner_email, c.phone as owner_phone FROM pet_profiles p LEFT JOIN contacts c ON c.id=p.owner_id WHERE p.user_id=? AND p.active=1";
    const params = [req.userId];
    if (contact_id) { q += " AND p.owner_id=?"; params.push(contact_id); }
    q += " ORDER BY p.name";
    const pets = db.prepare(q).all(...params);
    res.json({ pets });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/pets", auth, (req, res) => {
  try {
    const db = getDb();
    const { name, species, breed, color, dob, weight_kg, microchip, vet_name, vet_phone,
            medical_notes, allergies, behavioural_notes, owner_id } = req.body;
    if (!name) return res.status(400).json({ error: "Pet name required" });
    const id = uuid();
    db.prepare(`INSERT INTO pet_profiles (id,user_id,owner_id,name,species,breed,color,dob,
               weight_kg,microchip,vet_name,vet_phone,medical_notes,allergies,behavioural_notes)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.userId, owner_id||null, name, species||"dog", breed||"", color||"",
           dob||null, weight_kg||null, microchip||"", vet_name||"", vet_phone||"",
           medical_notes||"", allergies||"", behavioural_notes||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/pets/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { name, species, breed, color, dob, weight_kg, microchip, vet_name, vet_phone,
            medical_notes, allergies, behavioural_notes, last_service, next_service, active } = req.body;
    db.prepare(`UPDATE pet_profiles SET name=?,species=?,breed=?,color=?,dob=?,weight_kg=?,
               microchip=?,vet_name=?,vet_phone=?,medical_notes=?,allergies=?,
               behavioural_notes=?,last_service=?,next_service=?,active=?
               WHERE id=? AND user_id=?`)
      .run(name, species, breed, color, dob, weight_kg, microchip, vet_name, vet_phone,
           medical_notes, allergies, behavioural_notes, last_service||null, next_service||null,
           active===false?0:1, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.delete("/pets/:id", auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare("UPDATE pet_profiles SET active=0 WHERE id=? AND user_id=?").run(req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Pet appointments
router.get("/pet-appointments", auth, (req, res) => {
  try {
    const db = getDb();
    const { from, pet_id, status } = req.query;
    let q = `SELECT pa.*, p.name as pet_name, p.species, p.breed, p.allergies, p.medical_notes,
             sp.name as staff_name
             FROM pet_appointments pa
             LEFT JOIN pet_profiles p ON p.id=pa.pet_id
             LEFT JOIN staff_profiles sp ON sp.id=pa.staff_id
             WHERE pa.user_id=?`;
    const params = [req.userId];
    if (from) { q += " AND pa.date>=?"; params.push(from); }
    if (pet_id) { q += " AND pa.pet_id=?"; params.push(pet_id); }
    if (status) { q += " AND pa.status=?"; params.push(status); }
    q += " ORDER BY pa.date DESC, pa.time ASC LIMIT 100";
    const appointments = db.prepare(q).all(...params);
    res.json({ appointments });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/pet-appointments", auth, async (req, res) => {
  try {
    const db = getDb();
    const { pet_id, service, date, time, duration_minutes, price,
            staff_id, notes, send_confirmation } = req.body;
    if (!pet_id || !service || !date || !time) {
      return res.status(400).json({ error: "pet_id, service, date, time required" });
    }
    const pet = db.prepare("SELECT p.*, c.email as owner_email, c.name as owner_name FROM pet_profiles p LEFT JOIN contacts c ON c.id=p.owner_id WHERE p.id=?").get(pet_id);
    if (!pet) return res.status(404).json({ error: "Pet not found" });
    const id = uuid();
    db.prepare(`INSERT INTO pet_appointments (id,user_id,pet_id,owner_email,owner_name,
               service,date,time,duration_minutes,price,staff_id,notes)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.userId, pet_id, pet.owner_email||"", pet.owner_name||"",
           service, date, time, duration_minutes||60, price||0, staff_id||null, notes||"");
    // Update last/next service on pet
    try { db.prepare("UPDATE pet_profiles SET last_service=?,next_service=? WHERE id=?").run(date, null, pet_id); } catch(e) { console.error("[/pet-appointments]", e.message || e); }
    // Send confirmation email to owner
    if (send_confirmation !== false && pet.owner_email) {
      const site = db.prepare("SELECT name FROM sites WHERE user_id=? LIMIT 1").get(req.userId);
      await ivEmail(req.userId, pet.owner_email, `Appointment confirmed — ${pet.name}`,
        `<div style="font-family:system-ui;max-width:520px;margin:0 auto;padding:24px">
        <h2>Appointment Confirmed ✅</h2>
        <p>Hi ${pet.owner_name||"there"},</p>
        <p><strong>${pet.name}</strong>'s appointment is booked.</p>
        <div style="background:#f8fafc;padding:16px;border-radius:10px;margin:16px 0">
          <div>📅 ${date} at ${time}</div>
          <div>💼 ${service}${duration_minutes ? " (" + duration_minutes + " min)" : ""}</div>
          ${price > 0 ? `<div>💰 $${price}</div>` : ""}
        </div>
        <p style="color:#64748B;font-size:13px">See you then! — ${site?.name||"The Team"}</p>
        </div>`);
    }
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/pet-appointments/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { service, date, time, duration_minutes, price, staff_id, notes, status } = req.body;
    db.prepare("UPDATE pet_appointments SET service=?,date=?,time=?,duration_minutes=?,price=?,staff_id=?,notes=?,status=? WHERE id=? AND user_id=?")
      .run(service, date, time, duration_minutes, price, staff_id, notes, status||"confirmed", req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Pets due for service (overdue next_service date)
router.get("/pets/due", auth, (req, res) => {
  try {
    const db = getDb();
    const today = new Date().toISOString().split("T")[0];
    const due = db.prepare(`SELECT p.*, c.name as owner_name, c.email as owner_email, c.phone as owner_phone
      FROM pet_profiles p LEFT JOIN contacts c ON c.id=p.owner_id
      WHERE p.user_id=? AND p.active=1 AND (p.next_service IS NOT NULL AND p.next_service<=?)
      ORDER BY p.next_service ASC`).all(req.userId, today);
    res.json({ due, count: due.length });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  ACCOMMODATION
// ════════════════════════════════════════════════════════════════════════════

router.get("/rooms", auth, (req, res) => {
  try {
    const db = getDb();
    const rooms = db.prepare("SELECT * FROM rooms WHERE user_id=? AND active=1 ORDER BY name").all(req.userId);
    res.json({ rooms: rooms.map(r => ({ ...r, amenities: JSON.parse(r.amenities||"[]"), images: JSON.parse(r.images||"[]") })) });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/rooms", auth, (req, res) => {
  try {
    const db = getDb();
    const { name, type, description, max_guests, beds, price_per_night, amenities, images } = req.body;
    if (!name) return res.status(400).json({ error: "Room name required" });
    const id = uuid();
    db.prepare("INSERT INTO rooms (id,user_id,name,type,description,max_guests,beds,price_per_night,amenities,images) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.userId, name, type||"room", description||"", max_guests||2, beds||"1 queen",
           price_per_night||0, JSON.stringify(amenities||[]), JSON.stringify(images||[]));
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/rooms/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { name, type, description, max_guests, beds, price_per_night, amenities, images, active } = req.body;
    db.prepare("UPDATE rooms SET name=?,type=?,description=?,max_guests=?,beds=?,price_per_night=?,amenities=?,images=?,active=? WHERE id=? AND user_id=?")
      .run(name, type, description, max_guests, beds, price_per_night,
           JSON.stringify(amenities||[]), JSON.stringify(images||[]), active===false?0:1,
           req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Room availability check
router.get("/rooms/:id/availability", (req, res) => {
  try {
    const db = getDb();
    const { check_in, check_out } = req.query;
    if (!check_in || !check_out) return res.status(400).json({ error: "check_in and check_out required (YYYY-MM-DD)" });
    const room = db.prepare("SELECT * FROM rooms WHERE id=?").get(req.params.id);
    if (!room) return res.status(404).json({ error: "Room not found" });
    // Check bookings overlap
    const conflict = db.prepare(`SELECT id,guest_name,check_in,check_out FROM room_bookings
      WHERE room_id=? AND status NOT IN ('cancelled') AND NOT (check_out<=? OR check_in>=?)`).all(req.params.id, check_in, check_out);
    // Check blockings
    const blocked = db.prepare(`SELECT id,reason,start_date,end_date FROM room_blocking
      WHERE room_id=? AND NOT (end_date<=? OR start_date>=?)`).all(req.params.id, check_in, check_out);
    const nights = Math.ceil((new Date(check_out) - new Date(check_in)) / 86400000);
    res.json({
      available: conflict.length === 0 && blocked.length === 0,
      room_name: room.name, check_in, check_out, nights,
      total_price: nights * (room.price_per_night||0),
      conflicts: conflict, blockings: blocked
    });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// All rooms availability for date range
router.get("/rooms/availability/range", auth, (req, res) => {
  try {
    const db = getDb();
    const { check_in, check_out } = req.query;
    if (!check_in || !check_out) return res.status(400).json({ error: "check_in and check_out required" });
    const rooms = db.prepare("SELECT * FROM rooms WHERE user_id=? AND active=1").all(req.userId);
    const result = rooms.map(room => {
      const conflict = db.prepare("SELECT id FROM room_bookings WHERE room_id=? AND status NOT IN ('cancelled') AND NOT (check_out<=? OR check_in>=?)").all(room.id, check_in, check_out);
      const blocked = db.prepare("SELECT id FROM room_blocking WHERE room_id=? AND NOT (end_date<=? OR start_date>=?)").all(room.id, check_in, check_out);
      const nights = Math.ceil((new Date(check_out) - new Date(check_in)) / 86400000);
      return { ...room, amenities: JSON.parse(room.amenities||"[]"), images: JSON.parse(room.images||"[]"), available: conflict.length === 0 && blocked.length === 0, total_price: nights * (room.price_per_night||0) };
    });
    res.json({ rooms: result, check_in, check_out, nights: Math.ceil((new Date(check_out) - new Date(check_in)) / 86400000) });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Room bookings
router.get("/room-bookings", auth, (req, res) => {
  try {
    const db = getDb();
    const { status, from, to, room_id } = req.query;
    let q = `SELECT rb.*, r.name as room_name, r.type as room_type, r.price_per_night FROM room_bookings rb LEFT JOIN rooms r ON r.id=rb.room_id WHERE rb.user_id=?`;
    const params = [req.userId];
    if (status) { q += " AND rb.status=?"; params.push(status); }
    if (from) { q += " AND rb.check_in>=?"; params.push(from); }
    if (to) { q += " AND rb.check_out<=?"; params.push(to); }
    if (room_id) { q += " AND rb.room_id=?"; params.push(room_id); }
    q += " ORDER BY rb.check_in DESC LIMIT 100";
    const bookings = db.prepare(q).all(...params);
    res.json({ bookings });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/room-bookings", auth, async (req, res) => {
  try {
    const db = getDb();
    const { room_id, guest_name, guest_email, guest_phone, check_in, check_out,
            guests, notes, special_requests, channel, deposit_paid } = req.body;
    if (!room_id || !guest_name || !guest_email || !check_in || !check_out) {
      return res.status(400).json({ error: "room_id, guest_name, guest_email, check_in, check_out required" });
    }
    // Availability check
    const conflict = db.prepare("SELECT id FROM room_bookings WHERE room_id=? AND status NOT IN ('cancelled') AND NOT (check_out<=? OR check_in>=?)").all(room_id, check_in, check_out);
    if (conflict.length) return res.status(409).json({ error: "Room is not available for those dates" });
    const room = db.prepare("SELECT * FROM rooms WHERE id=?").get(room_id);
    if (!room) return res.status(404).json({ error: "Room not found" });
    const nights = Math.ceil((new Date(check_out) - new Date(check_in)) / 86400000);
    const total = nights * (room.price_per_night||0);
    const id = uuid();
    db.prepare(`INSERT INTO room_bookings (id,user_id,room_id,guest_name,guest_email,guest_phone,
               check_in,check_out,nights,guests,total_price,deposit_paid,status,channel,notes,special_requests)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.userId, room_id, guest_name, guest_email, guest_phone||"",
           check_in, check_out, nights, guests||1, total, deposit_paid||0,
           "confirmed", channel||"direct", notes||"", special_requests||"");
    // Save guest as contact
    try {
      const existing = db.prepare("SELECT id FROM contacts WHERE user_id=? AND email=?").get(req.userId, guest_email);
      if (!existing) db.prepare("INSERT INTO contacts (id,user_id,name,email,phone,status,source) VALUES (?,?,?,?,?,?,?)").run(uuid(), req.userId, guest_name, guest_email, guest_phone||"", "customer", "accommodation");
    } catch(e) { console.error("[/room-bookings]", e.message || e); }
    // Send confirmation
    await ivEmail(req.userId, guest_email, `Booking confirmed — ${room.name}`,
      `<div style="font-family:system-ui;max-width:520px;margin:0 auto;padding:24px">
      <h2>Booking Confirmed ✅</h2>
      <p>Hi ${guest_name},</p>
      <p>Your booking for <strong>${room.name}</strong> is confirmed.</p>
      <div style="background:#f8fafc;padding:16px;border-radius:10px;margin:16px 0">
        <div>📅 Check-in: <strong>${check_in}</strong></div>
        <div>📅 Check-out: <strong>${check_out}</strong></div>
        <div>🌙 ${nights} night${nights!==1?"s":""}</div>
        <div>👥 ${guests||1} guest${(guests||1)!==1?"s":""}</div>
        <div>💰 Total: <strong>$${total.toFixed(2)}</strong></div>
        ${special_requests ? `<div>📝 Special requests: ${special_requests}</div>` : ""}
      </div>
      </div>`);
    res.json({ success: true, id, total, nights });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/room-bookings/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { status, notes, checked_in_at, checked_out_at, deposit_paid } = req.body;
    const fields = [], vals = [];
    if (status !== undefined) { fields.push("status=?"); vals.push(status); }
    if (notes !== undefined) { fields.push("notes=?"); vals.push(notes); }
    if (checked_in_at !== undefined) { fields.push("checked_in_at=?"); vals.push(checked_in_at); }
    if (checked_out_at !== undefined) { fields.push("checked_out_at=?"); vals.push(checked_out_at); }
    if (deposit_paid !== undefined) { fields.push("deposit_paid=?"); vals.push(deposit_paid); }
    if (!fields.length) return res.json({ success: true });
    vals.push(req.params.id, req.userId);
    db.prepare(`UPDATE room_bookings SET ${fields.join(",")} WHERE id=? AND user_id=?`).run(...vals);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Block room dates
router.post("/room-blocking", auth, (req, res) => {
  try {
    const db = getDb();
    const { room_id, start_date, end_date, reason } = req.body;
    if (!room_id || !start_date || !end_date) return res.status(400).json({ error: "room_id, start_date, end_date required" });
    const id = uuid();
    db.prepare("INSERT INTO room_blocking (id,user_id,room_id,start_date,end_date,reason) VALUES (?,?,?,?,?,?)").run(id, req.userId, room_id, start_date, end_date, reason||"maintenance");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.delete("/room-blocking/:id", auth, (req, res) => {
  try {
    const db = getDb();
    db.prepare("DELETE FROM room_blocking WHERE id=? AND user_id=?").run(req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Occupancy summary
router.get("/accommodation/summary", auth, (req, res) => {
  try {
    const db = getDb();
    const today = new Date().toISOString().split("T")[0];
    const monthStart = today.slice(0,7) + "-01";
    let totalRooms = 0, occupied = 0, checkins = 0, checkouts = 0, revenue = 0;
    try { totalRooms = db.prepare("SELECT COUNT(*) as c FROM rooms WHERE user_id=? AND active=1").get(req.userId)?.c||0; } catch(e) {}
    try { occupied = db.prepare("SELECT COUNT(*) as c FROM room_bookings WHERE user_id=? AND status='confirmed' AND check_in<=? AND check_out>?").get(req.userId, today, today)?.c||0; } catch(e) {}
    try { checkins = db.prepare("SELECT COUNT(*) as c FROM room_bookings WHERE user_id=? AND check_in=? AND status='confirmed'").get(req.userId, today)?.c||0; } catch(e) {}
    try { checkouts = db.prepare("SELECT COUNT(*) as c FROM room_bookings WHERE user_id=? AND check_out=? AND status='confirmed'").get(req.userId, today)?.c||0; } catch(e) {}
    try { revenue = db.prepare("SELECT COALESCE(SUM(total_price),0) as r FROM room_bookings WHERE user_id=? AND status='confirmed' AND check_in>=?").get(req.userId, monthStart)?.r||0; } catch(e) {}
    res.json({ total_rooms: totalRooms, occupied_tonight: occupied, todays_checkins: checkins, todays_checkouts: checkouts, occupancy_pct: totalRooms > 0 ? Math.round((occupied/totalRooms)*100) : 0, revenue_this_month: Math.round(revenue) });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  CLEANING COMPANIES
// ════════════════════════════════════════════════════════════════════════════

router.get("/cleaning-properties", auth, (req, res) => {
  try {
    const db = getDb();
    const props = db.prepare(`SELECT cp.*, c.name as client_name, c.email as client_email, c.phone as client_phone
      FROM cleaning_properties cp LEFT JOIN contacts c ON c.id=cp.contact_id
      WHERE cp.user_id=? AND cp.active=1 ORDER BY cp.address`).all(req.userId);
    res.json({ properties: props });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/cleaning-properties", auth, (req, res) => {
  try {
    const db = getDb();
    const { address, suburb, city, property_type, bedrooms, bathrooms, contact_id,
            access_notes, alarm_code, key_location, pets_on_premises, special_instructions } = req.body;
    if (!address) return res.status(400).json({ error: "Address required" });
    const id = uuid();
    db.prepare(`INSERT INTO cleaning_properties (id,user_id,contact_id,address,suburb,city,
               property_type,bedrooms,bathrooms,access_notes,alarm_code,key_location,
               pets_on_premises,special_instructions)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.userId, contact_id||null, address, suburb||"", city||"",
           property_type||"house", bedrooms||3, bathrooms||2,
           access_notes||"", alarm_code||"", key_location||"",
           pets_on_premises||"", special_instructions||"");
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/cleaning-properties/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { address, suburb, city, property_type, bedrooms, bathrooms, access_notes,
            alarm_code, key_location, pets_on_premises, special_instructions, active } = req.body;
    db.prepare(`UPDATE cleaning_properties SET address=?,suburb=?,city=?,property_type=?,
               bedrooms=?,bathrooms=?,access_notes=?,alarm_code=?,key_location=?,
               pets_on_premises=?,special_instructions=?,active=? WHERE id=? AND user_id=?`)
      .run(address, suburb, city, property_type, bedrooms, bathrooms, access_notes,
           alarm_code, key_location, pets_on_premises, special_instructions,
           active===false?0:1, req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Cleaning jobs
router.get("/cleaning-jobs", auth, (req, res) => {
  try {
    const db = getDb();
    const { status, from, property_id, staff_id } = req.query;
    let q = `SELECT cj.*, cp.address, cp.suburb, cp.access_notes, cp.alarm_code, cp.key_location, cp.pets_on_premises,
             sp.name as staff_name, c.name as client_name, c.phone as client_phone
             FROM cleaning_jobs cj
             LEFT JOIN cleaning_properties cp ON cp.id=cj.property_id
             LEFT JOIN staff_profiles sp ON sp.id=cj.staff_id
             LEFT JOIN contacts c ON c.id=cj.contact_id
             WHERE cj.user_id=?`;
    const params = [req.userId];
    if (status) { q += " AND cj.status=?"; params.push(status); }
    if (from) { q += " AND cj.scheduled_date>=?"; params.push(from); }
    if (property_id) { q += " AND cj.property_id=?"; params.push(property_id); }
    if (staff_id) { q += " AND cj.staff_id=?"; params.push(staff_id); }
    q += " ORDER BY cj.scheduled_date ASC, cj.scheduled_time ASC LIMIT 100";
    const jobs = db.prepare(q).all(...params);
    res.json({ jobs: jobs.map(j => ({ ...j, checklist_completed: JSON.parse(j.checklist_completed||"[]"), staff_ids: JSON.parse(j.staff_ids||"[]") })) });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/cleaning-jobs", auth, (req, res) => {
  try {
    const db = getDb();
    const { property_id, staff_id, contact_id, title, type, scheduled_date, scheduled_time,
            duration_minutes, price, recurrence, recurrence_interval, notes, staff_ids } = req.body;
    if (!title) return res.status(400).json({ error: "Title required" });
    const id = uuid();
    db.prepare(`INSERT INTO cleaning_jobs (id,user_id,property_id,staff_id,contact_id,title,type,
               scheduled_date,scheduled_time,duration_minutes,price,recurrence,recurrence_interval,notes,staff_ids)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.userId, property_id||null, staff_id||null, contact_id||null,
           title, type||"regular", scheduled_date||null, scheduled_time||null,
           duration_minutes||120, price||0, recurrence||"none",
           recurrence_interval||1, notes||"",
           JSON.stringify(staff_ids||[]));
    // Auto-generate recurring jobs up to 8 weeks out
    if (recurrence && recurrence !== "none" && scheduled_date) {
      const interval = recurrence === "weekly" ? 7 : recurrence === "fortnightly" ? 14 : recurrence === "monthly" ? 30 : 0;
      if (interval > 0) {
        let nextDate = new Date(scheduled_date);
        for (let i = 1; i <= 8; i++) {
          nextDate.setDate(nextDate.getDate() + interval);
          const nextStr = nextDate.toISOString().split("T")[0];
          const rid = uuid();
          try {
            db.prepare(`INSERT INTO cleaning_jobs (id,user_id,property_id,staff_id,contact_id,title,type,
                       scheduled_date,scheduled_time,duration_minutes,price,recurrence,notes)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
              .run(rid, req.userId, property_id||null, staff_id||null, contact_id||null,
                   title, type||"regular", nextStr, scheduled_time||null,
                   duration_minutes||120, price||0, recurrence, notes||"");
          } catch(e) {}
        }
      }
    }
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.put("/cleaning-jobs/:id", auth, (req, res) => {
  try {
    const db = getDb();
    const { title, type, scheduled_date, scheduled_time, duration_minutes, price,
            staff_id, staff_ids, status, notes, internal_notes, checklist_completed, completed_at } = req.body;
    db.prepare(`UPDATE cleaning_jobs SET title=?,type=?,scheduled_date=?,scheduled_time=?,
               duration_minutes=?,price=?,staff_id=?,staff_ids=?,status=?,notes=?,internal_notes=?,
               checklist_completed=?,completed_at=?,updated_at=datetime('now') WHERE id=? AND user_id=?`)
      .run(title, type, scheduled_date, scheduled_time, duration_minutes, price,
           staff_id||null, JSON.stringify(staff_ids||[]),
           status||"scheduled", notes, internal_notes,
           JSON.stringify(checklist_completed||[]), completed_at||null,
           req.params.id, req.userId);
    res.json({ success: true });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Cleaning checklists
router.get("/cleaning-checklists", auth, (req, res) => {
  try {
    const db = getDb();
    const checklists = db.prepare("SELECT * FROM cleaning_checklists WHERE user_id=? ORDER BY name").all(req.userId);
    res.json({ checklists: checklists.map(c => ({ ...c, items: JSON.parse(c.items||"[]") })) });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

router.post("/cleaning-checklists", auth, (req, res) => {
  try {
    const db = getDb();
    const { name, type, items } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });
    const id = uuid();
    db.prepare("INSERT INTO cleaning_checklists (id,user_id,name,type,items) VALUES (?,?,?,?,?)").run(id, req.userId, name, type||"regular", JSON.stringify(items||[]));
    res.json({ success: true, id });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Today's cleaning schedule
router.get("/cleaning-jobs/today", auth, (req, res) => {
  try {
    const db = getDb();
    const today = new Date().toISOString().split("T")[0];
    const jobs = db.prepare(`SELECT cj.*, cp.address, cp.suburb, cp.access_notes, cp.alarm_code, cp.key_location, cp.pets_on_premises, sp.name as staff_name
      FROM cleaning_jobs cj
      LEFT JOIN cleaning_properties cp ON cp.id=cj.property_id
      LEFT JOIN staff_profiles sp ON sp.id=cj.staff_id
      WHERE cj.user_id=? AND cj.scheduled_date=? AND cj.status NOT IN ('cancelled','completed')
      ORDER BY cj.scheduled_time ASC`).all(req.userId, today);
    res.json({ jobs: jobs.map(j => ({ ...j, checklist_completed: JSON.parse(j.checklist_completed||"[]") })), count: jobs.length, date: today });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

// Convert cleaning job to invoice
router.post("/cleaning-jobs/:id/invoice", auth, async (req, res) => {
  try {
    const db = getDb();
    const job = db.prepare(`SELECT cj.*, cp.address, c.name as client_name, c.email as client_email
      FROM cleaning_jobs cj
      LEFT JOIN cleaning_properties cp ON cp.id=cj.property_id
      LEFT JOIN contacts c ON c.id=cj.contact_id
      WHERE cj.id=? AND cj.user_id=?`).get(req.params.id, req.userId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    const invNum = `CLN-${Date.now().toString().slice(-6)}`;
    const dueDate = new Date(Date.now()+14*86400000).toISOString().split("T")[0];
    const items = [{ description: `${job.title}${job.address ? " — " + job.address : ""}${job.scheduled_date ? " (" + job.scheduled_date + ")" : ""}`, amount: job.price||0 }];
    const invId = uuid();
    db.prepare("INSERT INTO invoices (id,user_id,invoice_number,client_name,client_email,items_json,subtotal,tax,total,status,due_date) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(invId, req.userId, invNum, job.client_name||"Client", job.client_email||"", JSON.stringify(items), job.price||0, 0, job.price||0, "sent", dueDate);
    db.prepare("UPDATE cleaning_jobs SET status='invoiced' WHERE id=?").run(job.id);
    if (job.client_email) {
      await ivEmail(req.userId, job.client_email, `Invoice ${invNum}`,
        `<div style="font-family:system-ui;max-width:520px;margin:0 auto;padding:24px"><h2>Invoice ${invNum}</h2><p>Hi ${job.client_name||"there"},</p><p>Please find your invoice for <strong>${job.title}</strong>${job.address ? " at " + job.address : ""}.</p><p><strong>Total: $${(job.price||0).toFixed(2)}</strong> — due ${dueDate}</p></div>`);
    }
    res.json({ success: true, invoice_id: invId, invoice_number: invNum });
  } catch(e) { console.error('[Route]', e.message); res.status(500).json({ error: 'An internal error occurred' }); }
});

module.exports = router;
