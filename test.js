// Quick checks: UPI URI encoding, bank-alert parsing, phone validation.
const assert = require('node:assert');
const { buildUpiUri, parseBankAlert, paise, isValidPhone } = require('./server.js');

const uri = buildUpiUri({ upiId: 'shop@okhdfcbank', payeeName: 'My Shop & Co', amountPaise: 49900, note: 'Order #1', ref: 'PAY-ABC123' });
assert.ok(uri.startsWith('upi://pay?pa=shop%40okhdfcbank'), uri);
assert.ok(uri.includes('am=499.00') && uri.includes('cu=INR') && uri.includes('tr=PAYABC123'), uri);

const alert = parseBankAlert('Rs.49.00 credited to your account via UPI. UTR 123456789012. Available balance Rs.1000.00');
assert.deepStrictEqual([alert.amountPaise, alert.utr], [4900, '123456789012']);
assert.strictEqual(parseBankAlert('Rs.49.00 debited from your account'), null);
assert.strictEqual(parseBankAlert('Hello, your order shipped'), null);
assert.strictEqual(paise(49.99), 4999);
assert.ok(isValidPhone('9876543210') && !isValidPhone('12345'));
console.log('All gateway checks passed.');
process.exit(0); // server module starts a sweep interval; don't hang the test run
