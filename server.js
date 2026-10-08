require("dotenv").config();
const express = require("express");

const app = express();
const E = process.env;

const PORT = E.PORT || 3000;
const API_VERSION = E.SHOPIFY_API_VERSION || "2025-07";
const CUR = E.CURRENCY_CODE || "INR";
const FX = E.EXCHANGE_RATE || "1";
const TERMINAL = E.DEFAULT_TERMINAL_ID || "01";
const SHIFT = E.DEFAULT_SHIFT_NO || "01";
const DEFAULT_LOC = E.DEFAULT_LOCATION_CODE || "01";
const SOURCE = E.SOURCE_NAME || "pos";
const DEBUG = E.DEBUG_PAYMENTS === "1";
const MAX_RETRY = Number(E.THROTTLE_MAX_RETRY || 5);

// Exchange detection: order tag / note / refund note matching this regex
const EXCHANGE_RE = new RegExp(E.EXCHANGE_REGEX || "exchange", "i");

// ---------- LOCATION CONFIG ----------
let LOCATION_MAP = {};
try {
  LOCATION_MAP = JSON.parse(E.LOCATION_MAP || "{}");
} catch {
  console.error("LOCATION_MAP invalid JSON");
  process.exit(1);
}

const ONLY_LOCATIONS = (E.ONLY_LOCATIONS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

// ---------- REQUIRED ENV ----------
for (const k of ["SHOPIFY_STORE_DOMAIN", "SHOPIFY_ADMIN_ACCESS_TOKEN", "POSPATROL_API_KEY"]) {
  if (!E[k]) {
    console.error("Missing env:", k);
    process.exit(1);
  }
}

// ---------- HELPERS ----------
const num = v => {
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
};
const money = v => num(v).toFixed(2);
const amt = set => num(set?.shopMoney?.amount);

const IST_MS = 5.5 * 60 * 60 * 1000;
function ist(iso) {
  const d = new Date(new Date(iso).getTime() + IST_MS);
  const p = n => String(n).padStart(2, "0");
  return {
    date: `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  };
}

const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || "");
const fromMs = d => new Date(`${d}T00:00:00+05:30`).getTime();
const toMs = d => new Date(`${d}T23:59:59.999+05:30`).getTime();

// ---------- PAYMENT MAPPING ----------
function payName(gateway) {
  const v = String(gateway || "").toLowerCase();
  if (v.includes("cash")) return "CASH";
  if (/card|visa|master|credit|debit|pos_card|swipe|razorpay|shopify_payments/.test(v)) return "CARD";
  if (/wallet|paytm|phonepe|gpay|google|upi/.test(v)) return "WALLET";
  return "OTHERS";
}

// Works whether Shopify returns statusV2 or status
const trStatus = tr => String(tr.statusV2 || tr.status || "").toUpperCase();

// ---------- SHOPIFY GRAPHQL ----------
async function gql(query, variables, attempt = 0) {
  const url = `https://${E.SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": E.SHOPIFY_ADMIN_ACCESS_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}: ${text}`);

  const json = JSON.parse(text);
  if (json.errors) {
    const errorText = JSON.stringify(json.errors);
    if (errorText.includes("THROTTLED") && attempt < MAX_RETRY) {
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      return gql(query, variables, attempt + 1);
    }
    throw new Error("Shopify GraphQL: " + errorText);
  }
  return json.data;
}

// ---------- ORDERS QUERY ----------
const MONEY = "shopMoney { amount currencyCode }";

const ORDERS_QUERY = `
query Orders($q: String!, $cursor: String) {
  orders(first: 50, after: $cursor, query: $q, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      name
      createdAt
      processedAt
      currencyCode
      cancelledAt
      test
      tags
      note
      displayFinancialStatus
      paymentGatewayNames

      retailLocation { id name }

      totalPriceSet { ${MONEY} }
      totalTaxSet { ${MONEY} }
      totalDiscountsSet { ${MONEY} }
      totalReceivedSet { ${MONEY} }

      transactions(first: 50) {
        kind
        status
        gateway
        processedAt
        amountSet { ${MONEY} }
      }

      lineItems(first: 100) {
        nodes {
          id
          name
          title
          sku
          quantity
          originalUnitPriceSet { ${MONEY} }
          discountedTotalSet { ${MONEY} }
          totalDiscountSet { ${MONEY} }
          discountAllocations {
            allocatedAmountSet { ${MONEY} }
          }
          taxLines { priceSet { ${MONEY} } }
          variant {
            sku
            product { productType }
          }
        }
      }

      refunds {
        id
        createdAt
        note
        totalRefundedSet { ${MONEY} }

        transactions(first: 20) {
          nodes {
            kind
            status
            gateway
            amountSet { ${MONEY} }
          }
        }

        refundLineItems(first: 100) {
          nodes {
            quantity
            subtotalSet { ${MONEY} }
            totalTaxSet { ${MONEY} }
            lineItem {
              id
              name
              title
              sku
              originalUnitPriceSet { ${MONEY} }
              variant {
                sku
                product { productType }
              }
            }
          }
        }
      }
    }
  }
}
`;

// ---------- FETCH ORDERS ----------
async function fetchOrders(from, to) {
  const pad = 86400000;
  const lo = new Date(fromMs(from) - pad).toISOString();
  const hi = new Date(toMs(to) + pad).toISOString();

  const q = `source_name:${SOURCE} updated_at:>=${lo} updated_at:<=${hi}`;

  const out = [];
  let cursor = null;
  for (;;) {
    const data = await gql(ORDERS_QUERY, { q, cursor });
    out.push(...data.orders.nodes);
    if (!data.orders.pageInfo.hasNextPage) break;
    cursor = data.orders.pageInfo.endCursor;
  }
  return out;
}

// ---------- LOCATION ----------
function locCode(order) {
  const id = order.retailLocation?.id;
  return (id && LOCATION_MAP[id]) || DEFAULT_LOC;
}

function locAllowed(order) {
  if (!ONLY_LOCATIONS.length) return true;
  return ONLY_LOCATIONS.includes(order.retailLocation?.id);
}

const rcpt = order => String(order.name || "").replace("#", "");

// ---------- BASE ----------
function base(order, rcptNum, iso) {
  const t = ist(iso);
  const loc = locCode(order);
  return {
    head: {
      LOCATION_CODE: loc,
      TERMINAL_ID: TERMINAL,
      SHIFT_NO: SHIFT,
      RCPT_NUM: rcptNum,
      RCPT_DT: t.date,
      BUSINESS_DT: t.date,
      RCPT_TM: t.time
    },
    key: {
      LOCATION_CODE: loc,
      TERMINAL_ID: TERMINAL,
      SHIFT_NO: SHIFT,
      RCPT_NUM: rcptNum,
      RCPT_DT: t.date
    }
  };
}

// ---------- EXCHANGE DETECTION ----------
const isExchangeOrder = order =>
  (order.tags || []).some(t => EXCHANGE_RE.test(t)) ||
  EXCHANGE_RE.test(order.note || "");

const isExchangeRefund = (order, rf) =>
  EXCHANGE_RE.test(rf.note || "") || isExchangeOrder(order);

// ---------- LINE ITEM MATH ----------
// Discount = line-level + order-level (discountAllocations covers both)
function lineDiscount(li) {
  const alloc = (li.discountAllocations || []).reduce(
    (s, a) => s + amt(a.allocatedAmountSet), 0
  );
  return alloc > 0 ? alloc : amt(li.totalDiscountSet);
}

function lineGross(li) {
  return amt(li.originalUnitPriceSet) * num(li.quantity);
}

// ---------- BUILD RESPONSE ----------
function build(orders, from, to) {
  const Transactions = [];
  const ItemDetail = [];
  const PaymentDetail = [];

  const lo = fromMs(from);
  const hi = toMs(to);
  const inRange = iso => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return t >= lo && t <= hi;
  };

  for (const order of orders) {
    if (!locAllowed(order)) continue;
    if (order.test) continue;
    if (order.cancelledAt) continue;

    const cur = order.currencyCode || CUR;
    const saleIso = order.processedAt || order.createdAt;
    const saleStatus = isExchangeOrder(order) ? "EXCHANGE" : "SALES";

    if (DEBUG) {
      console.log("DEBUG", order.name, JSON.stringify({
        fin: order.displayFinancialStatus,
        gateways: order.paymentGatewayNames,
        transactions: order.transactions
      }));
    }

    // ================= SALES / EXCHANGE =================
    if (inRange(saleIso)) {
      const r = rcpt(order);
      const { head, key } = base(order, r, saleIso);

      Transactions.push({
        ...head,
        INV_AMT: money(amt(order.totalPriceSet)),
        TAX_AMT: money(amt(order.totalTaxSet)),
        RET_AMT: "0.00",
        TRAN_STATUS: saleStatus,
        OP_CUR: cur,
        BC_EXCH: FX,
        DISCOUNT: money(amt(order.totalDiscountsSet))
      });

      // ---- items ----
      for (const li of order.lineItems?.nodes || []) {
        const tax = (li.taxLines || []).reduce((s, t) => s + amt(t.priceSet), 0);
        const disc = lineDiscount(li);
        const net = Math.max(lineGross(li) - disc, 0);

        ItemDetail.push({
          ...key,
          ITEM_CODE: li.sku || li.variant?.sku || li.id,
          ITEM_NAME: li.name || li.title,
          ITEM_QTY: String(li.quantity),
          ITEM_PRICE: money(amt(li.originalUnitPriceSet)),
          ITEM_CAT: li.variant?.product?.productType || "OTHER",
          ITEM_TAX: money(tax),
          ITEM_TAX_TYPE: "I",
          ITEM_NET_AMT: money(net),
          OP_CUR: cur,
          BC_EXCH: FX,
          ITEM_STATUS: saleStatus,
          ITEM_DISCOUNT: money(disc)
        });
      }

      // ---- payments ----
      let paid = 0;
      for (const tr of order.transactions || []) {
        if (trStatus(tr) !== "SUCCESS") continue;
        if (!["SALE", "CAPTURE"].includes(String(tr.kind).toUpperCase())) continue;

        const a = amt(tr.amountSet);
        paid += a;
        PaymentDetail.push({
          ...key,
          PAYMENT_NAME: payName(tr.gateway),
          CURRENCY_CODE: cur,
          EXCHANGE_RATE: FX,
          TENDER_AMOUNT: money(a),
          OP_CUR: cur,
          BC_EXCH: FX,
          PAYMENT_STATUS: saleStatus
        });
      }

      // Fallback: transactions did not match but order shows received amount
      if (paid === 0) {
        const received = amt(order.totalReceivedSet) || amt(order.totalPriceSet);
        const gw = (order.paymentGatewayNames || [])[0];
        if (received > 0 && gw) {
          PaymentDetail.push({
            ...key,
            PAYMENT_NAME: payName(gw),
            CURRENCY_CODE: cur,
            EXCHANGE_RATE: FX,
            TENDER_AMOUNT: money(received),
            OP_CUR: cur,
            BC_EXCH: FX,
            PAYMENT_STATUS: saleStatus
          });
        }
      }
    }

    // ================= RETURNS =================
    for (const [i, rf] of (order.refunds || []).entries()) {
      if (!inRange(rf.createdAt)) continue;

      // Exchange-side refund is still a return line, tagged separately
      const retStatus = isExchangeRefund(order, rf) ? "EXCHANGE_RETURN" : "RETURN";

      const r = `${rcpt(order)}-R${i + 1}`;
      const { head, key } = base(order, r, rf.createdAt);

      const retTax = (rf.refundLineItems?.nodes || []).reduce(
        (s, n) => s + amt(n.totalTaxSet), 0
      );
      const retAmt = amt(rf.totalRefundedSet);

      Transactions.push({
        ...head,
        INV_AMT: "0.00",
        TAX_AMT: money(retTax),
        RET_AMT: money(retAmt),
        TRAN_STATUS: retStatus,
        OP_CUR: cur,
        BC_EXCH: FX,
        DISCOUNT: "0.00"
      });

      for (const n of rf.refundLineItems?.nodes || []) {
        const li = n.lineItem;
        if (!li) continue;
        ItemDetail.push({
          ...key,
          ITEM_CODE: li.sku || li.variant?.sku || li.id,
          ITEM_NAME: li.name || li.title,
          ITEM_QTY: String(-Math.abs(n.quantity)),
          ITEM_PRICE: money(amt(li.originalUnitPriceSet)),
          ITEM_CAT: li.variant?.product?.productType || "OTHER",
          ITEM_TAX: money(amt(n.totalTaxSet)),
          ITEM_TAX_TYPE: "I",
          ITEM_NET_AMT: money(-Math.abs(amt(n.subtotalSet))),
          OP_CUR: cur,
          BC_EXCH: FX,
          ITEM_STATUS: retStatus,
          ITEM_DISCOUNT: "0.00"
        });
      }

      let refunded = 0;
      for (const tr of rf.transactions?.nodes || []) {
        if (trStatus(tr) !== "SUCCESS") continue;
        if (String(tr.kind).toUpperCase() !== "REFUND") continue;

        const a = Math.abs(amt(tr.amountSet));
        refunded += a;
        PaymentDetail.push({
          ...key,
          PAYMENT_NAME: payName(tr.gateway),
          CURRENCY_CODE: cur,
          EXCHANGE_RATE: FX,
          TENDER_AMOUNT: money(-a),
          OP_CUR: cur,
          BC_EXCH: FX,
          PAYMENT_STATUS: retStatus
        });
      }

      // Fallback for refunds with no matching transaction (e.g. store credit exchange)
      if (refunded === 0 && retAmt > 0) {
        PaymentDetail.push({
          ...key,
          PAYMENT_NAME: payName((order.paymentGatewayNames || [])[0]),
          CURRENCY_CODE: cur,
          EXCHANGE_RATE: FX,
          TENDER_AMOUNT: money(-Math.abs(retAmt)),
          OP_CUR: cur,
          BC_EXCH: FX,
          PAYMENT_STATUS: retStatus
        });
      }
    }
  }

  // Reconciliation warnings (logged only, not sent to Pathfinder)
  for (const t of Transactions) {
    if (t.TRAN_STATUS === "RETURN" || t.TRAN_STATUS === "EXCHANGE_RETURN") continue;
    const items = ItemDetail.filter(i => i.RCPT_NUM === t.RCPT_NUM);
    const sum = items.reduce((s, i) => s + num(i.ITEM_NET_AMT), 0);
    if (Math.abs(sum - num(t.INV_AMT)) > 1) {
      console.warn(`MISMATCH ${t.RCPT_NUM}: items ${sum.toFixed(2)} vs INV_AMT ${t.INV_AMT}`);
    }
    const pays = PaymentDetail.filter(p => p.RCPT_NUM === t.RCPT_NUM);
    if (!pays.length) console.warn(`NO PAYMENT ${t.RCPT_NUM}`);
  }

  return { Transactions, ItemDetail, PaymentDetail };
}

// ---------- AUTH ----------
function auth(req, res, next) {
  const k = req.headers["x-api-key"] || req.query.api_key;
  if (!k || k !== E.POSPATROL_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ---------- HEALTH ----------
app.get("/health", (_req, res) => {
  res.json({ status: "OK", time: new Date().toISOString() });
});

// ---------- POSPATROL API ----------
app.get("/pospatrol/transactions", auth, async (req, res) => {
  const { from, to } = req.query;

  if (!isDate(from) || !isDate(to)) {
    return res.status(400).json({ error: "from & to required, format YYYY-MM-DD" });
  }
  if (from > to) {
    return res.status(400).json({ error: "'from' cannot be after 'to'" });
  }

  try {
    const orders = await fetchOrders(from, to);
    res.json(build(orders, from, to));
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Unable to fetch transaction data",
      message: err.message
    });
  }
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`POSPatrol API running on :${PORT}`);
});
