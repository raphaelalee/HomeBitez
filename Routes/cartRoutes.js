const express = require('express');
const router = express.Router();
const cartController = require('../controllers/cartController');

router.get('/', cartController.viewCart);
router.post('/add', cartController.addToCart);
router.post('/update', cartController.updateItem);
router.post('/remove', cartController.removeItem);
router.post('/clear', cartController.clearCart);

// NEW: save cutlery + pickup datetime in session
router.post('/preferences', cartController.savePreferences);

module.exports = router;

