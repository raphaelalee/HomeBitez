const ProductModel = require("../Models/ProductModel");
const db = require("../db");
const OrdersModel = require("../Models/OrdersModel");
const UsersModel = require("../Models/UsersModel");
const stripeService = require("../services/stripe");
const paypalService = require("../services/paypal");

// -----------------------------
// Helpers
// -----------------------------
let messagesOwnerColCache = undefined;
async function getMessagesOwnerCol() {
  if (messagesOwnerColCache !== undefined) return messagesOwnerColCache;
  try {
    const [colRows] = await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages' 
       AND COLUMN_NAME IN ('ownerId','owner_id') LIMIT 1`
    );
    messagesOwnerColCache = colRows && colRows[0] ? colRows[0].COLUMN_NAME : null;
  } catch (err) {
    messagesOwnerColCache = null;
  }
  return messagesOwnerColCache;
}

async function markMessagesReadForOwner(ownerId) {
  try {
    const ownerCol = await getMessagesOwnerCol();
    let sql = "UPDATE messages SET isRead = 1";
    const params = [];
    if (ownerCol) {
      sql += ` WHERE ( ${ownerCol} = ? OR ${ownerCol} IS NULL ) AND isRead = 0`;
      params.push(ownerId);
    } else {
      sql += " WHERE isRead = 0";
    }
    await db.query(sql, params);
    return true;
  } catch (err) {
    console.error("markMessagesReadForOwner error:", err);
    return false;
  }
}

function getSessionUser(req) {
  return req.session && req.session.user ? req.session.user : null;
}

function normalizeMoney(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === "number") return value;
  const str = String(value).trim();
  if (!str) return NaN;
  const match = str.match(/-?\d+(?:\.\d+)?/);
  if (!match) return NaN;
  const num = Number(match[0]);
  return Number.isFinite(num) ? num : NaN;
}

let refundTableEnsured = false;
async function ensureRefundTable() {
  if (refundTableEnsured) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS refund_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        order_id INT NOT NULL,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(150) NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        reason VARCHAR(100) NOT NULL,
        refund_method ENUM('original','wallet') DEFAULT 'original',
        details TEXT NOT NULL,
        status ENUM('pending','approved','rejected') DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_refund_user (user_id),
        INDEX idx_refund_order (order_id)
      )
    `);
  } catch (err) {}
  try {
    await db.query("ALTER TABLE refund_requests ADD COLUMN refund_method ENUM('original','wallet') DEFAULT 'original'");
  } catch (err) {}
  refundTableEnsured = true;
}

let walletColumnEnsured = false;
async function ensureWalletColumn() {
  if (walletColumnEnsured) return;
  try {
    await db.query("ALTER TABLE users ADD COLUMN wallet_balance DECIMAL(10,2) NOT NULL DEFAULT 0");
  } catch (err) {}
  walletColumnEnsured = true;
}

let walletTxnTableEnsured = false;
async function ensureWalletTransactionsTable() {
  if (walletTxnTableEnsured) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS wallet_transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        type ENUM('topup','payment') NOT NULL,
        method VARCHAR(50) NULL,
        amount DECIMAL(10,2) NOT NULL,
        balance_after DECIMAL(10,2) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_wallet_user (user_id),
        CONSTRAINT fk_wallet_user FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);
  } catch (err) {}
  walletTxnTableEnsured = true;
}

async function recordWalletTxn(userId, type, method, amount, balanceAfter) {
  try {
    await ensureWalletTransactionsTable();
    await db.query(
      "INSERT INTO wallet_transactions (user_id, type, method, amount, balance_after) VALUES (?,?,?,?,?)",
      [userId, type, method || null, amount, balanceAfter]
    );
  } catch (err) {}
}

function requireBizOwner(req, res) {
  const user = getSessionUser(req);
  if (!user) {
    return { ok: false, res: res.redirect("/login") };
  }
  if (user.role !== "biz_owner") {
    return { ok: false, res: res.status(403).send("Forbidden") };
  }
  return { ok: true, user };
}

function addPaymentMeta(order) {
  const hasPaypal = !!(order.paypal_order_id || order.paypalOrderId);
  const paymentMethod = hasPaypal ? "PayPal" : "Other";
  const paymentRef = order.paypal_order_id || order.paypalOrderId || order.id || "-";
  const paymentCapture = order.paypal_capture_id || order.paypalCaptureId || "-";
  return { paymentMethod, paymentRef, paymentCapture };
}

function addOrderMeta(order) {
  const payment = addPaymentMeta(order);
  const statusRaw = order.status || order.order_status || order.state || null;
  const fulfillmentStatus = statusRaw || (order.paypal_capture_id || order.paypalCaptureId ? "paid" : "pending");
  const completedAt = order.completed_at || order.completedAt || null;
  const deliveryFee = Number(order.delivery_fee || order.deliveryFee || 0);
  const subtotal = Number(order.subtotal || order.subTotal || (order.total ? Number(order.total) - deliveryFee : 0));
  const total = Number(order.total || order.totalAmount || order.total_amount || 0);
  const fulfillmentMode = deliveryFee > 0 ? "Delivery" : "Pickup";
  const orderRef = `ORD-${order.id}`;
  return { ...order, ...payment, fulfillmentStatus, completedAt, deliveryFee, subtotal, total, fulfillmentMode, orderRef };
}

function normalizeDiscountPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(90, Number(n.toFixed(2))));
}

function parseTagList(selectedValues, customValues) {
  const selected = Array.isArray(selectedValues)
    ? selectedValues
    : (selectedValues ? [selectedValues] : []);

  const custom = String(customValues || "")
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);

  const merged = [...selected, ...custom];
  const uniqueByLower = new Map();

  merged.forEach(tag => {
    const clean = String(tag || "").trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (!uniqueByLower.has(key)) uniqueByLower.set(key, clean);
  });

  return Array.from(uniqueByLower.values()).join(", ");
}

// ------------------------------------
// DASHBOARD
// ------------------------------------
exports.dashboard = async (req, res) => {
  const guard = requireBizOwner(req, res);
  if (!guard.ok) return;

  try {
    const ownerId = guard.user.id;

    // If you want totals for ALL products, keep as-is.
    // If you want totals per-owner, you'll need ownerId column on product table.
    const [productCountRows] = await db.query(
      "SELECT COUNT(*) AS total FROM product"
    );
    const totalProducts = productCountRows?.[0]?.total ?? 0;

    const [stockRows] = await db.query(
      "SELECT SUM(quantity) AS totalStocks FROM product"
    );
    const totalStocks = stockRows?.[0]?.totalStocks ?? 0;

    let totalRevenue = 0;
    try {
      const [revenueRows] = await db.query(
        "SELECT SUM(totalAmount) AS revenue FROM orders"
      );
      totalRevenue = revenueRows?.[0]?.revenue ?? 0;
    } catch (err) {
      try {
        const [revenueRows] = await db.query(
          "SELECT SUM(total) AS revenue FROM orders"
        );
        totalRevenue = revenueRows?.[0]?.revenue ?? 0;
      } catch (err2) {
        totalRevenue = 0;
      }
    }

    const [msgRows] = await db.query(
      "SELECT COUNT(*) AS unread FROM messages WHERE ownerId = ? AND isRead = 0",
      [ownerId]
    );
    const newMessages = msgRows?.[0]?.unread ?? 0;

    return res.render("bizowner/dashboard", {
      totalProducts,
      totalStocks,
      totalRevenue,
      newMessages,
    });
  } catch (err) {
    console.error("Dashboard error:", err);
    return res.status(500).send("Server error");
  }
};

// ------------------------------------
// REFUNDS (biz owner)
// ------------------------------------
exports.refundsPage = async (req, res) => {
  const guard = requireBizOwner(req, res);
  if (!guard.ok) return;

  let refunds = [];
  try {
    await ensureRefundTable();
    const [rows] = await db.query(
      `SELECT rr.id, rr.user_id, rr.order_id, rr.name, rr.email, rr.amount, rr.reason,
              rr.refund_method, rr.details, rr.status, rr.created_at, u.contact, u.username
       FROM refund_requests rr
       LEFT JOIN users u ON u.id = rr.user_id
       ORDER BY rr.created_at DESC`
    );

    const enriched = [];
    for (const r of (rows || [])) {
      let order = null;
      try {
        order = await OrdersModel.getById(r.order_id);
      } catch (err) {
        order = null;
      }

      const itemList = Array.isArray(order?.items)
        ? order.items.map(i => {
            const qty = Number(i.quantity || i.qty || 1);
            const name = i.name || i.title || "Item";
            return `${qty}x ${name}`;
          }).join(", ")
        : "";

      const orderTotalNum = (() => {
        const n = normalizeMoney(order?.total);
        if (Number.isFinite(n) && n > 0) return n;
        const calc = Number(order?.subtotal || 0) + Number(order?.delivery_fee || order?.deliveryFee || 0);
        return Number.isFinite(calc) ? calc : null;
      })();

      enriched.push({
        ...r,
        order_email: order?.payer_email || order?.email || "",
        order_total: order?.total ?? null,
        order_total_num: orderTotalNum,
        order_capture_id: order?.paypal_capture_id || null,
        order_stripe_intent: order?.stripe_payment_intent || null,
        order_status: order?.status || "",
        order_items: itemList,
        order_created_at: order?.created_at || null
      });
    }

    refunds = enriched;
  } catch (err) {
    console.error("Bizowner refunds error:", err);
  }

  return res.render("bizowner/refunds", {
    refunds,
    success: req.flash("success"),
    error: req.flash("error")
  });
};

exports.approveRefund = async (req, res) => {
  const guard = requireBizOwner(req, res);
  if (!guard.ok) return;

  const refundId = Number(req.params.id);
  if (!Number.isFinite(refundId)) {
    req.flash("error", "Invalid refund ID.");
    return res.redirect("/bizowner/refunds");
  }

  try {
    await ensureRefundTable();
    const [rows] = await db.query(
      "SELECT id, user_id, order_id, refund_method, amount, status FROM refund_requests WHERE id = ? LIMIT 1",
      [refundId]
    );
    const refund = rows && rows[0] ? rows[0] : null;
    if (!refund) {
      req.flash("error", "Refund request not found.");
      return res.redirect("/bizowner/refunds");
    }
    if (String(refund.status || "").toLowerCase() === "approved") {
      req.flash("success", "Refund already approved.");
      return res.redirect("/bizowner/refunds");
    }
    if (String(refund.status || "").toLowerCase() === "rejected") {
      req.flash("error", "Refund already rejected.");
      return res.redirect("/bizowner/refunds");
    }

    const order = await OrdersModel.getById(refund.order_id);
    let computedAmount = normalizeMoney(refund.amount);
    if (!Number.isFinite(computedAmount) || computedAmount <= 0) {
      computedAmount = normalizeMoney(order?.total);
    }
    if (!Number.isFinite(computedAmount) || computedAmount <= 0) {
      const calc = Number(order?.subtotal || 0) + Number(order?.delivery_fee || order?.deliveryFee || 0);
      if (Number.isFinite(calc) && calc > 0) computedAmount = calc;
    }
    if (!Number.isFinite(computedAmount) || computedAmount <= 0) {
      req.flash("error", "Cannot refund: invalid order amount.");
      return res.redirect("/bizowner/refunds");
    }

    if (String(refund.refund_method || "original") === "wallet") {
      await ensureWalletColumn();
      await ensureWalletTransactionsTable();
      await db.query(
        "UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?",
        [computedAmount, refund.user_id]
      );
      const [balRows] = await db.query(
        "SELECT wallet_balance FROM users WHERE id=?",
        [refund.user_id]
      );
      const balanceAfter = balRows?.[0]?.wallet_balance ?? computedAmount;
      await recordWalletTxn(refund.user_id, "topup", "refund", computedAmount, balanceAfter);
    } else {
      if (order?.paypal_capture_id) {
        await paypalService.refundCapture(order.paypal_capture_id, computedAmount);
      } else if (order?.stripe_payment_intent) {
        await stripeService.refundPaymentIntent({
          paymentIntentId: order.stripe_payment_intent,
          amount: computedAmount
        });
      } else {
        req.flash("error", "Cannot refund: missing payment reference.");
        return res.redirect("/bizowner/refunds");
      }
    }

    await db.query(
      "UPDATE refund_requests SET status = 'approved', amount = ? WHERE id = ?",
      [computedAmount, refundId]
    );
    req.flash("success", "Refund approved and processed.");
  } catch (err) {
    console.error("Bizowner approve refund error:", err);
    req.flash("error", "Failed to approve refund.");
  }

  return res.redirect("/bizowner/refunds");
};

exports.rejectRefund = async (req, res) => {
  const guard = requireBizOwner(req, res);
  if (!guard.ok) return;

  const refundId = Number(req.params.id);
  if (!Number.isFinite(refundId)) {
    req.flash("error", "Invalid refund ID.");
    return res.redirect("/bizowner/refunds");
  }

  try {
    await ensureRefundTable();
    await db.query(
      "UPDATE refund_requests SET status = 'rejected' WHERE id = ?",
      [refundId]
    );
    req.flash("success", "Refund rejected.");
  } catch (err) {
    console.error("Bizowner reject refund error:", err);
    req.flash("error", "Failed to reject refund.");
  }

  return res.redirect("/bizowner/refunds");
};

// ------------------------------------
// INVENTORY
// ------------------------------------
exports.inventory = async (req, res) => {
  const [products] = await ProductModel.getAll();
  res.render("bizowner/inventory", {
    products,
    success: req.flash("success"),
    error: req.flash("error")
  });
};

// ------------------------------------
// ADD PRODUCT (with multer)
// ------------------------------------
exports.addPage = (req, res) => {
  const guard = requireBizOwner(req, res);
  if (!guard.ok) return;

  return res.render("bizowner/addProduct");
};

exports.addProduct = async (req, res) => {
  const guard = requireBizOwner(req, res);
  if (!guard.ok) return;

  try {
        let imageFilename = "default.png";
        if (req.file) imageFilename = req.file.filename;

        const productName = (req.body.productName || "").trim();
        const description = (req.body.description || "").trim();
        const category = (req.body.category || "").trim();
        const price = parseFloat(req.body.price);
        const quantity = Math.max(0, parseInt(req.body.quantity, 10) || 0);
        const isBestSeller = req.body.isBestSeller === "1";
        const discountPercent = normalizeDiscountPercent(req.body.discountPercent);
        const dietaryTags = parseTagList(req.body.dietaryTags, req.body.dietaryTagsCustom);
        const allergenTags = parseTagList(req.body.allergenTags, req.body.allergenTagsCustom);

    if (!productName) return res.redirect("/bizowner/add");
    if (!category) return res.redirect("/bizowner/add");
    if (Number.isNaN(price) || price < 0) return res.redirect("/bizowner/add");

    const product = {
      productName,
      description,
      category,
      price,
      image: imageFilename,
      quantity,
      isBestSeller,
      discountPercent,
      dietaryTags,
      allergenTags
    };

    await ProductModel.create(product);
    req.flash("success", "Product added successfully.");
    return res.redirect("/bizowner/inventory");
  } catch (err) {
    console.error("Add product error:", err);
    return res.status(500).send("Server error");
  }
};

// ------------------------------------
// EDIT PRODUCT PAGE
// ------------------------------------
exports.editPage = async (req, res) => {
  const guard = requireBizOwner(req, res);
  if (!guard.ok) return;

  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.redirect("/bizowner/inventory");

    const [rows] = await ProductModel.getById(id);
    if (!rows || !rows[0]) return res.redirect("/bizowner/inventory");

    return res.render("bizowner/editProduct", { product: rows[0] });
  } catch (err) {
    console.error("Edit page error:", err);
    return res.status(500).send("Server error");
  }
};

// ------------------------------------
// UPDATE PRODUCT (with multer)
// ------------------------------------
exports.updateProduct = async (req, res) => {
  const guard = requireBizOwner(req, res);
  if (!guard.ok) return;

  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.redirect("/bizowner/inventory");

    let imageFilename = req.body.currentImage || "default.png";
    if (req.file) imageFilename = req.file.filename;

    const productName = (req.body.productName || "").trim();
    const description = (req.body.description || "").trim();
    const category = (req.body.category || "").trim();
    const price = parseFloat(req.body.price);
    const isBestSeller = req.body.isBestSeller === "1";
    const discountPercent = normalizeDiscountPercent(req.body.discountPercent);
    const dietaryTags = parseTagList(req.body.dietaryTags, req.body.dietaryTagsCustom);
    const allergenTags = parseTagList(req.body.allergenTags, req.body.allergenTagsCustom);

    if (!productName) return res.redirect(`/bizowner/edit/${id}`);
    if (!category) return res.redirect(`/bizowner/edit/${id}`);
    if (Number.isNaN(price) || price < 0) return res.redirect(`/bizowner/edit/${id}`);

    const product = {
      productName,
      description,
      category,
      price,
      image: imageFilename,
      isBestSeller,
      discountPercent,
      dietaryTags,
      allergenTags
    };

    await ProductModel.update(id, product);
    req.flash("success", "Product updated successfully.");
    return res.redirect("/bizowner/inventory");
  } catch (err) {
    console.error("Update product error:", err);
    return res.status(500).send("Server error");
  }
};

// ------------------------------------
// DELETE PRODUCT
// ------------------------------------
exports.deleteProduct = async (req, res) => {
  const guard = requireBizOwner(req, res);
  if (!guard.ok) return;

  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.redirect("/bizowner/inventory");

    await ProductModel.delete(id);
    req.flash("success", "Product removed.");
    return res.redirect("/bizowner/inventory");
  } catch (err) {
    console.error("Delete product error:", err);
    return res.status(500).send("Server error");
  }
};

// ------------------------------------
// PROFILE PAGE
// ------------------------------------
exports.profilePage = async (req, res) => {
  const guard = requireBizOwner(req, res);
  if (!guard.ok) return;

  try {
    const userId = guard.user.id;
    const [rows] = await db.query("SELECT * FROM users WHERE id = ?", [userId]);
    if (!rows || !rows[0]) return res.redirect("/bizowner");

    return res.render("bizowner/profile", { 
      user: rows[0],
      success: req.flash("success"),
      error: req.flash("error")
    });
  } catch (err) {
    console.error("Profile page error:", err);
    return res.status(500).send("Server error");
  }
};

// ------------------------------------
// UPDATE PROFILE
// ------------------------------------
exports.updateProfile = async (req, res) => {
  const guard = requireBizOwner(req, res);
  if (!guard.ok) return;

  try {
    const userId = guard.user.id;
    const username = (req.body.username || "").trim();
    const email = (req.body.email || "").trim();
    const address = (req.body.address || "").trim();
    const contact = (req.body.contact || "").trim();

    await db.query(
      "UPDATE users SET username=?, email=?, address=?, contact=? WHERE id=?",
      [username, email, address, contact, userId]
    );

    req.flash("success", "Profile saved.");
    return res.redirect("/bizowner/profile");
  } catch (err) {
    console.error("Update profile error:", err);
    req.flash("error", "Failed to update profile.");
    return res.status(500).send("Server error");
  }
};

// ------------------------------------
// MESSAGES
// ------------------------------------
exports.messagesPage = async (req, res) => {
  const guard = requireBizOwner(req, res);
  if (!guard.ok) return;

  try {
    const ownerId = guard.user.id;

    // detect owner column on messages table (ownerId or owner_id). If none, show all messages.
    let ownerCol = null;
    try {
      ownerCol = await getMessagesOwnerCol();
    } catch (err) {
      console.error("messagesPage column detect error:", err);
    }

    let sql = `SELECT m.*, u.username AS senderName, u.email AS senderEmail
               FROM messages m 
               JOIN users u ON m.senderId = u.id `;
    const params = [];
    if (ownerCol) {
      sql += `WHERE (m.${ownerCol} = ? OR m.${ownerCol} IS NULL) `;
      params.push(ownerId);
    }
    sql += `ORDER BY m.created_at DESC`;

    const [messages] = await db.query(sql, params);

    // Mark these messages as read for this owner scope
    try {
      let updateSql = `UPDATE messages SET isRead = 1 `;
      const updateParams = [];
      if (ownerCol) {
        updateSql += `WHERE ( ${ownerCol} = ? OR ${ownerCol} IS NULL )`;
        updateParams.push(ownerId);
      }
      await db.query(updateSql, updateParams);
    } catch (err) {
      console.error("messagesPage mark read error:", err);
    }

    return res.render("bizowner/messages", { messages, success: req.flash("success"), error: req.flash("error") });
  } catch (err) {
    console.error("Messages page error:", err);
    return res.status(500).send("Server error");
  }
};

// ------------------------------------
// NOTIFICATIONS
// ------------------------------------
exports.notificationsPage = async (req, res) => {
  const guard = requireBizOwner(req, res);
  if (!guard.ok) return;

  try {
    const ownerId = guard.user.id;

    // Unread messages
    let unreadMessages = [];
    try {
      const ownerCol = await getMessagesOwnerCol();
      let sql = `SELECT m.id, m.senderId, m.ownerId, m.message, m.isRead, m.created_at,
                        u.username AS senderName, u.email AS senderEmail
                 FROM messages m
                 LEFT JOIN users u ON u.id = m.senderId `;
      const params = [];
      if (ownerCol) {
        sql += `WHERE (m.${ownerCol} = ? OR m.${ownerCol} IS NULL) AND m.isRead = 0 `;
        params.push(ownerId);
      } else {
        sql += `WHERE m.isRead = 0 `;
      }
      sql += `ORDER BY m.created_at DESC LIMIT 20`;
      const [rows] = await db.query(sql, params);
      unreadMessages = rows || [];
    } catch (err) {
      console.error("notifications unread messages error:", err);
    }

    // Pending orders
    let pendingOrders = [];
    try {
      const orders = await OrdersModel.list(100);
      pendingOrders = (orders || [])
        .filter(o => {
          const status = String(o.status || o.order_status || o.state || "").toLowerCase();
          return status !== "completed" && status !== "fulfilled";
        })
        .slice(0, 20)
        .map(o => ({
          id: o.id,
          orderRef: `ORD-${o.id}`,
          created_at: o.created_at,
          total: Number(o.total || 0),
          status: String(o.status || o.order_status || o.state || "pending")
        }));
    } catch (err) {
      console.error("notifications pending orders error:", err);
    }

    // Auto-clear unread messages after viewing
    if (unreadMessages.length) {
      await markMessagesReadForOwner(ownerId);
      res.locals.bizownerUnreadMessages = 0;
      res.locals.bizownerNotifCount = pendingOrders.length;
      res.locals.bizownerPendingOrders = pendingOrders.length;
    }

    return res.render("bizowner/notifications", {
      unreadMessages,
      pendingOrders
    });
  } catch (err) {
    console.error("Notifications page error:", err);
    return res.status(500).send("Server error");
  }
};

exports.markAllNotificationsRead = async (req, res) => {
  const guard = requireBizOwner(req, res);
  if (!guard.ok) return;

  try {
    await markMessagesReadForOwner(guard.user.id);
  } catch (err) {
    console.error("markAllNotificationsRead error:", err);
  }

  return res.redirect("/bizowner/notifications");
};

// Reply to a message (simple echo back to sender via new row)
exports.replyMessage = async (req, res) => {
  const guard = requireBizOwner(req, res);
  if (!guard.ok) return;

  try {
    const { messageId, reply } = req.body;
    if (!messageId || !reply) {
      if (req.flash) req.flash("error", "Reply cannot be empty.");
      return res.redirect("/bizowner/messages");
    }

    // fetch original sender
    const [[orig]] = await db.query("SELECT senderId, ownerId FROM messages WHERE id = ?", [messageId]);
    if (!orig) {
      if (req.flash) req.flash("error", "Message not found.");
      return res.redirect("/bizowner/messages");
    }

    // store reply as a new message from owner to sender (owner as senderId)
    await db.query(
      "INSERT INTO messages (senderId, ownerId, message, isRead, created_at) VALUES (?, ?, ?, 0, NOW())",
      [guard.user.id, orig.senderId || null, reply]
    );

    if (req.flash) req.flash("success", "Reply sent.");
  } catch (err) {
    console.error("replyMessage error:", err);
    if (req.flash) req.flash("error", "Failed to send reply.");
  }

  return res.redirect("/bizowner/messages");
};

// ------------------------------------
// ORDERS LIST
// ------------------------------------
exports.ordersPage = async (req, res) => {
  console.log('bizowner/orders requested - session.user=', req.session ? req.session.user : null);
  const guard = requireBizOwner(req, res);
  if (!guard.ok) return;

  try {
    await UsersModel.ensurePointsColumn();
    const orders = await OrdersModel.list(200);
    const withMeta = (orders || []).map(addOrderMeta);

    // Map user points for any user_id present
    const userIds = Array.from(new Set(withMeta.map(o => o.user_id).filter(Boolean)));
    let pointsMap = {};
    if (userIds.length) {
      const placeholders = userIds.map(() => '?').join(',');
      const [rows] = await db.query(`SELECT id, points FROM users WHERE id IN (${placeholders})`, userIds);
      pointsMap = Object.fromEntries((rows || []).map(r => [r.id, Number(r.points || 0)]));
    }

    const withPoints = withMeta.map(o => ({ ...o, customerPoints: pointsMap[o.user_id] || 0 }));
    return res.render("bizowner/orders", { orders: withPoints });
  } catch (err) {
    console.error("Orders page error:", err);
    // Return stack for debugging locally
    return res.status(500).send(`<pre>${(err && err.stack) ? err.stack : String(err)}</pre>`);
  }
};

// ------------------------------------
// ORDER DETAILS
// ------------------------------------
exports.orderDetailsPage = async (req, res) => {
  const guard = requireBizOwner(req, res);
  if (!guard.ok) return;

  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.redirect("/bizowner/orders");

    const order = await OrdersModel.getById(id);
    if (!order) return res.redirect("/bizowner/orders");

    let payerEmail = order.payer_email || order.payerEmail || null;
    if (order.user_id) {
      try {
        const userRows = await UsersModel.findById(order.user_id);
        const user = Array.isArray(userRows) ? userRows[0] : userRows;
        if (user && user.email) payerEmail = user.email;
      } catch (err) {
        console.error("fetch user email failed:", err);
      }
    }

    return res.render("bizowner/orderDetails", { order: { ...addOrderMeta(order), payer_email: payerEmail } });
  } catch (err) {
    console.error("Order details error:", err);
    return res.status(500).send(`<pre>${(err && err.stack) ? err.stack : String(err)}</pre>`);
  }
};

// ------------------------------------
// MARK ORDER COMPLETED
// ------------------------------------
exports.markOrderComplete = async (req, res) => {
  const guard = requireBizOwner(req, res);
  if (!guard.ok) return;

  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.redirect("/bizowner/orders");

    await OrdersModel.updateStatus(id, "completed");
    if (req.flash) req.flash("success", "Order marked as completed.");
  } catch (err) {
    console.error("markOrderComplete error:", err);
    if (req.flash) req.flash("error", "Unable to mark order completed.");
  }

  const ref = req.headers.referer || "/bizowner/orders";
  return res.redirect(ref.includes(`/bizowner/orders/${req.params.id}`) ? `/bizowner/orders/${req.params.id}` : "/bizowner/orders");
};

// ------------------------------------
// REPLENISH STOCK
// ------------------------------------
exports.replenish = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const quantityToAdd = parseInt(req.body.quantity, 10);

    if (!Number.isInteger(quantityToAdd) || quantityToAdd <= 0) {
      req.flash("error", "Please enter a valid quantity.");
      return res.redirect("/bizowner/inventory");
    }

    await db.query(
      "UPDATE product SET quantity = quantity + ? WHERE id = ?",
      [quantityToAdd, id]
    );

    req.flash("success", "Stock replenished successfully.");
    return res.redirect("/bizowner/inventory");
  } catch (err) {
    console.error("Replenish error:", err);
    req.flash("error", "Could not replenish stock. Try again.");
    return res.redirect("/bizowner/inventory");
  }
};

// (Removed duplicate replyMessage stub)
