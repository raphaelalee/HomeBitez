const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const path = require('path');

// -------------------- FILE UPLOAD STORAGE --------------------
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, '..', 'public', 'uploads'));
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + ext);
  }
});
const upload = multer({ storage });

// Temporary owner ID
const ownerId = 1;

// -------------------- DASHBOARD --------------------
router.get('/', async (req, res) => {
  try {
    // products count
    let prodCount = 0;
    try {
      const [prodRows] = await db.query('SELECT COUNT(*) AS cnt FROM products WHERE owner_id = ?', [ownerId]);
      prodCount = prodRows[0]?.cnt || 0;
    } catch (e) {
      prodCount = 0;
    }

    // messages count (messages table may not exist)
    let msgCount = 0;
    try {
      const [msgRows] = await db.query('SELECT COUNT(*) AS cnt FROM messages WHERE owner_id = ?', [ownerId]);
      msgCount = msgRows[0]?.cnt || 0;
    } catch (e) {
      msgCount = 0;
    }

    res.render('owner/dashboard', { stats: { products: prodCount, messages: msgCount } });
  } catch (err) {
    console.error(err);
    res.render('owner/dashboard', { stats: { products: 0, messages: 0 } });
  }
});

// -------------------- PROFILE --------------------
router.get('/profile', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM users WHERE id = ?', [ownerId]).catch(() => [[]]);
    const profile = rows[0] || { id: ownerId, username: 'Owner', email: '', address: '', contact: '' };
    res.render('owner/profile', { profile });
  } catch (err) {
    console.error(err);
    res.redirect('/owner');
  }
});

router.post('/profile', async (req, res) => {
  const { username, email, address, contact } = req.body;

  try {
    await db.query(
      'UPDATE users SET username=?, email=?, address=?, contact=? WHERE id=?',
      [username, email, address, contact, ownerId]
    );
    res.redirect('/owner/profile');
  } catch (err) {
    console.error(err);
    res.redirect('/owner/profile');
  }
});

// -------------------- INVENTORY --------------------
router.get('/inventory', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM products WHERE owner_id = ?', [ownerId]).catch(() => [[]]);
    res.render('owner/inventory', { products: rows || [] });
  } catch (err) {
    console.error(err);
    res.render('owner/inventory', { products: [] });
  }
});

// -------------------- ADD PRODUCT --------------------
router.get('/inventory/add', (req, res) => {
  res.render('owner/addProduct');
});

router.post('/inventory/add', upload.single('image'), async (req, res) => {
  const { name, description, price, stock } = req.body;
  const image = req.file ? `/uploads/${req.file.filename}` : null;

  try {
    // Try known schema, then fallback to alternative column names
    try {
      await db.query('INSERT INTO products (owner_id, productName, description, price, quantity, image) VALUES (?, ?, ?, ?, ?, ?)', [ownerId, name, description, price || 0, stock || 0, image]);
    } catch (e) {
      if (e && e.code === 'ER_BAD_FIELD_ERROR') {
        // fallback
        await db.query('INSERT INTO products (owner_id, name, description, price, stock, image) VALUES (?, ?, ?, ?, ?, ?)', [ownerId, name, description, price || 0, stock || 0, image]).catch(() => {});
      } else {
        throw e;
      }
    }
    res.redirect('/owner/inventory');
  } catch (err) {
    console.error(err);
    res.redirect('/owner/inventory');
  }
});

// -------------------- MESSAGES --------------------
router.get('/messages', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM messages WHERE owner_id = ? ORDER BY created_at DESC', [ownerId]).catch(() => [[]]);
    res.render('owner/messages', { messages: rows || [] });
  } catch (err) {
    console.error(err);
    res.render('owner/messages', { messages: [] });
  }
});

module.exports = router;
