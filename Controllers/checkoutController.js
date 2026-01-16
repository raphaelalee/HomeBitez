// controllers/CheckoutController.js
// HomeBitez - Session-based checkout (no DB dependency required for PayPal render)

const paypal = require("../services/paypal");

/**
 * GET /checkout
 * Renders checkout page using server-side cart snapshot (res.locals.cartDetailed).
 */
exports.renderCheckout = (req, res) => {
  // session cart from your cartController: { name, price, quantity }
  const cart = req.session.cart || [];

  // convert to the shape checkout expects: { name, price, qty, subtotal }
  const items = cart.map((i) => {
    const price = Number(i.price || 0);
    const qty = Number(i.quantity || i.qty || 0);
    return {
      name: i.name,
      price,
      qty,
      subtotal: Number((price * qty).toFixed(2)),
    };
  });

  const subtotal = items.reduce((sum, i) => sum + (Number(i.subtotal) || 0), 0);

  const defaultDeliveryFee = 2.5;

  res.render("checkout", {
    brand: "HomeBitez",
    items,
    subtotal: Number(subtotal.toFixed(2)),
    total: Number((subtotal + defaultDeliveryFee).toFixed(2)),
    defaultDeliveryFee,
    user: req.session.user || null,
    paypalClientId: process.env.PAYPAL_CLIENT_ID,
    paypalCurrency: process.env.PAYPAL_CURRENCY || "SGD",
  });
};


/**
 * POST /paypal/create-order
 * Creates PayPal order using server-calculated total (subtotal + delivery fee).
 * Accepts fallback items/subtotal from client (when cookies/sessions act funny).
 */
exports.createPaypalOrder = async (req, res) => {
  try {
    let items = res.locals.cartDetailed || [];

    // fallback: accept items from client if session cart is not available
    if ((!items || items.length === 0) && Array.isArray(req.body.items) && req.body.items.length > 0) {
      items = req.body.items;
    }

    if (!items || items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    const deliveryFee = parseFloat(req.body.deliveryFee || 0);
    if (!Number.isFinite(deliveryFee) || deliveryFee < 0) {
      return res.status(400).json({ error: "Invalid delivery fee" });
    }

    const subtotal = (typeof req.body.subtotal === "number" || typeof req.body.subtotal === "string")
      ? (parseFloat(req.body.subtotal) || 0)
      : items.reduce((s, i) => s + (Number(i.subtotal) || (Number(i.price || 0) * Number(i.qty || 0))), 0);

    if (!Number.isFinite(subtotal) || subtotal <= 0) {
      return res.status(400).json({ error: "Invalid subtotal" });
    }

    const total = Number((subtotal + deliveryFee).toFixed(2));

    const shippingName =
      req.body.shippingName ||
      (req.session.user && (req.session.user.username || req.session.user.name)) ||
      null;

    const order = await paypal.createOrder(total, { shippingName });

    // store pending proof for later steps (even if you're not doing order save yet)
    if (req.session) {
      req.session.paypalPending = {
        orderId: order.id,
        total,
        shippingName: shippingName || null,
        createdAt: Date.now(),
      };
    }

    return res.json({ id: order.id });
  } catch (err) {
    console.error("HomeBitez createPaypalOrder error:", err);
    return res.status(500).json({ error: "Failed to create PayPal order" });
  }
};

/**
 * POST /paypal/capture-order
 * Captures PayPal order and stores proof in session.
 */
exports.capturePaypalOrder = async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: "Missing orderId" });

    const capture = await paypal.captureOrder(orderId);

    if (capture.status !== "COMPLETED") {
      if (req.session) req.session.paypalCapture = null;
      return res.status(400).json({ error: "Payment not completed", capture });
    }

    if (req.session) {
      req.session.paypalCapture = {
        orderId,
        status: capture.status,
        captureId: capture?.purchase_units?.[0]?.payments?.captures?.[0]?.id || null,
        payerEmail: capture?.payer?.email_address || null,
        payerId: capture?.payer?.payer_id || null,
        capturedAt: Date.now(),
      };
    }

    // checkout-only response
    return res.json({ ok: true, capture });
  } catch (err) {
    console.error("HomeBitez capturePaypalOrder error:", err);
    return res.status(500).json({ error: "Failed to capture PayPal order" });
  }
};
