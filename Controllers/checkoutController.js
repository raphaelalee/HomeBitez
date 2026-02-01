// controllers/checkoutController.js
// HomeBitez – Checkout (PayPal + NETS)

const paypal = require("../services/paypal");
const nets = require("../services/nets");
const OrdersModel = require("../Models/OrdersModel");
const CartModel = require("../Models/cartModels");

// NETS sandbox txn id (keep yours)
const NETS_TXN_ID =
  "sandbox_nets|m|8ff8e5b6-d43e-4786-8ac5-7accf8c5bd9b";

/* =========================
   GET /checkout
========================= */
exports.renderCheckout = (req, res) => {
  const cart = req.session.cart || [];
  const prefs = req.session.cartPrefs || {
    cutlery: false,
    pickupDate: "",
    pickupTime: "",
    mode: "pickup",
    name: "",
    address: "",
    contact: "",
    notes: ""
  };

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

  const subtotal = items.reduce((s, i) => s + i.subtotal, 0);
  const deliveryFee = 2.5;
  const initialMode = prefs.mode || "pickup";
  const initialDeliveryFee = initialMode === "delivery" ? deliveryFee : 0;
  const total = Number((subtotal + initialDeliveryFee).toFixed(2));

  res.render("checkout", {
    brand: "HomeBitez",
    items,
    subtotal: Number(subtotal.toFixed(2)),
    total,                          // total based on initial mode
    defaultDeliveryFee: deliveryFee, // base delivery fee
    initialDeliveryFee,
    prefs,
    user: req.session.user || null,
    paypalClientId: process.env.PAYPAL_CLIENT_ID,
    paypalCurrency: process.env.PAYPAL_CURRENCY || "SGD",
  });
};

/* =========================
   GET /paylater
========================= */
exports.renderPayLater = (req, res) => {
  const creditLimit = 300.0;
  const walletBalance = 120.5;
  const plan = req.session.paylaterPlan || null;
  const outstanding = plan ? Number(plan.total || 0) : 120.0;
  const availableCredit = Number((creditLimit - outstanding).toFixed(2));
  const planMonths = plan ? Number(plan.months || 0) : 3;
  const monthly = planMonths ? Number((outstanding / planMonths).toFixed(2)) : 0;
  const today = new Date();
  const nextDueDate = new Date(today);
  nextDueDate.setDate(today.getDate() + 30);

  const schedule = planMonths
    ? [
        { dueDate: nextDueDate, amount: monthly, status: "Due" },
        {
          dueDate: new Date(today.getFullYear(), today.getMonth() + 2, today.getDate()),
          amount: monthly,
          status: "Upcoming",
        },
        {
          dueDate: new Date(today.getFullYear(), today.getMonth() + 3, today.getDate()),
          amount: monthly,
          status: "Upcoming",
        },
      ]
    : [];

  const paylaterMessage = req.session.paylaterMessage || null;
  const paylaterError = req.session.paylaterError || null;
  req.session.paylaterMessage = null;
  req.session.paylaterError = null;

  res.render("homebitez-paylater", {
    creditLimit,
    outstanding,
    availableCredit,
    walletBalance,
    planMonths,
    monthly,
    nextDueDate,
    schedule,
    paylaterMessage,
    paylaterError,
  });
};

/* =========================
   POST /paylater/choose
========================= */
exports.choosePayLater = (req, res) => {
  const months = Number(req.body.months);
  if (![3, 6].includes(months)) {
    req.session.paylaterError = "Please select a valid PayLater plan.";
    return res.redirect("/paylater");
  }

  const cart = req.session.cart || [];
  const prefs = req.session.cartPrefs || { mode: "pickup" };
  const subtotal = cart.reduce(
    (s, i) => s + Number(i.price || 0) * Number(i.quantity || i.qty || 0),
    0
  );
  const deliveryFee = prefs.mode === "delivery" ? 2.5 : 0;
  const total = Number((subtotal + deliveryFee).toFixed(2));

  if (!Number.isFinite(total) || total <= 0) {
    req.session.paylaterError = "Cart total is invalid for PayLater.";
    return res.redirect("/checkout");
  }

  const paylaterPlan = {
    months,
    total,
    monthly: Number((total / months).toFixed(2)),
    createdAt: Date.now(),
  };
  req.session.paylaterPlan = paylaterPlan;
  req.session.paylaterPurchase = paylaterPlan;
  req.session.paylaterMessage = `PayLater plan set: ${months} months.`;

  return res.redirect("/receipt");
};

/* =========================
   POST /paypal/create-order
========================= */
exports.createPaypalOrder = async (req, res) => {
  try {
    const cart = req.session.cart || [];
    if (!cart.length) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    const subtotal = cart.reduce(
      (s, i) => s + Number(i.price || 0) * Number(i.quantity || i.qty || 0),
      0
    );

    const deliveryFee = Number(req.body.deliveryFee || 0);
    const total = Number((subtotal + deliveryFee).toFixed(2));

    const shippingName =
      req.body.shippingName ||
      (req.session.user && (req.session.user.username || req.session.user.name)) ||
      null;

    const order = await paypal.createOrder(total, { shippingName });

    // store pending info in session
    req.session.paypalPending = {
      paypalOrderId: order.id,
      total,
      createdAt: Date.now(),
    };

    return res.json({ id: order.id });
  } catch (err) {
    console.error("createPaypalOrder error:", err);
    return res.status(500).json({ error: "Failed to create PayPal order" });
  }
};

/* =========================
   POST /paypal/capture-order
========================= */
exports.capturePaypalOrder = async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ error: "Missing orderId" });
    }

    const capture = await paypal.captureOrder(orderId);

    console.log(
      "FULL PAYPAL CAPTURE:",
      JSON.stringify(capture, null, 2)
    );

    // ✅ Correct PayPal success check
    const pu = capture.purchase_units?.[0];
    const cap = pu?.payments?.captures?.[0];

    if (!cap || cap.status !== "COMPLETED") {
      return res
        .status(400)
        .json({ error: "PayPal payment not completed" });
    }

    // store capture details for receipt
    req.session.paypalCapture = {
      orderId,
      captureId: cap.id,
      payerEmail: capture.payer?.email_address || null,
      total: Number(cap.amount?.value || total),
      status: cap.status
    };

    // persist order
    const cart = req.session.cart || [];
    const items = cart.map((i) => ({
      name: i.name,
      price: Number(i.price || 0),
      qty: Number(i.quantity || i.qty || 0),
    }));

    const subtotal = items.reduce(
      (s, it) => s + it.price * it.qty,
      0
    );
    const total = Number(cap.amount.value);

    const orderDbId = await OrdersModel.create({
      userId: req.session.user ? req.session.user.id : null,
      paypalOrderId: orderId,
      paypalCaptureId: cap.id,
      payerEmail: capture.payer?.email_address || null,
      items,
      subtotal,
      deliveryFee: Number((total - subtotal).toFixed(2)),
      total,
    });

    req.session.latestOrderDbId = orderDbId;

    return res.json({ ok: true });
  } catch (err) {
    console.error("capturePaypalOrder error:", err);
    return res
      .status(500)
      .json({ error: "Failed to capture PayPal order" });
  }
};

/* =========================
   POST /nets-qr/request
========================= */
exports.requestNetsQr = async (req, res) => {
  try {
    const cartTotal = Number(req.body.cartTotal);

    if (!Number.isFinite(cartTotal) || cartTotal <= 0) {
      return res.render("netsQrFail", {
        title: "Error",
        errorMsg: "Invalid cart total",
      });
    }

    const qrData = await nets.requestNetsQr(cartTotal, NETS_TXN_ID);
    const txnRetrievalRef =
      qrData?.txn_retrieval_ref ||
      qrData?.txnRetrievalRef ||
      qrData?.txn_ref ||
      null;

    if (nets.isQrSuccess(qrData)) {
      req.session.netsPending = {
        amount: cartTotal,
        txnRetrievalRef,
        createdAt: Date.now(),
      };

      return res.render("netsQR", {
        qrCodeUrl: `data:image/png;base64,${qrData.qr_code}`,
        txnRetrievalRef,
        total: cartTotal,
      });
    }

    return res.render("netsQrFail", {
      title: "Error",
      errorMsg: qrData.error_message || "NETS QR failed",
    });
  } catch (err) {
    console.error("NETS QR error:", err);
    return res.render("netsQrFail", {
      title: "Error",
      errorMsg: "NETS server error",
    });
  }
};

/* =========================
   GET /receipt
========================= */
exports.renderReceipt = async (req, res) => {
  const paypalCapture = req.session?.paypalCapture || null;
  const latestOrderDbId = req.session?.latestOrderDbId || null;
  const paylaterPurchase = req.session?.paylaterPurchase || null;

  const cart = req.session?.cart || [];
  const prefs = req.session?.cartPrefs || {
    cutlery: false,
    pickupDate: "",
    pickupTime: "",
    mode: "pickup",
    name: "",
    address: "",
    contact: "",
    notes: ""
  };

  const items = cart.map(i => ({
    name: i.name,
    price: Number(i.price || 0),
    qty: Number(i.quantity || i.qty || 0),
    subtotal: Number((Number(i.price || 0) * Number(i.quantity || i.qty || 0)).toFixed(2))
  }));

  const subtotal = items.reduce((s, i) => s + i.subtotal, 0);
  const total = paylaterPurchase?.total || paypalCapture?.total || subtotal;
  const deliveryFee = Number((total - subtotal).toFixed(2));
  const paymentMethod = paylaterPurchase ? "PayLater" : (paypalCapture ? "PayPal" : "NETS / Other");
  const fulfillment = prefs.mode === "delivery" ? "Delivery" : "Pickup";

  // hard reset session bits AFTER render
  req.session.cart = [];
  req.session.latestOrderDbId = null;
  req.session.paylaterPurchase = null;
  if (req.session.user) {
    try {
      await CartModel.clearCart(req.session.user.id);
    } catch (err) {
      console.error("Failed to clear cart in DB:", err);
    }
  }

  res.render("receipt", {
    brand: "HomeBitez",
    items,
    subtotal,
    deliveryFee,
    total,
    paypalCapture,       // <-- ALWAYS DEFINED (null or object)
    paylaterPlan: req.session?.paylaterPlan || null,
    latestOrderDbId,
    user: req.session.user || null,
    prefs,
    paymentMethod,
    fulfillment
  });
};

