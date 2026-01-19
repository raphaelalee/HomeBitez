// controllers/checkoutController.js
// HomeBitez - Session-based checkout (PayPal + NETS QR)

const paypal = require("../services/paypal");
const nets = require("../services/nets");
const OrdersModel = require("../Models/OrdersModel");

// IMPORTANT: use the sandbox txn_id NETS gave you (the one you used before)
const NETS_TXN_ID = "sandbox_nets|m|8ff8e5b6-d43e-4786-8ac5-7accf8c5bd9b";

/**
 * GET /checkout
 */
exports.renderCheckout = (req, res) => {
  const cart = req.session.cart || [];

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
 */
exports.createPaypalOrder = async (req, res) => {
  try {
    // build items from session cart (same logic as renderCheckout)
    const cart = req.session.cart || [];
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

    if (!items || items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    const deliveryFee = parseFloat(req.body.deliveryFee || 0);
    if (!Number.isFinite(deliveryFee) || deliveryFee < 0) {
      return res.status(400).json({ error: "Invalid delivery fee" });
    }

    const subtotal = items.reduce(
      (s, i) => s + (Number(i.subtotal) || (Number(i.price || 0) * Number(i.qty || 0))),
      0
    );

    if (!Number.isFinite(subtotal) || subtotal <= 0) {
      return res.status(400).json({ error: "Invalid subtotal" });
    }

    const total = Number((subtotal + deliveryFee).toFixed(2));

    const shippingName =
      req.body.shippingName ||
      (req.session.user && (req.session.user.username || req.session.user.name)) ||
      null;

    const order = await paypal.createOrder(total, { shippingName });

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

    // Persist order to DB (if possible)
    try {
      const pending = req.session ? req.session.paypalPending : null;
      const cart = req.session ? (req.session.cart || []) : [];

      const items = cart.map((i) => ({ name: i.name, price: Number(i.price || 0), qty: Number(i.quantity || i.qty || 0) }));

      const subtotal = Number((items.reduce((s, it) => s + (Number(it.price || 0) * Number(it.qty || 0)), 0)).toFixed(2));
      const deliveryFee = pending && Number(pending.total) ? Number((pending.total - subtotal).toFixed(2)) : 0;
      const total = pending && Number(pending.total) ? Number(pending.total) : subtotal + deliveryFee;

      const orderIdInserted = await OrdersModel.create({
        userId: req.session && req.session.user ? req.session.user.id : null,
        paypalOrderId: orderId,
        paypalCaptureId: req.session.paypalCapture.captureId || null,
        payerEmail: req.session.paypalCapture.payerEmail || null,
        shippingName: pending ? pending.shippingName : null,
        items,
        subtotal,
        deliveryFee,
        total
      });

      // Save DB id into session for later display if needed
      if (req.session) req.session.latestOrderDbId = orderIdInserted;
      console.log('checkoutController: persisted order id=', orderIdInserted, 'paypalOrderId=', orderId);

      // keep paypalPending for receipt rendering; cart will be cleared when rendering receipt
    } catch (dbErr) {
      console.error('Failed to persist order to DB:', dbErr);
      // don't fail the response because of DB error
    }

    return res.json({ ok: true, capture });
  } catch (err) {
    console.error("HomeBitez capturePaypalOrder error:", err);
    return res.status(500).json({ error: "Failed to capture PayPal order" });
  }
};

/**
 * POST /nets-qr/request
 * This MUST be a normal form POST (not fetch) so we can render netsQr.ejs
 */
exports.requestNetsQr = async (req, res) => {
  try {
    const cartTotal = Number(req.body.cartTotal);

    if (!Number.isFinite(cartTotal) || cartTotal <= 0) {
      return res.render("netsQrFail", {
        title: "Error",
        responseCode: "N.A.",
        instructions: "",
        errorMsg: "Invalid amount. Cart total is missing/zero.",
      });
    }

    const qrData = await nets.requestNetsQr(cartTotal, NETS_TXN_ID);
    console.log("NETS qrData:", qrData);

    if (nets.isQrSuccess(qrData)) {
      // store pending reference
      req.session.netsPending = {
        txnRetrievalRef: qrData.txn_retrieval_ref,
        amount: cartTotal,
        createdAt: Date.now(),
      };

      return res.render("netsQR", {
        qrCodeUrl: `data:image/png;base64,${qrData.qr_code}`,
        txnRetrievalRef: qrData.txn_retrieval_ref,
        amount: cartTotal,
      });
    }

    // Not success -> show real error info (so you can debug)
    return res.render("netsQrFail", {
      title: "Error",
      responseCode: qrData.response_code || "N.A.",
      instructions: qrData.instruction || "",
      errorMsg: qrData.error_message || "NETS failed to generate QR. Check API key / project id / txn_id.",
    });
  } catch (err) {
    console.error("NETS requestNetsQr error:", err?.response?.data || err.message || err);
    return res.render("netsQrFail", {
      title: "Error",
      responseCode: "N.A.",
      instructions: "",
      errorMsg: "NETS payment failed (server error). Check console for details.",
    });
  }
};

/**
 * GET /receipt
 * Render a simple receipt page after successful PayPal capture
 */
exports.renderReceipt = (req, res) => {
  const paypalPending = req.session ? req.session.paypalPending : null;
  const paypalCapture = req.session ? req.session.paypalCapture : null;

  // If there's no captured payment, redirect back to checkout
  if (!paypalPending || !paypalCapture) {
    return res.redirect('/checkout');
  }

  const cart = req.session.cart || [];

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
  const total = Number((paypalPending.total || subtotal).toFixed(2));
  const deliveryFee = Number((total - subtotal).toFixed(2));

  // Clear cart and pending flags so user doesn't accidentally reuse them
  if (req.session) {
    req.session.cart = [];
    req.session.paypalPending = null;
  }
  const latestOrderDbId = req.session ? req.session.latestOrderDbId : null;

  // Optionally clear latestOrderDbId after reading (keep capture for record)
  if (req.session) req.session.latestOrderDbId = null;

  return res.render('receipt', {
    brand: 'HomeBitez',
    items,
    subtotal: Number(subtotal.toFixed(2)),
    deliveryFee,
    total,
    paypalPending,
    paypalCapture,
    latestOrderDbId,
    user: req.session.user || null,
  });
};
