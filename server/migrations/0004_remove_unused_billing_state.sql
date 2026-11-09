/* Checkout URLs, expiry, and schedule IDs are retrieved from Stripe when needed. */
ALTER TABLE billing_accounts DROP COLUMN checkout_url;
ALTER TABLE billing_accounts DROP COLUMN checkout_expires_at;
ALTER TABLE subscriptions DROP COLUMN schedule_id;
