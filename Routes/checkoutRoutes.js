// Routes/checkoutRoutes.js
const express = require("express");
const router = express.Router();

const checkoutController = require("../controllers/checkoutController");

// Checkout page
router.get("/checkout", checkoutController.renderCheckout);

// PayLater page
router.get("/paylater", checkoutController.renderPayLater);
router.post("/paylater/choose", checkoutController.choosePayLater);

// Receipt page
router.get("/receipt", checkoutController.renderReceipt);

// PayPal
router.post("/paypal/create-order", checkoutController.createPaypalOrder);
router.post("/paypal/capture-order", checkoutController.capturePaypalOrder);

// NETS QR (no separate nets routes folder, relax)
router.post("/nets-qr/request", checkoutController.requestNetsQr);

module.exports = router;
