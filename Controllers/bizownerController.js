const ProductModel = require("../Models/ProductModel");
const db = require("../db");
const OrdersModel = require("../Models/OrdersModel");

// -----------------------------
// Helpers
// -----------------------------
function getSessionUser(req) {
  return req.session && req.session.user ? req.session.user : null;
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
    const category = (req.body.category || "").trim();
    const price = parseFloat(req.body.price);

    if (!productName) return res.redirect("/bizowner/add");
    if (!category) return res.redirect("/bizowner/add");
    if (Number.isNaN(price) || price < 0) return res.redirect("/bizowner/add");

    const product = { productName, category, price, image: imageFilename };

    await ProductModel.create(product);
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
    const category = (req.body.category || "").trim();
    const price = parseFloat(req.body.price);

    if (!productName) return res.redirect(`/bizowner/edit/${id}`);
    if (!category) return res.redirect(`/bizowner/edit/${id}`);
    if (Number.isNaN(price) || price < 0) return res.redirect(`/bizowner/edit/${id}`);

    const product = { productName, category, price, image: imageFilename };

    await ProductModel.update(id, product);
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

    return res.render("bizowner/profile", { user: rows[0] });
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

    return res.redirect("/bizowner/profile");
  } catch (err) {
    console.error("Update profile error:", err);
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

    const [messages] = await db.query(
      `SELECT m.*, u.username AS senderName 
       FROM messages m 
       JOIN users u ON m.senderId = u.id 
       WHERE m.ownerId = ? 
       ORDER BY m.created_at DESC`,
      [ownerId]
    );

    return res.render("bizowner/messages", { messages });
  } catch (err) {
    console.error("Messages page error:", err);
    return res.status(500).send("Server error");
  }
};

// ------------------------------------
// ORDERS LIST
// ------------------------------------
exports.ordersPage = async (req, res) => {
  console.log('bizowner/orders requested - session.user=', req.session ? req.session.user : null);
  const guard = requireBizOwner(req, res);
  if (!guard.ok) return;

  try {
    const orders = await OrdersModel.list(200);
    const withMeta = (orders || []).map(o => ({ ...o, ...addPaymentMeta(o) }));
    return res.render("bizowner/orders", { orders: withMeta });
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

    return res.render("bizowner/orderDetails", { order: { ...order, ...addPaymentMeta(order) } });
  } catch (err) {
    console.error("Order details error:", err);
    return res.status(500).send(`<pre>${(err && err.stack) ? err.stack : String(err)}</pre>`);
  }
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

// ------------------------------------
// OPTIONAL: replyMessage if needed
// ------------------------------------
exports.replyMessage = async (req, res) => {
  const guard = requireBizOwner(req, res);
  if (!guard.ok) return;

  console.log("Reply received:", req.body.reply);
  return res.redirect("/bizowner/messages");
};
