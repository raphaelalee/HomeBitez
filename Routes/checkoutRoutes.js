const express = require("express");
const router = express.Router();

const checkoutController = require("../controllers/checkoutController"); 

router.get("/checkout", checkoutController.renderCheckout);

router.post("/paypal/create-order", checkoutController.createPaypalOrder);
router.post("/paypal/capture-order", checkoutController.capturePaypalOrder);

module.exports = router;
