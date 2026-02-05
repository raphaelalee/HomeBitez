// services/paypal.js
// HomeBitez – PayPal Sandbox integration (CREATE + CAPTURE)

const fetch = require("node-fetch");

const DEFAULT_CURRENCY = process.env.PAYPAL_CURRENCY || "SGD";

/* -----------------------------
   Helpers
----------------------------- */
function getEnv(name) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : null;
}

function assertEnv(name, value) {
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
}

function getConfig() {
  const PAYPAL_CLIENT_ID = getEnv("PAYPAL_CLIENT_ID");
  const PAYPAL_CLIENT_SECRET = getEnv("PAYPAL_CLIENT_SECRET");
  const PAYPAL_API = getEnv("PAYPAL_API");

  assertEnv("PAYPAL_CLIENT_ID", PAYPAL_CLIENT_ID);
  assertEnv("PAYPAL_CLIENT_SECRET", PAYPAL_CLIENT_SECRET);
  assertEnv("PAYPAL_API", PAYPAL_API);

  return { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_API };
}

/* -----------------------------
   OAuth Token
----------------------------- */
async function getAccessToken() {
  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_API } = getConfig();

  const auth = Buffer
    .from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`)
    .toString("base64");

  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const data = await res.json();

  if (!res.ok) {
    console.error("PayPal getAccessToken failed:", {
      status: res.status,
      body: data,
    });
    throw new Error("PayPal OAuth failed");
  }

  return data.access_token;
}

/* -----------------------------
   CREATE ORDER
----------------------------- */
async function createOrder(amount, options = {}) {
  const { PAYPAL_API } = getConfig();
  const accessToken = await getAccessToken();

  const valueNum = Number(amount);
  if (!Number.isFinite(valueNum) || valueNum <= 0) {
    throw new Error(`Invalid PayPal amount: ${amount}`);
  }

  const payload = {
    intent: "CAPTURE",
    purchase_units: [
      {
        amount: {
          currency_code: options.currency || DEFAULT_CURRENCY,
          value: valueNum.toFixed(2),
        },
      },
    ],
    application_context: {
      brand_name: "HomeBitez",
      user_action: "PAY_NOW",
      shipping_preference: "NO_SHIPPING",
    },
  };

  if (options.shippingName) {
    payload.purchase_units[0].shipping = {
      name: { full_name: String(options.shippingName) },
    };
  }

  if (options.invoiceId) {
    payload.purchase_units[0].invoice_id = String(options.invoiceId);
  }

  const res = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();

  if (!res.ok) {
    console.error("PayPal createOrder failed:", {
      status: res.status,
      body: data,
      payload,
    });
    throw new Error("PayPal createOrder failed");
  }

  return data; // includes data.id
}

/* -----------------------------
   CAPTURE ORDER
----------------------------- */
async function captureOrder(orderId) {
  const { PAYPAL_API } = getConfig();
  const accessToken = await getAccessToken();

  if (!orderId) {
    throw new Error("Missing orderId for PayPal capture");
  }

  const res = await fetch(
    `${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  const text = await res.text();

  console.log("PAYPAL CAPTURE STATUS:", res.status);
  console.log("PAYPAL CAPTURE RAW RESPONSE:", text);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON from PayPal capture");
  }

  if (!res.ok) {
    console.error("PayPal captureOrder failed:", {
      status: res.status,
      body: data,
      orderId,
    });
    throw new Error("PayPal capture failed");
  }

  return data;
}

/* -----------------------------
   REFUND CAPTURE
----------------------------- */
async function refundCapture(captureId, amount, options = {}) {
  const { PAYPAL_API } = getConfig();
  const accessToken = await getAccessToken();

  if (!captureId) {
    throw new Error("Missing captureId for PayPal refund");
  }

  const valueNum = Number(amount);
  if (!Number.isFinite(valueNum) || valueNum <= 0) {
    throw new Error(`Invalid PayPal refund amount: ${amount}`);
  }

  const payload = {
    amount: {
      currency_code: options.currency || DEFAULT_CURRENCY,
      value: valueNum.toFixed(2),
    },
  };

  const res = await fetch(
    `${PAYPAL_API}/v2/payments/captures/${captureId}/refund`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    }
  );

  const data = await res.json();

  if (!res.ok) {
    console.error("PayPal refundCapture failed:", {
      status: res.status,
      body: data,
      captureId,
    });
    throw new Error("PayPal refund failed");
  }

  return data;
}

/* -----------------------------
   EXPORTS
----------------------------- */
module.exports = {
  createOrder,
  captureOrder,
  refundCapture,
};
