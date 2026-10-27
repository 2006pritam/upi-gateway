# Self-hosted UPI payment gateway (starter)

A single-service gateway you run yourself: a white-label checkout for
customers, a clean admin dashboard for the merchant, one active UPI payment
at a time, dynamic UPI QR / mobile intent,
real-time status, bank SMS + Gmail alert verification, and cash/card
counter billing.

**Demo / learning starter — not a certified payment aggregator.** See
“Honest limits” below before any real money.

## Run it

```bash
cd upi-gateway
npm install
cp .env.example .env   # edit UPI ID and tokens (optional)
npm start              # http://localhost:8787
```

- Storefront / checkout: `http://localhost:8787/`
- Merchant admin: `http://localhost:8787/admin.html`
- Payment history export: Admin → Export CSV

## Customer flow

1. Click **Pay** on the merchant site.
2. Go straight to the QR — no OTP, no signup. (v2, on the merchant's
   request: the old WhatsApp OTP gate was removed for a Razorpay-style
   easy checkout.)
3. If another UPI payment is active, you wait in a FIFO queue — this is
   deliberate: with plain UPI alerts, two identical amounts at the same
   time can't be told apart, so only one payment is ACTIVE at a time.
4. Scan the dynamic QR (desktop) or tap **Open in UPI app** (mobile —
   GPay, PhonePe, Paytm, BHIM, etc.). The QR encodes a standard NPCI
   UPI link, per order:

   ```
   upi://pay?pa=<merchant UPI ID>&pn=<payee name>&am=<amount>&cu=INR&tn=<note>&tr=<payment ref>
   ```

   Values are percent-encoded; `tr` is unique per payment so the alert
   can be reconciled to that order.
5. Status updates live (SSE, with polling fallback in the API):
   `QUEUED → ACTIVE → CONFIRMED`, or `EXPIRED` after 5 minutes,
   `CANCELLED` if the customer cancels.

## Merchant integration — one script

On your own website, load the gateway's script and tag a button:

```html
<script src="https://YOUR-GATEWAY/embed.js"></script>
<button data-upi-pay data-amount="499" data-description="Pro plan">
  Buy now
</button>
```

Or programmatically: `window.UpiPay.pay({ amount: 499, description: 'Pro plan' })`.

### Server-side API — Razorpay-style (recommended)

Your server creates an order with your API key (shown in Admin →
API integration), then sends the customer to the checkout URL:

```bash
curl -X POST https://YOUR-GATEWAY/api/v1/orders \
  -H "x-api-key: YOUR_API_KEY" -H "content-type: application/json" \
  -d '{"amount": 49900, "receipt": "ORDER-1001"}'
# amount is in PAISE: 49900 = Rs 499.00
# → { "id": "PAY-…", "status": "created",
#     "checkout_url": "https://YOUR-GATEWAY/?payment=PAY-…" }
```

Then poll the order, or wait for the webhook:

```bash
curl https://YOUR-GATEWAY/api/v1/orders/PAY-… -H "x-api-key: YOUR_API_KEY"
# status: "created" → "paid" (gateway_status: CONFIRMED, with utr)
```

In the browser, after creating an order server-side:

```javascript
new UpiCheckout({ order_id: 'PAY-…' }).open();
```

Branding and bank details are set in Admin, not in code: business name,
UPI ID, payee name, logo, primary colour, webhook URL/secret. The
checkout shows the merchant's brand, with no forced gateway badge.

## Automated verification — bank SMS & Gmail

There is no bank webhook for a plain UPI QR, so this gateway ingests
alerts and matches them to the ACTIVE payment:

- `POST /api/verify/sms` — body `{ "text": "Rs.49.00 credited … UTR 123456789012" }`
- `POST /api/verify/gmail` — body `{ "subject": "…", "body": "…" }`

Matching rules: the alert must say credited/received (not debited),
the amount must equal the ACTIVE payment to the paise, and a repeated
alert (same message ID / UTR + amount) is ignored. On a match the
payment becomes `CONFIRMED` and a signed webhook is sent if configured:

```
POST <webhookUrl>
X-Gateway-Event: SUCCESS
X-Gateway-Delivery-Id: <uuid>
X-Gateway-Signature: sha256=<HMAC-SHA256(webhookSecret, raw body)>
{ "event": "SUCCESS", "paymentId": "…", "orderId": "…",
  "amount": "49.00", "amountPaise": 4900, "method": "UPI", "utr": "…" }
```

**Never fulfil an order from a browser event alone — verify the webhook
(or the bank statement) server-side.**

### Wiring real alerts in

- **Bank SMS:** an Android phone with the bank SIM running an SMS
  forwarder / observer app that POSTs each new bank SMS to
  `/api/verify/sms` with header `x-observer-secret` (set
  `OBSERVER_SECRET`). Keep the forwarder's allow-list to bank senders.
- **Gmail:** use Gmail API `users.watch` (Pub/Sub) or a small watcher
  that polls the bank-alert mailbox with OAuth, fetches new messages,
  and POSTs their subject/body to `/api/verify/gmail`. This starter
  does not ship Google OAuth credentials — connect your own Google
  Cloud project; the Gmail API `watch` call needs a Pub/Sub topic
  (`projects/<project>/topics/<topic>`) and `INBOX` label scope.
- **Ambiguous case:** if an alert arrives but no ACTIVE payment matches
  (wrong amount, delayed, duplicate), it is logged in Admin under
  “Recent bank alerts seen” and the payment is *not* force-confirmed.
  The merchant can confirm manually only after checking the bank
  statement — that manual confirmation is audited with the reason given.

## Counter billing — cash & card

Admin → Counter billing records a `CASH` or `CARD` sale immediately
(cashier saw the cash / card terminal approval). It bypasses the UPI
queue and appears in the same orders/history/export as UPI payments.

## No OTP in v2 — and the trade-off

The original WhatsApp OTP gate was removed because the merchant asked for
an easy, Razorpay-like checkout. That makes checkout faster, but it also
means anyone can create an order and occupy the single active slot until
it expires (5 minutes). Kept as mitigations: the single-slot queue,
5-minute expiry, a checkout rate limit, API-key auth for server-side
order creation, and exact-amount alert matching before any payment is
marked CONFIRMED. If fake orders become a problem, re-add a verification
step (email OTP, CAPTCHA, or login) in front of order creation — do not
rely on the QR alone to prove who the customer is.

## API summary

| Method | Endpoint | Notes |
|---|---|---|
| POST | `/api/checkout` | `{amount, orderId?, description?}` → payment, queue position |
| POST | `/api/v1/orders` | Razorpay-style: `{amount (paise), receipt?, notes?}` + `x-api-key` → order + `checkout_url` |
| GET | `/api/v1/orders/:id` | Order status: `created` → `paid`, with `gateway_status` and `utr` |
| POST | `/api/admin/api-key/regenerate` | New API key (admin token if set) |
| GET | `/api/payments/:id` | Status + queue position |
| GET | `/api/payments/:id/qr` | Dynamic QR + UPI intent (verified + ACTIVE only) |
| GET | `/api/payments/:id/events` | SSE live status |
| POST | `/api/payments/:id/cancel` | Release the slot |
| POST | `/api/verify/sms`, `/api/verify/gmail` | Alert ingestion |
| POST | `/api/counter` | Cash/card sale (admin token if set) |
| GET | `/api/admin/overview` | Queue, orders, alerts, webhooks |
| POST | `/api/admin/merchant` | Branding / bank / webhook settings |
| GET | `/api/admin/export.csv` | Payment history |

Data is stored in `data/db.json` (JSON, paise integers — never floats
for money). Back it up, and move to Postgres + a real queue before
any serious volume.

## Honest limits

- SMS/Gmail parsing is heuristic: formats change, alerts can be
  delayed, duplicated or spoofed. It is not settlement proof.
- A single-slot queue limits throughput by design (one active UPI
  payment per merchant at a time, 5-minute windows). For high volume,
  use a real PSP/bank aggregator API with per-order virtual accounts
  or collect requests instead of alert matching.
- No OTP means no phone verification: treat every order as untrusted
  until the payment is confirmed and the webhook is verified server-side.
- This starter has no PCI card processing: “card” here means the
  merchant's existing POS terminal, recorded in the dashboard.
- Set `ADMIN_TOKEN` and `OBSERVER_SECRET`, run behind HTTPS and real
  auth, rotate any secret that leaks, and get legal/bank advice before
  collecting payments for third parties or operating as an aggregator.
