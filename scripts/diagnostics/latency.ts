// Read-only aggregate query; no chat IDs, message bodies or game records are emitted.
const since = Date.parse(
  process.argv[2] ?? new Date(Date.now() - 86400000).toISOString(),
);
if (!Number.isFinite(since)) throw Error("Expected an ISO timestamp");
console.log(
  `WITH recent AS (SELECT update_id,created_at,CASE WHEN json_extract(body,'$.message.text') IS NOT NULL THEN lower(substr(json_extract(body,'$.message.text'),1,instr(json_extract(body,'$.message.text')||' ',' ')-1)) ELSE '[callback]' END AS command FROM telegram_updates WHERE created_at>=${since}), timings AS (SELECT u.command,u.created_at,COUNT(d.id) AS replies,MIN(d.due_at)-u.created_at AS prepare_ms,MIN(d.sent_at)-u.created_at AS first_ms,MAX(d.sent_at)-u.created_at AS final_ms,AVG(d.sent_at-d.due_at) AS delivery_ms,MAX(d.attempts) AS attempts FROM recent u JOIN deliveries d ON d.id LIKE 'reply:'||u.update_id||':%' AND d.status='sent' GROUP BY u.update_id) SELECT CASE WHEN command IN ('/start','/help','/status','/wishlist','/deals','/add','/remove','/setprice','/setcut','/setscore','/setsconto','/setscontog','/free','/search','[callback]') THEN command ELSE '[other]' END AS command,COUNT(*) AS requests,MAX(replies) AS max_replies,ROUND(AVG(prepare_ms)/1000.0,2) AS prepare_seconds,ROUND(AVG(first_ms)/1000.0,2) AS first_seconds,ROUND(MAX(final_ms)/1000.0,2) AS worst_final_seconds,ROUND(AVG(delivery_ms)/1000.0,2) AS delivery_seconds,MAX(attempts) AS max_attempts FROM timings GROUP BY 1;`,
);
