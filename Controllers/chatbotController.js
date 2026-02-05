/*
I declare that this code was written by me.
I will not copy or allow others to copy my code.
I understand that copying code is considered as plagiarism.

Student Name: Raphaela Lee
Student ID: 24009059
Class: c004
Date created: February 5, 2026
*/

const OrdersModel = require("../Models/OrdersModel");

function getSelectedCartItems(session) {
  const cart = Array.isArray(session?.cart) ? session.cart : [];
  const selected = Array.isArray(session?.checkoutSelection) ? session.checkoutSelection : [];
  if (!selected.length) return cart;
  const selectedSet = new Set(selected.map(String));
  return cart.filter((item) => selectedSet.has(item.name));
}

function getCheckoutSnapshot(session) {
  const normalDeliveryFee = 2.5;
  const urgentDeliveryFee = 6;
  const cart = getSelectedCartItems(session);
  const subtotal = cart.reduce((sum, item) => {
    const price = Number(item.price || 0);
    const qty = Number(item.quantity || item.qty || 0);
    return sum + price * qty;
  }, 0);
  const mode = session?.cartPrefs?.mode === "delivery" ? "delivery" : "pickup";
  const deliveryType = session?.cartPrefs?.deliveryType === "urgent" ? "urgent" : "normal";
  const baseDeliveryFee = deliveryType === "urgent" ? urgentDeliveryFee : normalDeliveryFee;
  const deliveryFee = mode === "delivery" ? baseDeliveryFee : 0;
  const redeem = Math.min(subtotal, Number(session?.cartRedeem?.amount || 0));
  const total = Number((subtotal + deliveryFee - redeem).toFixed(2));

  return {
    itemCount: cart.length,
    subtotal: Number(subtotal.toFixed(2)),
    normalDeliveryFee: Number(normalDeliveryFee.toFixed(2)),
    urgentDeliveryFee: Number(urgentDeliveryFee.toFixed(2)),
    baseDeliveryFee: Number(baseDeliveryFee.toFixed(2)),
    deliveryFee: Number(deliveryFee.toFixed(2)),
    deliveryType,
    redeem: Number(redeem.toFixed(2)),
    total,
    mode,
    points: Number(session?.user?.points || 0),
  };
}

function money(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function parseOrderLookup(rawMessage) {
  const text = String(rawMessage || "").trim();
  const lower = text.toLowerCase();
  const orderIdMatch = text.match(
    /(?:order(?:\s*(?:number|no\.?|id|#))?|ord|#)\s*[:#-]?\s*(\d{1,})/i
  );
  let orderId = orderIdMatch ? Number(orderIdMatch[1]) : null;

  if (!orderId) {
    const ordPattern = text.match(/ord\s*[-#:]?\s*(\d{1,})/i);
    if (ordPattern) orderId = Number(ordPattern[1]);
  }

  if (!orderId && /^\d{1,}$/.test(text)) {
    orderId = Number(text);
  }

  const orderIntent =
    !!orderIdMatch ||
    /^\d{1,}$/.test(text) ||
    /\bord\s*[-#:]?\s*\d+\b/i.test(text) ||
    /\b(order\s*(?:status|number|no\.?|id)|track|tracking)\b/.test(lower);

  return { orderIntent, orderId };
}

function formatOrderStatus(order) {
  const raw = String(order?.status || "").trim();
  let status = raw ? raw.toLowerCase() : "";
  if (!status) {
    if (order?.completed_at) status = "fulfilled";
    else if (order?.paypal_capture_id) status = "paid";
    else status = "pending";
  }
  const clean = status.replace(/_/g, " ");
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function buildReply(rawMessage, snapshot) {
  const message = String(rawMessage || "").toLowerCase();

  if (/\b(hi|hello|hey)\b/.test(message)) {
    return "Hi. I can help with checkout, delivery, payment methods, and loyalty points.";
  }

  if (/\b(payment|pay|paypal|nets|wallet|stripe|paylater)\b/.test(message)) {
    return "You can pay using PayPal, NETS QR, HomeBitez Wallet, Stripe, or HomeBitez PayLater (3 or 6 months).";
  }

  if (/\b(eta|arrival|arrive|delivery\s*time|pickup\s*time|pickup\s*slot)\b/.test(message)) {
    return "Delivery time varies by distance and kitchen queue. Pickup time/slot is set during checkout, and you can adjust it there before paying.";
  }

  if (/\b(delivery|pickup|fee|shipping)\b/.test(message)) {
    return `Normal delivery is ${money(snapshot.normalDeliveryFee)}, urgent delivery is ${money(snapshot.urgentDeliveryFee)}, and pickup has no fee. Your current mode is ${snapshot.mode}${snapshot.mode === "delivery" ? ` (${snapshot.deliveryType})` : ""}, so your applied fee is ${money(snapshot.deliveryFee)}.`;
  }

  if (/\b(point|reward|redeem|loyalty)\b/.test(message)) {
    return `You currently have ${snapshot.points} points. Redeem rate is 1 point = $0.01. Applied discount now: ${money(snapshot.redeem)}.`;
  }

  if (/\b(total|subtotal|cart|amount|cost)\b/.test(message)) {
    return `Your current checkout has ${snapshot.itemCount} item(s). Subtotal: ${money(snapshot.subtotal)}, delivery: ${money(snapshot.deliveryFee)}, points discount: ${money(snapshot.redeem)}, estimated total: ${money(snapshot.total)}.`;
  }

  if (/\b(cancel|cancellation|refund|return)\b/.test(message)) {
    return "If the kitchen has not started preparing your order, we can help with changes or cancellations. Please provide your order ID via the Report Issue page or Contact Us.";
  }

  if (/\b(wallet|top\s*up|topup|paylater|installment)\b/.test(message)) {
    return "You can pay with HomeBitez Wallet or PayLater. Top up your wallet at Digital Wallet, and manage PayLater plans on the PayLater page in your profile.";
  }

  if (/\b(menu|availability|available|out\s*of\s*stock|stock)\b/.test(message)) {
    return "For item availability, please check the Menu page. Items not available will be shown there.";
  }

  if (/\b(report|issue|problem|support|help)\b/.test(message)) {
    return "For order issues, use the Report Issue page in the navbar. Include your order ID and delivery address for faster support.";
  }

  if (/\b(hours|opening|open|close|location|address|where)\b/.test(message)) {
    return "Support hours are 10:00 AM to 10:00 PM (SGT). HomeBitez HQ: 21 Fusionopolis Way, Singapore. You can also reach support at support@homebitez.com.";
  }

  if (/\b(promo|coupon|discount\s*code|voucher)\b/.test(message)) {
    return "Promo codes are not supported right now. You can use points for discounts at checkout.";
  }

  if (/\b(thank|thanks)\b/.test(message)) {
    return "You're welcome. Ask me anything else about checkout.";
  }

  return "I can help with order status, totals, payment methods, delivery/pickup details, refunds/cancellations, wallet/PayLater, rewards points, support, and store info.";
}

exports.ask = async (req, res) => {
  const message = String(req.body?.message || "").trim();
  if (!message) {
    return res.status(400).json({ ok: false, error: "Message is required." });
  }

  const orderLookup = parseOrderLookup(message);
  if (orderLookup.orderIntent) {
    if (!orderLookup.orderId) {
      return res.json({
        ok: true,
        reply: "Please share your order number (e.g., 1024) so I can check its status and price.",
        suggestions: ["Check order #1024", "Track order status", "What payment methods are available?"],
      });
    }

    try {
      const order = await OrdersModel.getById(orderLookup.orderId);
      if (!order) {
        return res.json({
          ok: true,
          reply: `I couldn't find order #${orderLookup.orderId}. Please double-check the number.`,
          suggestions: ["Check another order number", "Report an issue", "What payment methods are available?"],
        });
      }

      const status = formatOrderStatus(order);
      const total = money(order.total || 0);

      return res.json({
        ok: true,
        reply: `Order #${orderLookup.orderId} status: ${status}. Total: ${total}.`,
        suggestions: ["Check another order number", "Report an issue", "How do I use points?"],
      });
    } catch (err) {
      console.error("Order lookup failed:", err);
      return res.json({
        ok: true,
        reply: "Sorry, I couldn't fetch that order right now. Please try again in a moment.",
        suggestions: ["Check another order number", "Report an issue", "How much is delivery?"],
      });
    }
  }

  const snapshot = getCheckoutSnapshot(req.session);
  const reply = buildReply(message, snapshot);
  const suggestions = [
    "Check order status",
    "What payment methods are available?",
    "How much is delivery?",
    "How do I use points?",
    "How do I cancel an order?",
    "Where are you located?",
  ];

  return res.json({ ok: true, reply, suggestions });
};
