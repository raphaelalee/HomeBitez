/*
I declare that this code was written by me.
I will not copy or allow others to copy my code.
I understand that copying code is considered as plagiarism.

Student Name: Marcus
Student ID: 24002725
Class: E63C c004
Date created: December 10, 2025
*/

const express = require('express');
const router = express.Router();
const cartController = require('../Controllers/cartController');

router.get('/', cartController.viewCart);
router.post('/add', cartController.addToCart);
router.post('/update', cartController.updateItem);
router.post('/remove', cartController.removeItem);
router.post('/clear', cartController.clearCart);
router.post('/redeem', cartController.redeemPoints);
router.post('/selection', cartController.saveCheckoutSelection);

// NEW: save cutlery + pickup datetime in session
router.post('/preferences', cartController.savePreferences);

module.exports = router;

