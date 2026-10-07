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

// ---------- LOCATION CONFIG ----------

let LOCATION_MAP = {};

try {
  LOCATION_MAP = JSON.parse(E.LOCATION_MAP || "{}");
} catch {
  console.error("LOCATION_MAP invalid JSON");
  process.exit(1);
}

const ONLY_LOCATIONS = (E.ONLY_LOCATIONS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// ---------- REQUIRED ENV ----------

for (const k of [
  "SHOPIFY_STORE_DOMAIN",
  "SHOPIFY_ADMIN_ACCESS_TOKEN",
  "POSPATROL_API_KEY"
]) {
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

const amt = set =>
  num(set?.shopMoney?.amount);

const IST_MS = 5.5 * 60 * 60 * 1000;

function ist(iso) {
  const d = new Date(
    new Date(iso).getTime() + IST_MS
  );

  const p = n =>
    String(n).padStart(2, "0");

  return {
    date:
      `${d.getUTCFullYear()}` +
      `${p(d.getUTCMonth() + 1)}` +
      `${p(d.getUTCDate())}`,

    time:
      `${p(d.getUTCHours())}` +
      `${p(d.getUTCMinutes())}` +
      `${p(d.getUTCSeconds())}`
  };
}

const isDate = v =>
  /^\d{4}-\d{2}-\d{2}$/.test(v || "");

const fromMs = d =>
  new Date(
    `${d}T00:00:00+05:30`
  ).getTime();

const toMs = d =>
  new Date(
    `${d}T23:59:59.999+05:30`
  ).getTime();

// ---------- PAYMENT MAPPING ----------

function payName(gateway) {
  const v =
    String(gateway || "").toLowerCase();

  if (v.includes("cash")) {
    return "CASH";
  }

  if (
    /card|visa|master|credit|debit|pos_card|swipe/.test(v)
  ) {
    return "CARD";
  }

  if (
    /wallet|paytm|phonepe|gpay|google|upi/.test(v)
  ) {
    return "WALLET";
  }

  return "OTHERS";
}

// ---------- SHOPIFY GRAPHQL ----------

async function gql(query, variables) {
  const url =
    `https://${E.SHOPIFY_STORE_DOMAIN}` +
    `/admin/api/${API_VERSION}/graphql.json`;

  const res = await fetch(url, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token":
        E.SHOPIFY_ADMIN_ACCESS_TOKEN
    },

    body: JSON.stringify({
      query,
      variables
    })
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(
      `Shopify HTTP ${res.status}: ${text}`
    );
  }

  const json = JSON.parse(text);

  if (json.errors) {
    const errorText =
      JSON.stringify(json.errors);

    if (errorText.includes("THROTTLED")) {
      await new Promise(resolve =>
        setTimeout(resolve, 2000)
      );

      return gql(query, variables);
    }

    throw new Error(
      "Shopify GraphQL: " +
      JSON.stringify(json.errors)
    );
  }

  return json.data;
}

// ---------- MONEY ----------

const MONEY =
  "shopMoney { amount currencyCode }";

// ---------- ORDERS QUERY ----------

const ORDERS_QUERY = `
query Orders($q: String!, $cursor: String) {

  orders(
    first: 50
    after: $cursor
    query: $q
    sortKey: UPDATED_AT
  ) {

    pageInfo {
      hasNextPage
      endCursor
    }

    nodes {

      id
      name
      createdAt
      processedAt
      currencyCode

      retailLocation {
        id
        name
      }

      totalPriceSet {
        ${MONEY}
      }

      totalTaxSet {
        ${MONEY}
      }

      totalDiscountsSet {
        ${MONEY}
      }

      # IMPORTANT:
      # Order transactions are direct objects
      # in this Shopify schema.

      transactions(first: 50) {

        kind
        status
        gateway
        processedAt

        amountSet {
          ${MONEY}
        }
      }

      lineItems(first: 100) {

        nodes {

          id
          name
          title
          sku
          quantity

          originalUnitPriceSet {
            ${MONEY}
          }

          discountedTotalSet {
            ${MONEY}
          }

          totalDiscountSet {
            ${MONEY}
          }

          taxLines {

            priceSet {
              ${MONEY}
            }
          }

          variant {

            sku

            product {
              productType
            }
          }
        }
      }

      refunds {

        id
        createdAt

        totalRefundedSet {
          ${MONEY}
        }

        # IMPORTANT:
        # Refund transactions are a connection
        # in this Shopify schema.

        transactions(first: 20) {

          nodes {

            kind
            status
            gateway

            amountSet {
              ${MONEY}
            }
          }
        }

        refundLineItems(first: 100) {

          nodes {

            quantity

            subtotalSet {
              ${MONEY}
            }

            totalTaxSet {
              ${MONEY}
            }

            lineItem {

              id
              name
              title
              sku

              originalUnitPriceSet {
                ${MONEY}
              }

              variant {

                sku

                product {
                  productType
                }
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

  const lo =
    new Date(
      fromMs(from) - pad
    ).toISOString();

  const hi =
    new Date(
      toMs(to) + pad
    ).toISOString();

  const q =
    `source_name:${SOURCE} ` +
    `updated_at:>=${lo} ` +
    `updated_at:<=${hi}`;

  const out = [];

  let cursor = null;

  for (;;) {

    const data =
      await gql(
        ORDERS_QUERY,
        {
          q,
          cursor
        }
      );

    out.push(
      ...data.orders.nodes
    );

    if (
      !data.orders.pageInfo.hasNextPage
    ) {
      break;
    }

    cursor =
      data.orders.pageInfo.endCursor;
  }

  return out;
}

// ---------- LOCATION ----------

function locCode(order) {

  const id =
    order.retailLocation?.id;

  return (
    (id && LOCATION_MAP[id]) ||
    DEFAULT_LOC
  );
}

function locAllowed(order) {

  if (!ONLY_LOCATIONS.length) {
    return true;
  }

  return ONLY_LOCATIONS.includes(
    order.retailLocation?.id
  );
}

// ---------- RECEIPT ----------

const rcpt = order =>
  String(order.name || "")
    .replace("#", "");

// ---------- BASE ----------

function base(
  order,
  rcptNum,
  iso
) {

  const t = ist(iso);

  return {

    head: {

      LOCATION_CODE:
        locCode(order),

      TERMINAL_ID:
        TERMINAL,

      SHIFT_NO:
        SHIFT,

      RCPT_NUM:
        rcptNum,

      RCPT_DT:
        t.date,

      BUSINESS_DT:
        t.date,

      RCPT_TM:
        t.time
    },

    key: {

      LOCATION_CODE:
        locCode(order),

      TERMINAL_ID:
        TERMINAL,

      SHIFT_NO:
        SHIFT,

      RCPT_NUM:
        rcptNum,

      RCPT_DT:
        t.date
    }
  };
}

// ---------- BUILD RESPONSE ----------

function build(
  orders,
  from,
  to
) {

  const Transactions = [];
  const ItemDetail = [];
  const PaymentDetail = [];

  const lo = fromMs(from);
  const hi = toMs(to);

  const inRange = iso => {

    if (!iso) {
      return false;
    }

    const t =
      new Date(iso).getTime();

    return (
      t >= lo &&
      t <= hi
    );
  };

  for (const order of orders) {

    if (!locAllowed(order)) {
      continue;
    }

    const cur =
      order.currencyCode || CUR;

    const saleIso =
      order.processedAt ||
      order.createdAt;

    // ==========================================
    // SALES
    // ==========================================

    if (inRange(saleIso)) {

      const r =
        rcpt(order);

      const {
        head,
        key
      } =
        base(
          order,
          r,
          saleIso
        );

      Transactions.push({

        ...head,

        INV_AMT:
          money(
            amt(
              order.totalPriceSet
            )
          ),

        TAX_AMT:
          money(
            amt(
              order.totalTaxSet
            )
          ),

        RET_AMT:
          "0.00",

        TRAN_STATUS:
          "SALES",

        OP_CUR:
          cur,

        BC_EXCH:
          FX,

        DISCOUNT:
          money(
            amt(
              order.totalDiscountsSet
            )
          )
      });

      // ----------------------------------------
      // SALES ITEMS
      // ----------------------------------------

      for (
        const li of
        order.lineItems?.nodes || []
      ) {

        const tax =
          (
            li.taxLines || []
          ).reduce(
            (sum, t) =>
              sum +
              amt(t.priceSet),
            0
          );

        ItemDetail.push({

          ...key,

          ITEM_CODE:
            li.sku ||
            li.variant?.sku ||
            li.id,

          ITEM_NAME:
            li.name ||
            li.title,

          ITEM_QTY:
            String(
              li.quantity
            ),

          ITEM_PRICE:
            money(
              amt(
                li.originalUnitPriceSet
              )
            ),

          ITEM_CAT:
            li.variant
              ?.product
              ?.productType ||
            "OTHER",

          ITEM_TAX:
            money(tax),

          ITEM_TAX_TYPE:
            "I",

          ITEM_NET_AMT:
            money(
              amt(
                li.discountedTotalSet
              )
            ),

          OP_CUR:
            cur,

          BC_EXCH:
            FX,

          ITEM_STATUS:
            "SALES",

          ITEM_DISCOUNT:
            money(
              amt(
                li.totalDiscountSet
              )
            )
        });
      }

      // ----------------------------------------
      // SALES PAYMENTS
      // ----------------------------------------

      for (
        const tr of
        order.transactions || []
      ) {

        if (
          tr.status !== "SUCCESS"
        ) {
          continue;
        }

        if (
          ![
            "SALE",
            "CAPTURE"
          ].includes(tr.kind)
        ) {
          continue;
        }

        PaymentDetail.push({

          ...key,

          PAYMENT_NAME:
            payName(
              tr.gateway
            ),

          CURRENCY_CODE:
            cur,

          EXCHANGE_RATE:
            FX,

          TENDER_AMOUNT:
            money(
              amt(
                tr.amountSet
              )
            ),

          OP_CUR:
            cur,

          BC_EXCH:
            FX,

          PAYMENT_STATUS:
            "SALES"
        });
      }
    }

    // ==========================================
    // RETURNS
    // ==========================================

    for (
      const [i, rf] of
      (order.refunds || []).entries()
    ) {

      if (
        !inRange(
          rf.createdAt
        )
      ) {
        continue;
      }

      const r =
        `${rcpt(order)}-R${i + 1}`;

      const {
        head,
        key
      } =
        base(
          order,
          r,
          rf.createdAt
        );

      const retTax =
        (
          rf.refundLineItems
            ?.nodes || []
        ).reduce(
          (sum, n) =>
            sum +
            amt(
              n.totalTaxSet
            ),
          0
        );

      const retAmt =
        amt(
          rf.totalRefundedSet
        );

      Transactions.push({

        ...head,

        INV_AMT:
          "0.00",

        TAX_AMT:
          money(retTax),

        RET_AMT:
          money(retAmt),

        TRAN_STATUS:
          "RETURN",

        OP_CUR:
          cur,

        BC_EXCH:
          FX,

        DISCOUNT:
          "0.00"
      });

      // ----------------------------------------
      // RETURN ITEMS
      // ----------------------------------------

      for (
        const n of
        rf.refundLineItems?.nodes || []
      ) {

        const li =
          n.lineItem;

        ItemDetail.push({

          ...key,

          ITEM_CODE:
            li.sku ||
            li.variant?.sku ||
            li.id,

          ITEM_NAME:
            li.name ||
            li.title,

          ITEM_QTY:
            String(
              -Math.abs(
                n.quantity
              )
            ),

          ITEM_PRICE:
            money(
              amt(
                li.originalUnitPriceSet
              )
            ),

          ITEM_CAT:
            li.variant
              ?.product
              ?.productType ||
            "OTHER",

          ITEM_TAX:
            money(
              amt(
                n.totalTaxSet
              )
            ),

          ITEM_TAX_TYPE:
            "I",

          ITEM_NET_AMT:
            money(
              -Math.abs(
                amt(
                  n.subtotalSet
                )
              )
            ),

          OP_CUR:
            cur,

          BC_EXCH:
            FX,

          ITEM_STATUS:
            "RETURN",

          ITEM_DISCOUNT:
            "0.00"
        });
      }

      // ----------------------------------------
      // RETURN PAYMENTS
      // ----------------------------------------

      for (
        const tr of
        rf.transactions?.nodes || []
      ) {

        if (
          tr.status !== "SUCCESS"
        ) {
          continue;
        }

        if (
          tr.kind !== "REFUND"
        ) {
          continue;
        }

        PaymentDetail.push({

          ...key,

          PAYMENT_NAME:
            payName(
              tr.gateway
            ),

          CURRENCY_CODE:
            cur,

          EXCHANGE_RATE:
            FX,

          TENDER_AMOUNT:
            money(
              -Math.abs(
                amt(
                  tr.amountSet
                )
              )
            ),

          OP_CUR:
            cur,

          BC_EXCH:
            FX,

          PAYMENT_STATUS:
            "RETURN"
        });
      }
    }
  }

  return {

    Transactions,

    ItemDetail,

    PaymentDetail
  };
}

// ---------- AUTH ----------

function auth(
  req,
  res,
  next
) {

  const k =
    req.headers["x-api-key"] ||
    req.query.api_key;

  if (
    !k ||
    k !== E.POSPATROL_API_KEY
  ) {

    return res
      .status(401)
      .json({
        error:
          "Unauthorized"
      });
  }

  next();
}

// ---------- HEALTH ----------

app.get(
  "/health",
  (_req, res) => {

    res.json({

      status:
        "OK",

      time:
        new Date().toISOString()
    });
  }
);

// ---------- POSPATROL API ----------

app.get(
  "/pospatrol/transactions",
  auth,
  async (req, res) => {

    const {
      from,
      to
    } = req.query;

    if (
      !isDate(from) ||
      !isDate(to)
    ) {

      return res
        .status(400)
        .json({

          error:
            "from & to required, format YYYY-MM-DD"
        });
    }

    if (from > to) {

      return res
        .status(400)
        .json({

          error:
            "'from' cannot be after 'to'"
        });
    }

    try {

      const orders =
        await fetchOrders(
          from,
          to
        );

      const result =
        build(
          orders,
          from,
          to
        );

      res.json(result);

    } catch (err) {

      console.error(err);

      res
        .status(500)
        .json({

          error:
            "Unable to fetch transaction data",

          message:
            err.message
        });
    }
  }
);

// ---------- START SERVER ----------

app.listen(
  PORT,
  () => {

    console.log(
      `POSPatrol API running on :${PORT}`
    );
  }
);
