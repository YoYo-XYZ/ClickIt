const params = new URLSearchParams(location.search);
let title, lead, hint;
// Return parameters describe navigation only. Credits are confirmed by the server.
if (params.get('cancelled') === '1') {
  title = 'Checkout canceled';
  lead = 'No new subscription was started here. Your existing plan and credits are unchanged.';
  hint = 'To try again, choose a plan in Clickit. You can close this tab.';
} else if (params.get('billing') === 'return') {
  title = 'Return to Clickit';
  lead = 'Refresh in the extension to see your current plan and credits.';
  hint = 'If you canceled renewal, remaining monthly credits last until your paid period ends. You can close this tab.';
} else if (params.get('checkout') === 'complete') {
  title = 'Check your credits';
  lead = 'Your monthly credits appear once Stripe confirms payment.';
  hint = 'If your balance has not updated, wait a moment and refresh again. You can close this tab.';
}
if (title) {
  document.title = `${title} · Clickit`;
  document.getElementById('purchaseTitle').textContent = title;
  document.getElementById('purchaseLead').textContent = lead;
  document.getElementById('purchaseHint').textContent = hint;
}
