# SuperSox POSPatrol API

GET /pospatrol/transactions?from=YYYY-MM-DD&to=YYYY-MM-DD
Header: X-API-Key: <POSPATROL_API_KEY>   (or ?api_key=...)

Returns { Transactions, ItemDetail, PaymentDetail } (Integra format).

## Setup
1. cp .env.example .env  -> fill token, location GIDs, API key
2. npm install && npm start
3. Test: /health then /pospatrol/transactions?from=2026-10-07&to=2026-10-07

Shopify custom app scopes: read_orders (+ read_all_orders for >60 days), read_locations.
Deploy on a VPS with static IP + HTTPS (nginx + pm2).

## Open items (confirm with Pathfinder)
- EXCHANGE: not implemented as separate type. Exchanges currently appear as SALES (new order) + RETURN (refund).
- RETURN receipt number = <order>-R<n>, INV_AMT=0, RET_AMT=refund total. Confirm expected format.
- TERMINAL_ID / SHIFT_NO use defaults from .env.
- Date/time fields in IST.
