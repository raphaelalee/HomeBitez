const express = require("express");
const router = express.Router();
const ownerController = require("../controllers/bizownerController");

// Correct multer usage
const { upload } = require("../app");   // ✅ CORRECT


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

// Orders list + details
router.get("/orders", ownerController.ordersPage);
router.get("/orders/:id", ownerController.orderDetailsPage);
router.post("/orders/:id/complete", ownerController.markOrderComplete);

// If reply is not implemented yet, comment it out or add the function
// router.post("/messages/reply/:id", ownerController.replyMessage);

module.exports = router;
