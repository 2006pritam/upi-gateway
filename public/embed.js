// One-script merchant integration for the self-hosted UPI gateway.
// Usage:
//   <script src="https://YOUR-GATEWAY/embed.js" data-merchant-key="public"></script>
//   <button data-upi-pay data-amount="499" data-description="Pro plan">Buy now</button>
// Or programmatically: window.UpiPay.pay({ amount: 499, description: 'Pro plan' })
// This script only opens the host page's checkout; the host page implements the
// QR / UPI-intent / status flow (no OTP step). If you embed on your own site,
// point the script at your gateway origin, or use the server API documented
// in README.md. No secret keys belong in this script.
(function () {
  var script = document.currentScript;
  var origin = script ? new URL(script.src).origin : window.location.origin;
  function pay(opts) {
    if (window.__gatewayPay) return window.__gatewayPay(opts);
    var q = new URLSearchParams({ amount: opts.amount, description: opts.description || 'Order' });
    window.open(origin + '/?' + q.toString(), '_blank');
  }
  // Razorpay-style: new UpiCheckout({ order_id: 'PAY-…' }).open()
  function UpiCheckout(opts) { this.order_id = opts.order_id || opts.orderId; this.open = function () { window.open(origin + '/?payment=' + encodeURIComponent(this.order_id), '_blank'); }; }
  // Bind declarative buttons, including ones added later.
  function bind(root) { (root || document).querySelectorAll('[data-upi-pay]').forEach(function (b) { if (!b.dataset.upiBound) { b.dataset.upiBound = '1'; b.addEventListener('click', function () { pay({ amount: b.dataset.amount, description: b.dataset.description }); }); } }); }
  bind(); new MutationObserver(function () { bind(); }).observe(document.body, { childList: true, subtree: true });
  window.UpiPay = window.UpiPay || { pay: pay, origin: origin };
  window.UpiCheckout = window.UpiCheckout || UpiCheckout;
})();
