const express = require('express');
const router = express.Router();
const cartController = require('../controllers/cartController');

router.get('/', cartController.viewCart);
router.post('/add', cartController.addToCart);
router.post('/update', cartController.updateItem);
router.post('/remove', cartController.removeItem);

module.exports = router;
