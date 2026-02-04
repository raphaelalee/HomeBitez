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

function buildReply(rawMessage, snapshot) {
  const message = String(rawMessage || "").toLowerCase();

  if (/\b(hi|hello|hey)\b/.test(message)) {
    return "Hi. I can help with checkout, delivery, payment methods, and loyalty points.";
  }

  if (/\b(payment|pay|paypal|wallet|stripe|paylater)\b/.test(message)) {
    return "You can pay using PayPal, HomeBitez Wallet, Stripe, or HomeBitez PayLater (3 or 6 months).";
  }

  if (/\b(delivery|pickup|fee|shipping)\b/.test(message)) {
    return `Normal delivery is ${money(snapshot.normalDeliveryFee)}, urgent delivery is ${money(snapshot.urgentDeliveryFee)}, and pickup has no fee. Your current mode is ${snapshot.mode}${snapshot.mode === "delivery" ? ` (${snapshot.deliveryType})` : ""}, so your applied fee is ${money(snapshot.deliveryFee)}.`;
  }

  if (/\b(point|reward|redeem|loyalty)\b/.test(message)) {
    return `You currently have ${snapshot.points} points. Redeem rate is 1 point = $0.10. Applied discount now: ${money(snapshot.redeem)}.`;
  }

  if (/\b(total|subtotal|cart|amount|cost)\b/.test(message)) {
    return `Your current checkout has ${snapshot.itemCount} item(s). Subtotal: ${money(snapshot.subtotal)}, delivery: ${money(snapshot.deliveryFee)}, points discount: ${money(snapshot.redeem)}, estimated total: ${money(snapshot.total)}.`;
  }

  if (/\b(report|issue|problem|support|help)\b/.test(message)) {
    return "For order issues, use the Report Issue page in the navbar. Include your order ID and delivery address for faster support.";
  }

  if (/\b(thank|thanks)\b/.test(message)) {
    return "You're welcome. Ask me anything else about checkout.";
  }

  return "I can help with totals, payment methods, delivery/pickup details, rewards points, and reporting an issue.";
}

exports.ask = (req, res) => {
  const message = String(req.body?.message || "").trim();
  if (!message) {
    return res.status(400).json({ ok: false, error: "Message is required." });
  }

  const snapshot = getCheckoutSnapshot(req.session);
  const reply = buildReply(message, snapshot);
  const suggestions = [
    "What payment methods are available?",
    "How much is delivery?",
    "How do I use points?",
  ];

  return res.json({ ok: true, reply, suggestions });
};
