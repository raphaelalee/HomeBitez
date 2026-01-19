const express = require('express');
const router = express.Router();
const db = require('../db');
const OrdersModel = require('../Models/OrdersModel');

// Restrict debug routes to admin or biz_owner sessions for safety
function requireDebugRole(req, res, next) {
  const user = req.session && req.session.user;
  if (!user || (user.role !== 'admin' && user.role !== 'biz_owner')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// Raw DB rows (all physical columns)
router.get('/orders/raw', requireDebugRole, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 20');
    return res.json(rows);
  } catch (err) {
    console.error('debug /orders/raw error:', err);
    return res.status(500).json({ error: 'DB error' });
  }
});

// Mapped orders using OrdersModel.list()
router.get('/orders/mapped', requireDebugRole, async (req, res) => {
  try {
    const rows = await OrdersModel.list(20);
    return res.json(rows);
  } catch (err) {
    console.error('debug /orders/mapped error:', err);
    return res.status(500).json({ error: 'Model error' });
  }
});

// Mapped single order by id
router.get('/orders/:id', requireDebugRole, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const order = await OrdersModel.getById(id);
    return res.json(order || {});
  } catch (err) {
    console.error('debug /orders/:id error:', err);
    return res.status(500).json({ error: 'Model error' });
  }
});

module.exports = router;
