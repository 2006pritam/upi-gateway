// Self-hosted UPI payment gateway — single-service demo / starter implementation.
// Node 20+ / 24, no framework. Only dependency is `qrcode` for dynamic QR PNGs.
//
// HONEST SCOPE — read this before real money:
// * A plain UPI QR / intent link has no bank webhook. "Confirmed" here means:
//   an ingested bank SMS / Gmail alert matched the ACTIVE payment's exact amount
//   (and a UTR when present), OR a merchant manually confirmed a counter payment.
//   SMS / email parsing is heuristic, can be delayed, duplicated or spoofed, and
//   is NOT by itself proof of settlement. Always reconcile against the bank
//   statement before fulfilling high-value orders.
// * WhatsApp OTP is only really delivered when WHATSAPP_* env vars are set
//   (Meta WhatsApp Cloud API, approved Authentication template). Without them
//   the server runs in DEMO mode and shows the code on screen — it must never
//   be presented as "sent on WhatsApp" in that mode.
// * This is not a certified / NPCI-approved payment aggregator and does not
//   authorise operating one. Check bank terms and local regulations first.
// * Put the admin behind real auth (ADMIN_TOKEN + reverse proxy) before
//   exposing it beyond localhost.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT || 8787);
const DATA_FILE = path.join(__dirname, 'data', 'db.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const OBSERVER_SECRET = process.env.OBSERVER_SECRET || '';
const DEMO_MODE = !process.env.WHATSAPP_TOKEN;

// ---------- helpers ----------
const paise = (rupees) => Math.round(Number(rupees) * 100);
const rupees = (p) => (p / 100).toFixed(2);
const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`.toUpperCase();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const maskPhone = (p) => p ? `******${String(p).slice(-4)}` : '';
const isValidPhone = (p) => /^[6-9]\d{9}$/.test(String(p || '').replace(/^\+91/, '').replace(/\s/g, ''));
const cleanPhone = (p) => String(p || '').replace(/^\+91/, '').replace(/\D/g, '');

// NPCI UPI linking spec: upi://pay?pa=&pn=&am=&cu=INR&tn=&tr=
// pa = payee VPA (mandatory), pn = payee name, am = 2-decimal INR,
// cu = INR, tn = note (max 80 chars), tr = unique merchant reference (max 35).
function buildUpiUri({ upiId, payeeName, amountPaise, note, ref }) {
  const q = new URLSearchParams();
  q.set('pa', upiId);
  q.set('pn', payeeName);
  q.set('am', rupees(amountPaise));
  q.set('cu', 'INR');
  if (note) q.set('tn', String(note).slice(0, 80));
  if (ref) q.set('tr', String(ref).replace(/[^A-Za-z0-9]/g, '').slice(0, 35));
  return `upi://pay?${q.toString()}`;
}

// Parse a bank credit alert (SMS or Gmail body). Returns null if unusable.
// Looks for a credited/received amount and, when present, a 12-digit UTR.
function parseBankAlert(text = '') {
  const t = String(text);
  const isCredit = /credit|credited|received|deposited/i.test(t);
  const isDebit = /debit|debited|withdrawn|spent/i.test(t);
  if (!isCredit || isDebit) return null;
  const amt = t.match(/(?:Rs\.?|INR|₹)\s*([\d,]+\.\d{2})/i) || t.match(/(?:Rs\.?|INR|₹)\s*([\d,]+)/i);
  if (!amt) return null;
  const amountPaise = paise(amt[1].replace(/,/g, ''));
  const utrMatch = t.match(/UTR[:\s]*([0-9]{12})/i) || t.match(/\b([0-9]{12})\b/);
  return { amountPaise, utr: utrMatch ? utrMatch[1] : null, raw: t.slice(0, 500) };
}

// ---------- state (JSON file, atomic-ish rewrite) ----------
let db = { merchant: null, payments: [], observations: [], webhookLog: [] };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { /* first run */ }
if (!db.merchant) {
  db.merchant = {
    businessName: 'Demo Store', upiId: 'demo@upi', payeeName: 'Demo Store',
    bankName: '', accountHolder: '', logoUrl: '', primaryColor: '#0f766e',
    webhookUrl: '', webhookSecret: '',
  };
}
db.payments ||= []; db.observations ||= []; db.webhookLog ||= [];
function save() { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(db, null, 2)); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); }
if (!fs.existsSync(DATA_FILE)) save();

const otps = new Map(); // paymentId -> {hash, expiresAt, attempts, phone}
const sseClients = new Set();
function publicPayment(p) {
  const { ...rest } = p;
  return { ...rest, phone: maskPhone(p.phone) };
}
function broadcast(p) { const msg = `data: ${JSON.stringify(publicPayment(p))}\n\n`; for (const res of sseClients) { try { res.write(msg); } catch { sseClients.delete(res); } } }
function queuePosition(p) {
  if (p.status !== 'QUEUED') return 0;
  return db.payments.filter(x => x.status === 'QUEUED' && x.createdAt <= p.createdAt).length;
}
function promoteNext() {
  if (db.payments.some(x => x.status === 'ACTIVE')) return;
  const next = db.payments.filter(x => x.status === 'QUEUED').sort((a, b) => a.createdAt - b.createdAt)[0];
  if (next) { next.status = 'ACTIVE'; next.activatedAt = Date.now(); broadcast(next); }
}
function expireSweep() {
  let changed = false;
  for (const p of db.payments) {
    if (p.status === 'ACTIVE' && Date.now() - p.activatedAt > 5 * 60 * 1000) { p.status = 'EXPIRED'; p.endedAt = Date.now(); changed = true; broadcast(p); }
  }
  if (changed) promoteNext();
  if (changed) save();
}
setInterval(expireSweep, 10 * 1000);

async function sendWebhook(p) {
  const { webhookUrl, webhookSecret } = db.merchant;
  if (!webhookUrl) return;
  const payload = { event: 'SUCCESS', paymentId: p.id, orderId: p.orderId, amount: rupees(p.amountPaise), amountPaise: p.amountPaise, currency: 'INR', method: p.method, utr: p.utr || null, completedAt: new Date(p.endedAt || Date.now()).toISOString(), deliveryId: crypto.randomUUID() };
  const body = JSON.stringify(payload);
  const sig = webhookSecret ? 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(body).digest('hex') : '';
  try {
    const r = await fetch(webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gateway-event': 'SUCCESS', 'x-gateway-delivery-id': payload.deliveryId, 'x-gateway-signature': sig }, body });
    db.webhookLog.unshift({ at: Date.now(), paymentId: p.id, status: r.status, ok: r.ok }); db.webhookLog = db.webhookLog.slice(0, 100); save();
  } catch (e) { db.webhookLog.unshift({ at: Date.now(), paymentId: p.id, status: 0, ok: false, error: String(e.message).slice(0, 200) }); save(); }
}
function confirmPayment(p, { method = 'UPI', utr = null, verification = 'observer' }) {
  if (p.status !== 'ACTIVE' && p.status !== 'QUEUED') return false;
  p.status = 'CONFIRMED'; p.method = method; p.utr = utr; p.verification = verification; p.endedAt = Date.now();
  save(); broadcast(p); promoteNext(); save(); sendWebhook(p);
  return true;
}

// WhatsApp Cloud API: approved Authentication template only.
// POST https://graph.facebook.com/v21.0/<PHONE_NUMBER_ID>/messages
async function sendWhatsAppOtp(phone, code) {
  const token = process.env.WHATSAPP_TOKEN, phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID, template = process.env.WHATSAPP_TEMPLATE_NAME || 'otp_code';
  if (!token || !phoneId) return { delivered: false, mode: 'demo' };
  const r = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: `91${phone}`, type: 'template', template: { name: template, language: { code: 'en_US' }, components: [{ type: 'body', parameters: [{ type: 'text', text: code }] }] } }),
  });
  if (!r.ok) throw new Error(`WhatsApp API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return { delivered: true, mode: 'whatsapp' };
}

// ---------- http helpers ----------
function readJson(req) { return new Promise((resolve) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); }); }
function send(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }
function sendHtml(res, html) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); }
function requireAdmin(req, res) {
  if (!ADMIN_TOKEN) return true;
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) { send(res, 401, { error: 'Admin token required. Set ADMIN_TOKEN and send it as x-admin-token.' }); return false; }
  return true;
}
function requireObserver(req, res) {
  if (!OBSERVER_SECRET) return true;
  if (req.headers['x-observer-secret'] !== OBSERVER_SECRET) { send(res, 401, { error: 'Observer secret required.' }); return false; }
  return true;
}

// ---------- routes ----------
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  // Public merchant branding (no secrets, no bank account numbers)
  if (req.method === 'GET' && url.pathname === '/api/merchant') {
    const m = db.merchant;
    return send(res, 200, { businessName: m.businessName, upiId: m.upiId, payeeName: m.payeeName, logoUrl: m.logoUrl, primaryColor: m.primaryColor, demoMode: DEMO_MODE });
  }
  // Create a checkout payment. Exactly one ACTIVE UPI payment at a time.
  if (req.method === 'POST' && url.pathname === '/api/checkout') {
    const body = await readJson(req);
    const amountPaise = paise(body.amount);
    if (!amountPaise || amountPaise <= 0) return send(res, 400, { error: 'Valid amount in rupees is required.' });
    const hasActive = db.payments.some(x => x.status === 'ACTIVE');
    const p = { id: uid('PAY'), orderId: String(body.orderId || uid('ORD')), description: String(body.description || '').slice(0, 200), amountPaise, currency: 'INR', status: hasActive ? 'QUEUED' : 'ACTIVE', method: 'UPI', phone: '', phoneVerified: false, verification: null, utr: null, createdAt: Date.now(), activatedAt: hasActive ? null : Date.now(), endedAt: null };
    db.payments.unshift(p); save(); broadcast(p);
    return send(res, 201, { ...publicPayment(p), position: queuePosition(p) });
  }
  // Send WhatsApp OTP (real only when WHATSAPP_* configured; otherwise demo code)
  if (req.method === 'POST' && url.pathname === '/api/otp/send') {
    const body = await readJson(req);
    const p = db.payments.find(x => x.id === body.paymentId);
    if (!p) return send(res, 404, { error: 'Payment not found.' });
    const phone = cleanPhone(body.phone);
    if (!isValidPhone(phone)) return send(res, 400, { error: 'Enter a valid 10-digit Indian mobile number.' });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    otps.set(p.id, { hash: sha(code), expiresAt: Date.now() + 5 * 60 * 1000, attempts: 0, phone });
    p.phone = phone; save();
    try {
      const result = await sendWhatsAppOtp(phone, code);
      if (result.delivered) return send(res, 200, { delivered: true, mode: 'whatsapp', message: 'OTP sent on WhatsApp.' });
    } catch (e) { return send(res, 502, { error: 'WhatsApp delivery failed: ' + e.message + ' Check WHATSAPP_TOKEN / PHONE_NUMBER_ID / template approval.' }); }
    // DEMO fallback — never claim this was sent on WhatsApp.
    return send(res, 200, { delivered: false, mode: 'demo', demoOtp: code, message: 'Demo mode: WhatsApp is not configured, so the code is shown here. Configure WHATSAPP_* to send it for real.' });
  }
  if (req.method === 'POST' && url.pathname === '/api/otp/verify') {
    const body = await readJson(req);
    const p = db.payments.find(x => x.id === body.paymentId);
    const entry = otps.get(body.paymentId);
    if (!p || !entry) return send(res, 400, { error: 'No OTP was requested for this payment.' });
    if (Date.now() > entry.expiresAt) return send(res, 400, { error: 'OTP expired. Request a new one.' });
    if (entry.attempts >= 5) return send(res, 429, { error: 'Too many attempts. Request a new OTP.' });
    entry.attempts++;
    if (crypto.timingSafeEqual(Buffer.from(sha(String(body.code || ''))), Buffer.from(entry.hash))) {
      p.phoneVerified = true; otps.delete(body.paymentId); save(); broadcast(p);
      return send(res, 200, { verified: true });
    }
    return send(res, 400, { error: 'Wrong code. Try again.' });
  }
  // Payment status + QR (QR only after phone verification and when ACTIVE)
  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'payments' && parts[3] === 'qr') {
    const p = db.payments.find(x => x.id === parts[2]);
    if (!p) return send(res, 404, { error: 'Payment not found.' });
    if (!p.phoneVerified) return send(res, 403, { error: 'Verify your phone with the WhatsApp OTP first.' });
    if (p.status !== 'ACTIVE') return send(res, 409, { error: `Payment is ${p.status}. ${p.status === 'QUEUED' ? 'Your turn is coming — position ' + queuePosition(p) + '.' : 'It cannot show a QR now.'}` });
    const upiUri = buildUpiUri({ upiId: db.merchant.upiId, payeeName: db.merchant.payeeName, amountPaise: p.amountPaise, note: p.description || `Order ${p.orderId}`, ref: p.id });
    const qrDataUrl = await QRCode.toDataURL(upiUri, { width: 280, margin: 1 });
    return send(res, 200, { upiUri, qrDataUrl, payee: db.merchant.payeeName, upiId: db.merchant.upiId, amount: rupees(p.amountPaise) });
  }
  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'payments' && parts[3] === 'events') {
    const p = db.payments.find(x => x.id === parts[2]);
    if (!p) return send(res, 404, { error: 'Payment not found.' });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ ...publicPayment(p), position: queuePosition(p) })}\n\n`);
    sseClients.add(res); req.on('close', () => sseClients.delete(res)); return;
  }
  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'payments' && parts[2]) {
    const p = db.payments.find(x => x.id === parts[2]);
    if (!p) return send(res, 404, { error: 'Payment not found.' });
    return send(res, 200, { ...publicPayment(p), position: queuePosition(p) });
  }
  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'payments' && parts[3] === 'cancel') {
    const p = db.payments.find(x => x.id === parts[2]);
    if (!p) return send(res, 404, { error: 'Payment not found.' });
    if (p.status === 'ACTIVE' || p.status === 'QUEUED') { p.status = 'CANCELLED'; p.endedAt = Date.now(); save(); broadcast(p); promoteNext(); save(); }
    return send(res, 200, publicPayment(p));
  }
  // Bank SMS / Gmail alert ingestion — the automated verification step.
  if (req.method === 'POST' && (url.pathname === '/api/verify/sms' || url.pathname === '/api/verify/gmail')) {
    if (!requireObserver(req, res)) return;
    const body = await readJson(req);
    const text = body.text || [body.subject, body.body].filter(Boolean).join(' ');
    const parsed = parseBankAlert(text);
    const source = url.pathname.includes('sms') ? 'bank-sms' : 'gmail';
    if (!parsed) { db.observations.unshift({ at: Date.now(), source, matched: false, reason: 'No credited amount found in alert.', raw: String(text).slice(0, 300) }); save(); return send(res, 200, { matched: false, reason: 'No credited amount found.' }); }
    const dedupeKey = body.messageId || body.sourceId || `${parsed.utr || 'no-utr'}-${parsed.amountPaise}`;
    if (db.observations.some(o => o.dedupeKey === dedupeKey)) return send(res, 200, { matched: false, reason: 'Duplicate alert already processed.' });
    const active = db.payments.find(x => x.status === 'ACTIVE' && x.amountPaise === parsed.amountPaise);
    db.observations.unshift({ at: Date.now(), source, matched: !!active, amountPaise: parsed.amountPaise, utr: parsed.utr, paymentId: active?.id || null, dedupeKey, raw: parsed.raw });
    save();
    if (!active) return send(res, 200, { matched: false, reason: 'Amount did not match the one ACTIVE payment (or none is active). Check the amount and try again — do not force-confirm.' });
    confirmPayment(active, { utr: parsed.utr, verification: source });
    return send(res, 200, { matched: true, paymentId: active.id, status: 'CONFIRMED', utr: parsed.utr });
  }
  // Counter billing: cash / card at the till. No UPI queue, confirmed by the cashier.
  if (req.method === 'POST' && url.pathname === '/api/counter') {
    if (!requireAdmin(req, res)) return;
    const body = await readJson(req);
    const amountPaise = paise(body.amount);
    if (!amountPaise || amountPaise <= 0) return send(res, 400, { error: 'Valid amount is required.' });
    if (!['CASH', 'CARD'].includes(String(body.method || '').toUpperCase())) return send(res, 400, { error: 'Method must be CASH or CARD.' });
    const p = { id: uid('PAY'), orderId: String(body.orderId || uid('ORD')), description: String(body.description || 'Counter sale').slice(0, 200), amountPaise, currency: 'INR', status: 'CONFIRMED', method: String(body.method).toUpperCase(), phone: '', phoneVerified: false, verification: 'counter', utr: String(body.reference || '').slice(0, 50) || null, createdAt: Date.now(), activatedAt: Date.now(), endedAt: Date.now() };
    db.payments.unshift(p); save(); broadcast(p); sendWebhook(p);
    return send(res, 201, publicPayment(p));
  }
  // Admin: overview, settings, manual confirm (audited, for ambiguous alerts only)
  if (req.method === 'GET' && url.pathname === '/api/admin/overview') {
    if (!requireAdmin(req, res)) return;
    const active = db.payments.find(x => x.status === 'ACTIVE') || null;
    return send(res, 200, { merchant: db.merchant, active: active ? publicPayment(active) : null, queue: db.payments.filter(x => x.status === 'QUEUED').sort((a, b) => a.createdAt - b.createdAt).map(publicPayment), payments: db.payments.map(publicPayment).slice(0, 200), observations: db.observations.slice(0, 100), webhookLog: db.webhookLog.slice(0, 50), demoMode: DEMO_MODE });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/merchant') {
    if (!requireAdmin(req, res)) return;
    const body = await readJson(req);
    for (const k of ['businessName', 'upiId', 'payeeName', 'bankName', 'accountHolder', 'logoUrl', 'primaryColor', 'webhookUrl', 'webhookSecret']) if (body[k] !== undefined) db.merchant[k] = String(body[k]).slice(0, 300);
    save(); return send(res, 200, db.merchant);
  }
  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'admin' && parts[2] === 'payments' && parts[4] === 'confirm-manual') {
    if (!requireAdmin(req, res)) return;
    const p = db.payments.find(x => x.id === parts[3]);
    if (!p) return send(res, 404, { error: 'Payment not found.' });
    const body = await readJson(req);
    if (!confirmPayment(p, { utr: body.utr || null, verification: 'manual:' + String(body.reason || 'merchant checked bank statement').slice(0, 200) })) return send(res, 409, { error: 'Payment is not ACTIVE/QUEUED.' });
    return send(res, 200, publicPayment(p));
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/export.csv') {
    if (!requireAdmin(req, res)) return;
    const rows = [['payment_id', 'order_id', 'amount_inr', 'status', 'method', 'verification', 'utr', 'created_at'].join(',')];
    for (const p of db.payments) rows.push([p.id, p.orderId, rupees(p.amountPaise), p.status, p.method, p.verification || '', p.utr || '', new Date(p.createdAt).toISOString()].join(','));
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename=payment-history.csv' }); return res.end(rows.join('\n'));
  }
  return send(res, 404, { error: 'Not found.' });
}

// ---------- static pages + server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') return send(res, 200, { status: 'UP', service: 'upi-gateway', demoMode: DEMO_MODE });
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (url.pathname === '/embed.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(fs.readFileSync(path.join(__dirname, 'public', 'embed.js'))); }
    if (url.pathname === '/admin.html') return sendHtml(res, fs.readFileSync(path.join(__dirname, 'public', 'admin.html'), 'utf8'));
    return sendHtml(res, fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'));
  } catch (e) { send(res, 500, { error: String(e.message) }); }
});
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => console.log(`UPI gateway running at http://localhost:${PORT}  (demo mode: ${DEMO_MODE ? 'WhatsApp OTP shown on screen' : 'WhatsApp Cloud API'})`));
}
module.exports = { buildUpiUri, parseBankAlert, paise, rupees, isValidPhone };
