-- Run with: wrangler d1 execute clickit --remote --config server/wrangler.jsonc --file server/metrics.sql
-- Window: last 30 days. Request history is retained for 90 days.
SELECT COUNT(*) AS installations FROM installations;
SELECT source, COUNT(*) AS installations FROM installations GROUP BY source;
SELECT COUNT(*) AS activated FROM credit_lots WHERE order_id IS NULL AND consumed > 0;
SELECT COUNT(*) AS five_suggestion_users FROM installations i WHERE
  (SELECT COALESCE(SUM(consumed),0) FROM credit_lots WHERE installation_id=i.id)>=5;
SELECT COUNT(*) AS checkouts, COUNT(DISTINCT installation_id) AS checkout_users FROM checkouts
  WHERE created_at>=unixepoch()*1000-30*86400000;
SELECT COUNT(*) AS purchases, COUNT(DISTINCT installation_id) AS buyers,
  SUM(total_amount) AS gross_usd_cents, SUM(tax_amount) AS tax_usd_cents,
  SUM(refunded_amount) AS refunded_usd_cents FROM orders;
SELECT COUNT(*) AS repeat_buyers FROM (SELECT installation_id FROM orders WHERE refunded_amount<total_amount GROUP BY installation_id HAVING COUNT(*)>1);
SELECT stripe_fee_currency, SUM(stripe_fee) AS fees_minor_units, COUNT(*) AS orders FROM orders GROUP BY stripe_fee_currency;
SELECT COUNT(*) AS orders_missing_fees FROM orders WHERE stripe_fee IS NULL;
SELECT kind,COUNT(*) AS events FROM events GROUP BY kind;
SELECT mode,status,COUNT(*) AS requests,SUM(cost_nano)/1000000000.0 AS inference_usd,
  SUM(input_tokens IS NULL) AS conservative_estimates,AVG(api_ms) AS mean_api_ms FROM requests GROUP BY mode,status;
SELECT spent_nano/1000000000.0 AS budget_used_usd,limit_nano/1000000000.0 AS budget_cap_usd FROM budget;
SELECT kind,COUNT(*) AS actions,SUM(minutes) AS support_minutes FROM support_actions GROUP BY kind;
