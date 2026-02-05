/*
I declare that this code was written by me.
I will not copy or allow others to copy my code.
I understand that copying code is considered as plagiarism.

Student Name: Jeffery
Student ID: 24016580 
Class: E63C c004
Date created: February 3, 2026
*/
const express = require("express");
const router = express.Router();
const ownerController = require("../controllers/bizownerController");
const db = require("../db");
const OrdersModel = require("../Models/OrdersModel");

// Correct multer usage
const { upload } = require("../app");   // ✅ CORRECT

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

// Navbar notification counts for biz owner
router.use(async (req, res, next) => {
  try {
    const user = req.session?.user;
    if (!user || user.role !== "biz_owner") return next();

    let unreadMessages = 0;
    try {
      const ownerCol = await getMessagesOwnerCol();
      let sql = "SELECT COUNT(*) AS unread FROM messages";
      const params = [];
      if (ownerCol) {
        sql += ` WHERE ( ${ownerCol} = ? OR ${ownerCol} IS NULL ) AND isRead = 0`;
        params.push(user.id);
      } else {
        sql += " WHERE isRead = 0";
      }
      const [rows] = await db.query(sql, params);
      unreadMessages = Number(rows?.[0]?.unread || 0);
    } catch (err) {}

    let pendingOrders = 0;
    try {
      const orders = await OrdersModel.list(200);
      pendingOrders = (orders || []).filter(o => {
        const status = String(o.status || o.order_status || o.state || "").toLowerCase();
        return status !== "completed" && status !== "fulfilled";
      }).length;
    } catch (err) {}

    res.locals.bizownerUnreadMessages = unreadMessages;
    res.locals.bizownerPendingOrders = pendingOrders;
    res.locals.bizownerNotifCount = unreadMessages + pendingOrders;
  } catch (err) {}
  next();
});


// Business Owner Dashboard
router.get("/", ownerController.dashboard);

// Inventory page
router.get("/inventory", ownerController.inventory);

// Add product page
router.get("/add", ownerController.addPage);
router.post("/add", upload.single("imageFile"), ownerController.addProduct);

// Edit product page
router.get("/edit/:id", ownerController.editPage);

// Edit product with image upload
router.post("/edit/:id", upload.single("imageFile"), ownerController.updateProduct);

// Delete product
router.post("/delete/:id", ownerController.deleteProduct);

// Edit Profile Page
router.get("/profile", ownerController.profilePage);

// Update Profile
router.post("/profile", ownerController.updateProfile);

// Replenish stock
router.post("/replenish/:id", ownerController.replenish);

// Messages
router.get("/messages", ownerController.messagesPage);
router.post("/messages/reply", ownerController.replyMessage);

// Notifications
router.get("/notifications", ownerController.notificationsPage);
router.post("/notifications/mark-read", ownerController.markAllNotificationsRead);

// Orders list + details
router.get("/orders", ownerController.ordersPage);
router.get("/orders/:id", ownerController.orderDetailsPage);
router.post("/orders/:id/complete", ownerController.markOrderComplete);

// Refunds
router.get("/refunds", ownerController.refundsPage);
router.post("/refunds/:id/approve", ownerController.approveRefund);
router.post("/refunds/:id/reject", ownerController.rejectRefund);

// If reply is not implemented yet, comment it out or add the function
// router.post("/messages/reply/:id", ownerController.replyMessage);

module.exports = router;
