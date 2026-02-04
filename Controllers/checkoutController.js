// controllers/checkoutController.js
// HomeBitez – Checkout (PayPal + NETS)

const paypal = require("../services/paypal");
const nets = require("../services/nets");
const OrdersModel = require("../Models/OrdersModel");
const CartModel = require("../Models/cartModels");
const UsersModel = require("../Models/UsersModel");
const db = require("../db");

// NETS sandbox txn id (keep yours)
const NETS_TXN_ID =
  "sandbox_nets|m|8ff8e5b6-d43e-4786-8ac5-7accf8c5bd9b";

function getSelectedCartItems(session) {
  const cart = session?.cart || [];
  const selected = Array.isArray(session?.checkoutSelection) ? session.checkoutSelection : [];
  if (!selected.length) return cart;
  const set = new Set(selected.map(String));
  return cart.filter(i => set.has(i.name));
}

function getRedeemForSubtotal(session, subtotal) {
  const redeemAmount = Math.min(Number(subtotal || 0), Number(session?.cartRedeem?.amount || 0));
  const redeemPoints = Math.min(
    Number(session?.cartRedeem?.points || 0),
    Math.floor(redeemAmount / 0.1)
  );
  return {
    redeemAmount: Number(redeemAmount.toFixed(2)),
    redeemPoints: Number(redeemPoints || 0)
  };
}

let hasQuantityColumnCache = null;
let hasStockColumnCache = null;

async function detectProductInventoryColumns() {
  if (hasQuantityColumnCache !== null && hasStockColumnCache !== null) {
    return {
      hasQuantity: hasQuantityColumnCache,
      hasStock: hasStockColumnCache
    };
  }

  try {
    const [rows] = await db.query(
      `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'product'
         AND COLUMN_NAME IN ('quantity', 'stock')`
    );
    const columnSet = new Set((rows || []).map(r => String(r.COLUMN_NAME || "").toLowerCase()));
    hasQuantityColumnCache = columnSet.has("quantity");
    hasStockColumnCache = columnSet.has("stock");
  } catch (err) {
    console.error("Inventory column detection failed:", err);
    // Default to quantity because app UI reads quantity.
    hasQuantityColumnCache = true;
    hasStockColumnCache = false;
  }

  return {
    hasQuantity: hasQuantityColumnCache,
    hasStock: hasStockColumnCache
  };
}

async function decrementPurchasedProductInventory(purchasedItems) {
  const { hasQuantity, hasStock } = await detectProductInventoryColumns();
  if (!hasQuantity && !hasStock) return;

  for (const item of purchasedItems || []) {
    const name = String(item?.name || "").trim();
    const qtyRaw = Number(item?.qty ?? item?.quantity ?? 0);
    const qty = Number.isFinite(qtyRaw) ? Math.floor(qtyRaw) : 0;
    if (!name || qty <= 0) continue;

    try {
      const setClauses = [];
      const params = [];

      if (hasQuantity) {
        setClauses.push("quantity = GREATEST(quantity - ?, 0)");
        params.push(qty);
      }

      if (hasStock) {
        setClauses.push("stock = GREATEST(stock - ?, 0)");
        params.push(qty);
      }

      params.push(name);

      await db.query(
        `UPDATE product
         SET ${setClauses.join(", ")}
         WHERE LOWER(TRIM(product_name)) = LOWER(TRIM(?))`,
        params
      );
    } catch (err) {
      console.error(`Failed to decrement inventory for "${name}":`, err);
    }
  }
}

async function removePurchasedItemsFromCart(req, purchasedItems) {
  const names = [...new Set((purchasedItems || []).map(i => i.name).filter(Boolean))];
  if (!names.length) return;

  const currentCart = req.session?.cart || [];
  req.session.cart = currentCart.filter(item => !names.includes(item.name));
  req.session.checkoutSelection = null;

  if (req.session?.user) {
    for (const name of names) {
      try {
        await CartModel.removeItem(req.session.user.id, name);
      } catch (err) {
        console.error("Failed to remove purchased item from DB cart:", err);
      }
    }
  }
}

/* =========================
   GET /checkout
========================= */
exports.renderCheckout = async (req, res) => {
  const cart = getSelectedCartItems(req.session);
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
  const { redeemAmount: redeem } = getRedeemForSubtotal(req.session, subtotal);
  const total = Number((subtotal + initialDeliveryFee - redeem).toFixed(2));
  let walletBalance = 0;

  if (req.session?.user?.id) {
    try {
      const [rows] = await db.query(
        "SELECT wallet_balance FROM users WHERE id = ? LIMIT 1",
        [req.session.user.id]
      );
      walletBalance = Number(rows?.[0]?.wallet_balance || 0);
    } catch (err) {
      console.error("Failed to load wallet balance for checkout:", err);
    }
  }

  res.render("checkout", {
    brand: "HomeBitez",
    items,
    subtotal: Number(subtotal.toFixed(2)),
    total,                          // total based on initial mode minus redeem
    defaultDeliveryFee: deliveryFee, // base delivery fee
    initialDeliveryFee,
    prefs,
    redeem,
    walletBalance,
    user: req.session.user || null,
    paypalClientId: process.env.PAYPAL_CLIENT_ID,
    paypalCurrency: process.env.PAYPAL_CURRENCY || "SGD",
  });
};

/* =========================
   GET /paylater
========================= */
exports.renderPayLater = async (req, res) => {
  const creditLimit = 300.0;
  const walletBalance = 120.5;
  const userId = req.session?.user?.id || null;
  const today = new Date();

  const addMonths = (date, months) => {
    const d = new Date(date);
    const day = d.getDate();
    d.setMonth(d.getMonth() + months);
    if (d.getDate() < day) d.setDate(0);
    return d;
  };

  let planOrders = [];
  let outstanding = 0;
  let monthly = 0;
  let schedule = [];
  let nextDueDate = null;

  try {
    const rawOrders = await OrdersModel.listByUser(userId, 200);
    planOrders = (rawOrders || [])
      .filter(o => String(o.status || '').toLowerCase() === 'paylater')
      .map(o => {
        const total = Number(o.total || 0);
        const months = Number(o.paylater_months || 0) || 3;
        const monthlyAmt = Number(o.paylater_monthly || 0) || Number((total / months).toFixed(2));
        const createdAt = o.created_at ? new Date(o.created_at) : new Date();
        const paid = Number(o.paylater_paid || 0);
        const remaining = Number(o.paylater_remaining || 0) || total;
        return {
          id: o.id,
          orderRef: o.paypal_order_id || `ORD-${o.id}`,
          total,
          months,
          monthly: monthlyAmt,
          createdAt,
          paid,
          remaining
        };
      });

    outstanding = planOrders.reduce((s, o) => s + Number(o.remaining || 0), 0);
    monthly = planOrders.filter(o => o.remaining > 0).reduce((s, o) => s + o.monthly, 0);

    for (const ord of planOrders) {
      if (ord.remaining <= 0) continue;
      const paidMonths = ord.monthly > 0 ? Math.floor((ord.paid || 0) / ord.monthly) : 0;
      for (let i = paidMonths + 1; i <= ord.months; i++) {
        const dueDate = addMonths(ord.createdAt, i);
        schedule.push({
          orderRef: ord.orderRef,
          dueDate,
          amount: ord.monthly,
          status: dueDate <= today ? "Due" : "Upcoming"
        });
      }
    }

    schedule.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
    const upcoming = schedule.find(s => s.dueDate >= today);
    nextDueDate = upcoming ? upcoming.dueDate : (schedule[0]?.dueDate || null);
  } catch (err) {
    console.error("PayLater load error:", err);
  }

  const availableCredit = Number((creditLimit - outstanding).toFixed(2));
  const planCount = planOrders.length;

  const paylaterMessage = req.session.paylaterMessage || null;
  const paylaterError = req.session.paylaterError || null;
  req.session.paylaterMessage = null;
  req.session.paylaterError = null;

  res.render("homebitez-paylater", {
    creditLimit,
    outstanding,
    availableCredit,
    walletBalance,
    monthly,
    nextDueDate,
    schedule,
    planOrders,
    planCount,
    paylaterMessage,
    paylaterError,
  });
};

/* =========================
   POST /paylater/choose
========================= */
exports.choosePayLater = async (req, res) => {
  const months = Number(req.body.months);
  if (![3, 6].includes(months)) {
    req.session.paylaterError = "Please select a valid PayLater plan.";
    return res.redirect("/paylater");
  }

  const cart = getSelectedCartItems(req.session);
  if (!cart.length) {
    req.session.paylaterError = "Cart is empty.";
    return res.redirect("/checkout");
  }
  const prefs = req.session.cartPrefs || { mode: "pickup" };
  const subtotal = cart.reduce(
    (s, i) => s + Number(i.price || 0) * Number(i.quantity || i.qty || 0),
    0
  );
  const deliveryFee = prefs.mode === "delivery" ? 2.5 : 0;
    const { redeemAmount: redeem } = getRedeemForSubtotal(req.session, subtotal);
    const total = Number((subtotal + deliveryFee - redeem).toFixed(2));

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

  try {
    const items = cart.map((i) => ({
      name: i.name,
      price: Number(i.price || 0),
      qty: Number(i.quantity || i.qty || 0),
    }));

    const orderDbId = await OrdersModel.create({
      userId: req.session.user ? req.session.user.id : null,
      payerEmail: req.session.user?.email || null,
      shippingName: prefs?.name || req.session.user?.username || null,
      items,
      subtotal,
      deliveryFee,
      total,
      paylaterMonths: months,
      paylaterMonthly: Number((total / months).toFixed(2)),
      paylaterPaid: 0,
      paylaterRemaining: total,
      status: "paylater",
    });

    req.session.latestOrderDbId = orderDbId;
  } catch (err) {
    console.error("PayLater order create failed:", err);
    req.session.paylaterError = "Failed to create PayLater order.";
    return res.redirect("/checkout");
  }

  return res.redirect("/receipt");
};

/* =========================
   PAYLATER PAYMENTS (PAYPAL)
========================= */
exports.startPayLaterInstallmentPaypal = async (req, res) => {
  try {
    const userId = req.session?.user?.id || null;
    if (!userId) return res.redirect("/login");

    const rawOrders = await OrdersModel.listByUser(userId, 200);
    const planOrders = (rawOrders || []).filter(o => String(o.status || '').toLowerCase() === 'paylater');

    let monthlyTotal = 0;
    for (const o of planOrders) {
      const total = Number(o.total || 0);
      const months = Number(o.paylater_months || 0) || 3;
      const monthly = Number(o.paylater_monthly || 0) || Number((total / months).toFixed(2));
      const remaining = Number(o.paylater_remaining || 0) || total;
      if (remaining > 0) monthlyTotal += monthly;
    }

    if (!Number.isFinite(monthlyTotal) || monthlyTotal <= 0) {
      req.session.paylaterError = "No outstanding PayLater installments.";
      return res.redirect("/paylater");
    }

    req.session.paylaterPay = {
      type: "installment",
      amount: Number(monthlyTotal.toFixed(2))
    };

    return res.redirect("/paylater/paypal");
  } catch (err) {
    console.error("startPayLaterInstallmentPaypal error:", err);
    req.session.paylaterError = "Failed to start PayLater installment payment.";
    return res.redirect("/paylater");
  }
};

exports.startPayLaterEarlyPaypal = async (req, res) => {
  try {
    const userId = req.session?.user?.id || null;
    if (!userId) return res.redirect("/login");

    const rawOrders = await OrdersModel.listByUser(userId, 200);
    const planOrders = (rawOrders || []).filter(o => String(o.status || '').toLowerCase() === 'paylater');
    const outstanding = planOrders.reduce((s, o) => {
      const total = Number(o.total || 0);
      const remaining = Number(o.paylater_remaining || 0) || total;
      return s + Math.max(0, remaining);
    }, 0);

    if (!Number.isFinite(outstanding) || outstanding <= 0) {
      req.session.paylaterError = "No outstanding PayLater balance.";
      return res.redirect("/paylater");
    }

    req.session.paylaterPay = {
      type: "early",
      amount: Number(outstanding.toFixed(2))
    };

    return res.redirect("/paylater/paypal");
  } catch (err) {
    console.error("startPayLaterEarlyPaypal error:", err);
    req.session.paylaterError = "Failed to start PayLater early payment.";
    return res.redirect("/paylater");
  }
};

exports.renderPayLaterPaypal = (req, res) => {
  const pay = req.session.paylaterPay || null;
  if (!pay || !Number.isFinite(Number(pay.amount)) || Number(pay.amount) <= 0) {
    return res.redirect("/paylater");
  }

  res.render("paylater-paypal", {
    amount: Number(pay.amount),
    payType: pay.type,
    paypalClientId: process.env.PAYPAL_CLIENT_ID,
    paypalCurrency: process.env.PAYPAL_CURRENCY || "SGD"
  });
};

exports.createPayLaterPaypalOrder = async (req, res) => {
  try {
    const pay = req.session.paylaterPay || null;
    if (!pay || !Number.isFinite(Number(pay.amount)) || Number(pay.amount) <= 0) {
      return res.status(400).json({ error: "Invalid PayLater amount" });
    }

    const shippingName =
      (req.session.user && (req.session.user.username || req.session.user.name)) || null;

    const order = await paypal.createOrder(Number(pay.amount), { shippingName });

    req.session.paylaterPaypalPending = {
      paypalOrderId: order.id,
      amount: Number(pay.amount),
      createdAt: Date.now(),
      type: pay.type
    };

    return res.json({ id: order.id });
  } catch (err) {
    console.error("createPayLaterPaypalOrder error:", err);
    return res.status(500).json({ error: "Failed to create PayLater PayPal order" });
  }
};

exports.capturePayLaterPaypalOrder = async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: "Missing orderId" });

    const capture = await paypal.captureOrder(orderId);
    const pu = capture.purchase_units?.[0];
    const cap = pu?.payments?.captures?.[0];

    if (!cap || cap.status !== "COMPLETED") {
      return res.status(400).json({ error: "PayPal payment not completed" });
    }

    const amount = Number(cap.amount?.value || req.session.paylaterPaypalPending?.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Invalid payment amount" });
    }

    if (req.session?.user?.id) {
      await OrdersModel.applyPaylaterPayment(req.session.user.id, amount);
    }

    req.session.paylaterMessage = `PayLater payment received: $${amount.toFixed(2)}.`;
    req.session.paylaterPay = null;
    req.session.paylaterPaypalPending = null;

    return res.json({ ok: true });
  } catch (err) {
    console.error("capturePayLaterPaypalOrder error:", err);
    return res.status(500).json({ error: "Failed to capture PayLater PayPal order" });
  }
};

/* =========================
   POST /paypal/create-order
========================= */
exports.createPaypalOrder = async (req, res) => {
  try {
    const cart = getSelectedCartItems(req.session);
    if (!cart.length) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    const subtotal = cart.reduce(
      (s, i) => s + Number(i.price || 0) * Number(i.quantity || i.qty || 0),
      0
    );

    const deliveryFee = Number(req.body.deliveryFee || 0);
    const { redeemAmount: redeem, redeemPoints } = getRedeemForSubtotal(req.session, subtotal);
    const total = Number((subtotal + deliveryFee - redeem).toFixed(2));

    const shippingName =
      req.body.shippingName ||
      (req.session.user && (req.session.user.username || req.session.user.name)) ||
      null;

    const order = await paypal.createOrder(total, { shippingName });

    // store pending info in session
    req.session.paypalPending = {
      paypalOrderId: order.id,
      total,
      redeemPoints,
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
    const cart = getSelectedCartItems(req.session);
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
      status: "paid",
    });

    // Deduct redeemed points first
    const redeemedPointsUsed = Number(req.session.paypalPending?.redeemPoints || 0);
    if (req.session.user && redeemedPointsUsed > 0) {
      try {
        const { balance, entry } = await UsersModel.addPoints(req.session.user.id, -redeemedPointsUsed, `Redeem order ${orderDbId}`);
        req.session.user.points = balance;
        req.session.user.pointsHistory = [entry, ...(req.session.user.pointsHistory || [])].slice(0,20);
      } catch (err) {
        console.error("Points redeem deduct failed (PayPal):", err);
      }
    }

    // Award loyalty points: 1 point per $1 total (floor)
    if (req.session.user && total > 0) {
      try {
        const earned = Math.floor(total); // 1 pt = $1
        const { balance, entry } = await UsersModel.addPoints(req.session.user.id, earned, `Order ${orderDbId} (PayPal)`);
        req.session.user.points = balance;
        req.session.user.pointsHistory = [entry, ...(req.session.user.pointsHistory || [])].slice(0,20);
      } catch (err) {
        console.error("Points award failed:", err);
      }
    }

    // clear applied redemption after use
    req.session.cartRedeem = null;

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
    const cart = getSelectedCartItems(req.session);
    if (!cart.length) {
      return res.render("netsQrFail", {
        title: "Error",
        errorMsg: "No selected items to checkout.",
      });
    }
    const subtotal = cart.reduce(
      (s, i) => s + Number(i.price || 0) * Number(i.quantity || i.qty || 0),
      0
    );
    const { redeemPoints } = getRedeemForSubtotal(req.session, subtotal);

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
        redeemPoints,
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
  const stripeCapture = req.session?.stripeCapture || null;
  const latestOrderDbId = req.session?.latestOrderDbId || null;
  const paylaterPurchase = req.session?.paylaterPurchase || null;
  if (latestOrderDbId) {
    req.session.lastReceiptOrderId = latestOrderDbId;
  }

  let cart = getSelectedCartItems(req.session);
  let prefs = req.session?.cartPrefs || {
    cutlery: false,
    pickupDate: "",
    pickupTime: "",
    mode: "pickup",
    name: "",
    address: "",
    contact: "",
    notes: ""
  };

  // If cart empty but we have an order id, hydrate from DB
  if ((!cart || cart.length === 0) && latestOrderDbId) {
    try {
      const order = await OrdersModel.getById(latestOrderDbId);
      if (order) {
        const parsedItems = order.items
          ? (Array.isArray(order.items) ? order.items : (() => { try { return JSON.parse(order.items); } catch (e) { return []; } })())
          : [];
        cart = (parsedItems || []).map(i => ({
          name: i.name,
          price: Number(i.price || 0),
          quantity: Number(i.qty || i.quantity || 0),
          qty: Number(i.qty || i.quantity || 0),
          subtotal: Number((Number(i.price || 0) * Number(i.qty || i.quantity || 0)).toFixed(2))
        }));
        if (order.shipping_name || order.shippingName || order.address || order.contact) {
          prefs = {
            ...prefs,
            name: order.shipping_name || order.shippingName || prefs.name,
            address: order.address || prefs.address,
            contact: order.contact || prefs.contact
          };
        }
      }
    } catch (err) {
      console.error("renderReceipt hydrate order error:", err);
    }
  }

  const redeem = Math.min(
    Number(req.session?.cartRedeem?.amount || 0),
    Number(cart.reduce((s,i)=>s+Number(i.price||0)*Number(i.quantity||i.qty||0),0))
  );

  const items = cart.map(i => ({
    name: i.name,
    price: Number(i.price || 0),
    qty: Number(i.quantity || i.qty || 0),
    subtotal: Number((Number(i.price || 0) * Number(i.quantity || i.qty || 0)).toFixed(2))
  }));

  const subtotal = items.reduce((s, i) => s + i.subtotal, 0);
  const total = paylaterPurchase?.total || paypalCapture?.total || stripeCapture?.total || (subtotal - redeem);
  const deliveryFee = Number((total - subtotal).toFixed(2));
  const paymentMethod = paylaterPurchase
    ? "PayLater"
    : (paypalCapture ? "PayPal" : (stripeCapture ? "Stripe" : "NETS / Other"));
  const fulfillment = prefs.mode === "delivery" ? "Delivery" : "Pickup";
  const isPaid = !!(paypalCapture || stripeCapture || paylaterPurchase);
  const paymentMeta = paypalCapture
    ? {
        refId: paypalCapture.orderId || null,
        txnId: paypalCapture.captureId || null,
        payerEmail: paypalCapture.payerEmail || null
      }
    : (stripeCapture ? {
        refId: stripeCapture.sessionId || null,
        txnId: stripeCapture.paymentIntentId || null,
        payerEmail: stripeCapture.payerEmail || null
      } : {
        refId: null,
        txnId: null,
        payerEmail: null
      });

  if (isPaid) {
    // Finalize purchase: decrement product inventory and clear purchased cart items.
    await decrementPurchasedProductInventory(items);
    await removePurchasedItemsFromCart(req, items);
    req.session.latestOrderDbId = null;
    req.session.paylaterPurchase = null;
    req.session.cartRedeem = null;
  }

  res.render("receipt", {
    brand: "HomeBitez",
    items,
    subtotal,
    deliveryFee,
    total,
    paypalCapture,       // <-- ALWAYS DEFINED (null or object)
    stripeCapture,
    paylaterPlan: req.session?.paylaterPlan || null,
    latestOrderDbId,
    user: req.session.user || null,
    prefs,
    paymentMethod,
    fulfillment,
    paymentMeta,
    isPaid
  });
};

