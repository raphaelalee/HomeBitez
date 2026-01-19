// services/paypal.js (HomeBitez)
const fetch = require("node-fetch");

const DEFAULT_CURRENCY = process.env.PAYPAL_CURRENCY || "SGD";

// IMPORTANT:
// Sandbox: https://api-m.sandbox.paypal.com
// Live:    https://api-m.paypal.com
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

async function getAccessToken() {
  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_API } = getConfig();

  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");

  const response = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("HomeBitez PayPal getAccessToken failed", {
      status: response.status,
      body: data,
    });
    throw new Error(`PayPal getAccessToken failed: ${JSON.stringify(data)}`);
  }

  return data.access_token;
}

/**
 * Create PayPal order
 * @param {string|number} amount - Total amount, e.g. "12.34"
 * @param {object} options
 * @param {string} options.currency - e.g. "SGD"
 * @param {string} options.shippingName - optional name shown on PayPal screen
 * @param {string} options.invoiceId - optional internal reference
 * @param {string} options.description - optional description shown to payer
 */
async function createOrder(amount, options = {}) {
  const { PAYPAL_API } = getConfig();
  const accessToken = await getAccessToken();

  const valueNum = Number(amount);
  if (!Number.isFinite(valueNum) || valueNum <= 0) {
    throw new Error(`Invalid amount for createOrder: ${amount}`);
  }
  const value = valueNum.toFixed(2);

  const currency = options.currency || DEFAULT_CURRENCY;

  const payload = {
    intent: "CAPTURE",
    purchase_units: [
      {
        amount: {
          currency_code: currency,
          value,
        },
      },
    ],
    application_context: {
      brand_name: "HomeBitez",
      shipping_preference: "NO_SHIPPING", // you handle address yourself (optional)
      user_action: "PAY_NOW",
    },
  };

  // Show recipient name on PayPal approval screen (optional)
  if (options.shippingName) {
    payload.purchase_units[0].shipping = {
      name: { full_name: String(options.shippingName) },
    };
  }

  // Optional metadata
  if (options.invoiceId) payload.purchase_units[0].invoice_id = String(options.invoiceId);
  if (options.description) payload.purchase_units[0].description = String(options.description);

  const response = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("HomeBitez PayPal createOrder failed", {
      status: response.status,
      body: data,
      payload,
    });
    throw new Error(`PayPal createOrder failed: ${JSON.stringify(data)}`);
  }

  return data; // includes data.id
}

async function captureOrder(orderId) {
  const { PAYPAL_API } = getConfig();
  const accessToken = await getAccessToken();

  if (!orderId) throw new Error("Missing orderId for captureOrder");

  const response = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("HomeBitez PayPal captureOrder failed", {
      status: response.status,
      body: data,
      orderId,
    });
    throw new Error(`PayPal captureOrder failed: ${JSON.stringify(data)}`);
  }

  return data;
}

module.exports = { createOrder, captureOrder };
