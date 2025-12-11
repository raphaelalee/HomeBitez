const ProductModel = require("../Models/ProductModel");
const db = require("../db");

// ------------------------------------
// DASHBOARD
// ------------------------------------
exports.dashboard = async (req, res) => {
    const [productCountRows] = await db.query("SELECT COUNT(*) AS total FROM products");
    const totalProducts = productCountRows[0].total;

    const [stockRows] = await db.query("SELECT SUM(quantity) AS totalStocks FROM products");
    const totalStocks = stockRows[0].totalStocks || 0;

    const [revenueRows] = await db.query("SELECT SUM(totalAmount) AS revenue FROM orders");
    const totalRevenue = revenueRows[0].revenue || 0;

    const ownerId = req.session.userId;
    const [msgRows] = await db.query(
        "SELECT COUNT(*) AS unread FROM messages WHERE ownerId = ? AND isRead = 0",
        [ownerId]
    );

    const newMessages = msgRows[0].unread || 0;

    res.render("bizowner/dashboard", {
        totalProducts,
        totalStocks,
        totalRevenue,
        newMessages
    });
};


// ------------------------------------
// INVENTORY
// ------------------------------------
exports.inventory = async (req, res) => {
    const [products] = await ProductModel.getAll();
    res.render("bizowner/inventory", { products });
};


// ------------------------------------
// ADD PRODUCT (with multer)
// ------------------------------------
exports.addPage = (req, res) => {
    res.render("bizowner/addProduct");
};

exports.addProduct = async (req, res) => {
    let imageFilename = "default.png";

    if (req.file) {
        imageFilename = req.file.filename;
    }

    const product = {
        productName: req.body.productName,
        quantity: req.body.quantity,
        price: req.body.price,
        image: imageFilename
    };

    await ProductModel.create(product);
    res.redirect("/owner/inventory");
};


// ------------------------------------
// EDIT PRODUCT PAGE
// ------------------------------------
exports.editPage = async (req, res) => {
    const id = req.params.id;
    const [rows] = await ProductModel.getById(id);
    res.render("bizowner/editProduct", { product: rows[0] });
};


// ------------------------------------
// UPDATE PRODUCT (with multer)
// ------------------------------------
exports.updateProduct = async (req, res) => {
    const id = req.params.id;

    let imageFilename = req.body.currentImage;
    if (req.file) {
        imageFilename = req.file.filename;
    }

    const product = {
        productName: req.body.productName,
        quantity: req.body.quantity,
        price: req.body.price,
        image: imageFilename
    };

    await ProductModel.update(id, product);
    res.redirect("/owner/inventory");
};


// ------------------------------------
// DELETE PRODUCT
// ------------------------------------
exports.deleteProduct = async (req, res) => {
    const id = req.params.id;
    await ProductModel.delete(id);
    res.redirect("/owner/inventory");
};


// ------------------------------------
// PROFILE PAGE
// ------------------------------------
exports.profilePage = async (req, res) => {
    const userId = req.session.userId;
    const [rows] = await db.query("SELECT * FROM users WHERE id = ?", [userId]);
    res.render("bizowner/profile", { user: rows[0] });
};


// ------------------------------------
// UPDATE PROFILE
// ------------------------------------
exports.updateProfile = async (req, res) => {
    const userId = req.session.userId;

    const { username, email, address, contact } = req.body;

    await db.query(
        "UPDATE users SET username=?, email=?, address=?, contact=? WHERE id=?",
        [username, email, address, contact, userId]
    );

    res.redirect("/owner/profile");
};


// ------------------------------------
// MESSAGES
// ------------------------------------
exports.messagesPage = async (req, res) => {
    const ownerId = req.session.userId;

    const [messages] = await db.query(
        `SELECT m.*, u.username AS senderName 
         FROM messages m 
         JOIN users u ON m.senderId = u.id 
         WHERE m.ownerId = ? ORDER BY m.created_at DESC`,
        [ownerId]
    );

    res.render("bizowner/messages", { messages });
};


// ------------------------------------
// REPLENISH STOCK
// ------------------------------------
exports.replenish = async (req, res) => {
    const id = req.params.id;
    const quantityToAdd = parseInt(req.body.quantity);

    await db.query(
        "UPDATE products SET quantity = quantity + ? WHERE id = ?",
        [quantityToAdd, id]
    );

    res.redirect("/owner/inventory");
};


// ------------------------------------
// OPTIONAL: replyMessage if needed
// ------------------------------------
exports.replyMessage = async (req, res) => {
    console.log("Reply received:", req.body.reply);
    res.redirect("/owner/messages");
};
