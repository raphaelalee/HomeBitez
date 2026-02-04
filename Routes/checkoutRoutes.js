// Routes/checkoutRoutes.js
const express = require("express");
const router = express.Router();

const checkoutController = require("../controllers/checkoutController");

// Checkout page
router.get("/checkout", checkoutController.renderCheckout);

// PayLater page
router.get("/paylater", checkoutController.renderPayLater);
router.post("/paylater/choose", checkoutController.choosePayLater);
router.post("/paylater/wallet/pay", checkoutController.payPayLaterWallet);
router.post("/paylater/pay-installment/paypal", checkoutController.startPayLaterInstallmentPaypal);
router.post("/paylater/pay-early/paypal", checkoutController.startPayLaterEarlyPaypal);
router.get("/paylater/paypal", checkoutController.renderPayLaterPaypal);
router.post("/paylater/paypal/create-order", checkoutController.createPayLaterPaypalOrder);
router.post("/paylater/paypal/capture-order", checkoutController.capturePayLaterPaypalOrder);

// Receipt page
router.get("/receipt", checkoutController.renderReceipt);

// PayPal
router.post("/paypal/create-order", checkoutController.createPaypalOrder);
router.post("/paypal/capture-order", checkoutController.capturePaypalOrder);

module.exports = router;
