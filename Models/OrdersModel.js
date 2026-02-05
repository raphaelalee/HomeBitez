const db = require('../db');

let tableEnsured = false;
async function ensureTable() {
  if (tableEnsured) return;
  const createSql = `
    CREATE TABLE IF NOT EXISTS orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      paypal_order_id VARCHAR(100) NULL,
      paypal_capture_id VARCHAR(100) NULL,
      stripe_payment_intent VARCHAR(120) NULL,
      payer_email VARCHAR(200) NULL,
      shipping_name VARCHAR(200) NULL,
      items LONGTEXT NULL,
      subtotal DECIMAL(10,2) NOT NULL DEFAULT 0,
      delivery_fee DECIMAL(10,2) NOT NULL DEFAULT 0,
      total DECIMAL(10,2) NOT NULL DEFAULT 0,
      paylater_months INT NULL,
      paylater_monthly DECIMAL(10,2) NULL,
      paylater_paid DECIMAL(10,2) NULL,
      paylater_remaining DECIMAL(10,2) NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await db.execute(createSql);

  // add fulfillment status columns if missing
  try {
    const statusExists = await columnExists("status");
    if (!statusExists) {
      await db.execute("ALTER TABLE orders ADD COLUMN status VARCHAR(30) NULL");
      columnCache.status = true;
    }
  } catch (err) {
    console.error("ensureTable: add status column failed:", err);
  }

  try {
    const completedAtExists = await columnExists("completed_at");
    if (!completedAtExists) {
      await db.execute("ALTER TABLE orders ADD COLUMN completed_at DATETIME NULL");
      columnCache.completed_at = true;
    }
  } catch (err) {
    console.error("ensureTable: add completed_at column failed:", err);
  }

  try {
    const monthsExists = await columnExists("paylater_months");
    if (!monthsExists) {
      await db.execute("ALTER TABLE orders ADD COLUMN paylater_months INT NULL");
      columnCache.paylater_months = true;
    }
  } catch (err) {
    console.error("ensureTable: add paylater_months column failed:", err);
  }

  try {
    const monthlyExists = await columnExists("paylater_monthly");
    if (!monthlyExists) {
      await db.execute("ALTER TABLE orders ADD COLUMN paylater_monthly DECIMAL(10,2) NULL");
      columnCache.paylater_monthly = true;
    }
  } catch (err) {
    console.error("ensureTable: add paylater_monthly column failed:", err);
  }

  try {
    const paidExists = await columnExists("paylater_paid");
    if (!paidExists) {
      await db.execute("ALTER TABLE orders ADD COLUMN paylater_paid DECIMAL(10,2) NULL");
      columnCache.paylater_paid = true;
    }
  } catch (err) {
    console.error("ensureTable: add paylater_paid column failed:", err);
  }

  try {
    const remainingExists = await columnExists("paylater_remaining");
    if (!remainingExists) {
      await db.execute("ALTER TABLE orders ADD COLUMN paylater_remaining DECIMAL(10,2) NULL");
      columnCache.paylater_remaining = true;
    }
  } catch (err) {
    console.error("ensureTable: add paylater_remaining column failed:", err);
  }
  try {
    const stripeIntentExists = await columnExists("stripe_payment_intent");
    if (!stripeIntentExists) {
      await db.execute("ALTER TABLE orders ADD COLUMN stripe_payment_intent VARCHAR(120) NULL");
      columnCache.stripe_payment_intent = true;
    }
  } catch (err) {
    console.error("ensureTable: add stripe_payment_intent column failed:", err);
  }
  tableEnsured = true;
}

// cache for column checks
const columnCache = {};
async function columnExists(columnName) {
  if (columnCache[columnName] !== undefined) return columnCache[columnName];
  try {
    const [rows] = await db.query(
      `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = ?`,
      [columnName]
    );
    const exists = rows && rows[0] && rows[0].cnt > 0;
    columnCache[columnName] = !!exists;
    return exists;
  } catch (err) {
    // if information_schema not accessible, assume false
    console.error('columnExists error:', err);
    columnCache[columnName] = false;
    return false;
  }
}

// Find first existing column from a list of candidates. Returns the actual column name or null.
async function findExistingColumn(candidates) {
  for (const c of candidates) {
    if (await columnExists(c)) return c;
  }
  return null;
}

module.exports = {
  async create(order) {
    await ensureTable();
    // Map logical columns to physical DB columns (support snake_case and camelCase variants)
    const mappings = [
      { logical: 'user_id', candidates: ['user_id', 'userId', 'user'] , value: order.userId || null},
      { logical: 'paypal_order_id', candidates: ['paypal_order_id', 'paypalOrderId'], value: order.paypalOrderId || null},
      { logical: 'paypal_capture_id', candidates: ['paypal_capture_id', 'paypalCaptureId'], value: order.paypalCaptureId || null},
      { logical: 'stripe_payment_intent', candidates: ['stripe_payment_intent', 'stripePaymentIntent', 'payment_intent'], value: order.stripePaymentIntent || null},
      { logical: 'payer_email', candidates: ['payer_email', 'payerEmail', 'email'], value: order.payerEmail || null},
      { logical: 'shipping_name', candidates: ['shipping_name', 'shippingName'], value: order.shippingName || null},
      { logical: 'items', candidates: ['items', 'order_items', 'orderItems'], value: order.items ? JSON.stringify(order.items) : null},
      { logical: 'subtotal', candidates: ['subtotal', 'subTotal'], value: order.subtotal || 0},
      { logical: 'delivery_fee', candidates: ['delivery_fee', 'deliveryFee'], value: order.deliveryFee || 0},
      { logical: 'total', candidates: ['total', 'totalAmount', 'total_amount'], value: order.total || 0},
      { logical: 'paylater_months', candidates: ['paylater_months', 'paylaterMonths'], value: order.paylaterMonths || null},
      { logical: 'paylater_monthly', candidates: ['paylater_monthly', 'paylaterMonthly'], value: order.paylaterMonthly || null},
      { logical: 'paylater_paid', candidates: ['paylater_paid', 'paylaterPaid'], value: order.paylaterPaid || null},
      { logical: 'paylater_remaining', candidates: ['paylater_remaining', 'paylaterRemaining'], value: order.paylaterRemaining || null},
      { logical: 'status', candidates: ['status', 'order_status', 'state'], value: order.status || null},
      { logical: 'completed_at', candidates: ['completed_at', 'completedAt'], value: order.completedAt || null}
    ];

    const availableCols = [];
    const placeholders = [];
    const params = [];

    for (const m of mappings) {
      const physical = await findExistingColumn(m.candidates);
      if (physical) {
        availableCols.push(physical);
        placeholders.push('?');
        params.push(m.value);
      }
    }

    // Ensure there is at least one column to insert (should be true)
    if (availableCols.length === 0) {
      // fallback minimal insert to avoid SQL error; create a basic total column if present
      const fallbackCols = [];
      const fallbackPlaceholders = [];
      const fallbackParams = [];
      if (await columnExists('total')) {
        fallbackCols.push('total');
        fallbackPlaceholders.push('?');
        fallbackParams.push(order.total || 0);
      }
      if (fallbackCols.length === 0) throw new Error('No writable columns found in orders table');
      const q = `INSERT INTO orders (${fallbackCols.join(',')}, created_at) VALUES (${fallbackPlaceholders.join(',')}, NOW())`;
      const [res] = await db.execute(q, fallbackParams);
      return res.insertId;
    }

    const q = `INSERT INTO orders (${availableCols.join(',')}, created_at) VALUES (${placeholders.join(',')}, NOW())`;
    const [result] = await db.execute(q, params);
    try { console.log('OrdersModel.create inserted id=', result.insertId, 'cols=', availableCols); } catch(e){}
    return result.insertId;
  },
  async list(limit = 100) {
    await ensureTable();
    // Build a safe SELECT list depending on which columns exist in the DB.
    // Select physical columns where available, aliasing them to canonical names expected by the app.
    const colMap = [
      { alias: 'id', candidates: ['id'] },
      { alias: 'user_id', candidates: ['user_id', 'userId', 'user'] },
      { alias: 'paypal_order_id', candidates: ['paypal_order_id', 'paypalOrderId'] },
      { alias: 'paypal_capture_id', candidates: ['paypal_capture_id', 'paypalCaptureId'] },
      { alias: 'stripe_payment_intent', candidates: ['stripe_payment_intent', 'stripePaymentIntent', 'payment_intent'] },
      { alias: 'payer_email', candidates: ['payer_email', 'payerEmail', 'email'] },
      { alias: 'shipping_name', candidates: ['shipping_name', 'shippingName'] },
      { alias: 'items', candidates: ['items', 'order_items', 'orderItems'] },
      { alias: 'subtotal', candidates: ['subtotal', 'subTotal'] },
      { alias: 'delivery_fee', candidates: ['delivery_fee', 'deliveryFee'] },
      { alias: 'total', candidates: ['total', 'totalAmount', 'total_amount'] },
      { alias: 'paylater_months', candidates: ['paylater_months', 'paylaterMonths'] },
      { alias: 'paylater_monthly', candidates: ['paylater_monthly', 'paylaterMonthly'] },
      { alias: 'paylater_paid', candidates: ['paylater_paid', 'paylaterPaid'] },
      { alias: 'paylater_remaining', candidates: ['paylater_remaining', 'paylaterRemaining'] },
      { alias: 'created_at', candidates: ['created_at', 'createdAt'] },
      { alias: 'status', candidates: ['status', 'order_status', 'state'] },
      { alias: 'completed_at', candidates: ['completed_at', 'completedAt'] }
    ];

    const selectParts = [];
    for (const m of colMap) {
      const physical = await findExistingColumn(m.candidates);
      if (physical) selectParts.push(`${physical} AS ${m.alias}`);
      else selectParts.push(`NULL AS ${m.alias}`);
    }

    const sql = `SELECT ${selectParts.join(', ')} FROM orders ORDER BY created_at DESC LIMIT ?`;
    const [rows] = await db.query(sql, [Number(limit) || 100]);
    return rows.map(rw => ({ ...rw, items: rw.items ? (() => { try { return JSON.parse(rw.items); } catch(e){ return []; } })() : [] }));
  },
  async listByUser(userId, limit = 100) {
    await ensureTable();
    if (!userId) return this.list(limit);

    const colMap = [
      { alias: 'id', candidates: ['id'] },
      { alias: 'user_id', candidates: ['user_id', 'userId', 'user'] },
      { alias: 'paypal_order_id', candidates: ['paypal_order_id', 'paypalOrderId'] },
      { alias: 'paypal_capture_id', candidates: ['paypal_capture_id', 'paypalCaptureId'] },
      { alias: 'stripe_payment_intent', candidates: ['stripe_payment_intent', 'stripePaymentIntent', 'payment_intent'] },
      { alias: 'payer_email', candidates: ['payer_email', 'payerEmail', 'email'] },
      { alias: 'shipping_name', candidates: ['shipping_name', 'shippingName'] },
      { alias: 'items', candidates: ['items', 'order_items', 'orderItems'] },
      { alias: 'subtotal', candidates: ['subtotal', 'subTotal'] },
      { alias: 'delivery_fee', candidates: ['delivery_fee', 'deliveryFee'] },
      { alias: 'total', candidates: ['total', 'totalAmount', 'total_amount'] },
      { alias: 'paylater_months', candidates: ['paylater_months', 'paylaterMonths'] },
      { alias: 'paylater_monthly', candidates: ['paylater_monthly', 'paylaterMonthly'] },
      { alias: 'paylater_paid', candidates: ['paylater_paid', 'paylaterPaid'] },
      { alias: 'paylater_remaining', candidates: ['paylater_remaining', 'paylaterRemaining'] },
      { alias: 'created_at', candidates: ['created_at', 'createdAt'] },
      { alias: 'status', candidates: ['status', 'order_status', 'state'] },
      { alias: 'completed_at', candidates: ['completed_at', 'completedAt'] }
    ];

    const selectParts = [];
    let userCol = null;
    for (const m of colMap) {
      const physical = await findExistingColumn(m.candidates);
      if (physical) {
        selectParts.push(`${physical} AS ${m.alias}`);
        if (m.alias === 'user_id' && !userCol) userCol = physical;
      } else {
        selectParts.push(`NULL AS ${m.alias}`);
      }
    }

    if (!userCol) return this.list(limit);

    const sql = `SELECT ${selectParts.join(', ')} FROM orders WHERE ${userCol} = ? ORDER BY created_at DESC LIMIT ?`;
    const [rows] = await db.query(sql, [userId, Number(limit) || 100]);
    return rows.map(rw => ({ ...rw, items: rw.items ? (() => { try { return JSON.parse(rw.items); } catch(e){ return []; } })() : [] }));
  },
  async getById(id) {
    await ensureTable();
    // Use same mapping approach as list() so we support camelCase and snake_case column names.
    const colMap = [
      { alias: 'id', candidates: ['id', 'ID', 'order_id', 'orderId'] },
      { alias: 'user_id', candidates: ['user_id', 'userId', 'user'] },
      { alias: 'paypal_order_id', candidates: ['paypal_order_id', 'paypalOrderId'] },
      { alias: 'paypal_capture_id', candidates: ['paypal_capture_id', 'paypalCaptureId'] },
      { alias: 'stripe_payment_intent', candidates: ['stripe_payment_intent', 'stripePaymentIntent', 'payment_intent'] },
      { alias: 'payer_email', candidates: ['payer_email', 'payerEmail', 'email'] },
      { alias: 'shipping_name', candidates: ['shipping_name', 'shippingName'] },
      { alias: 'items', candidates: ['items', 'order_items', 'orderItems'] },
      { alias: 'subtotal', candidates: ['subtotal', 'subTotal'] },
      { alias: 'delivery_fee', candidates: ['delivery_fee', 'deliveryFee'] },
      { alias: 'total', candidates: ['total', 'totalAmount', 'total_amount'] },
      { alias: 'paylater_months', candidates: ['paylater_months', 'paylaterMonths'] },
      { alias: 'paylater_monthly', candidates: ['paylater_monthly', 'paylaterMonthly'] },
      { alias: 'paylater_paid', candidates: ['paylater_paid', 'paylaterPaid'] },
      { alias: 'paylater_remaining', candidates: ['paylater_remaining', 'paylaterRemaining'] },
      { alias: 'created_at', candidates: ['created_at', 'createdAt'] },
      { alias: 'status', candidates: ['status', 'order_status', 'state'] },
      { alias: 'completed_at', candidates: ['completed_at', 'completedAt'] }
    ];

    // Build SELECT list and remember which physical column is the primary id for WHERE clause
    const selectParts = [];
    let physicalIdCol = null;
    for (const m of colMap) {
      const physical = await findExistingColumn(m.candidates);
      if (physical) {
        selectParts.push(`${physical} AS ${m.alias}`);
        if (m.alias === 'id' && !physicalIdCol) physicalIdCol = physical;
      } else {
        selectParts.push(`NULL AS ${m.alias}`);
      }
    }

    if (!physicalIdCol) {
      // if we couldn't find a physical id column, bail out
      return null;
    }

    const sql = `SELECT ${selectParts.join(', ')} FROM orders WHERE ${physicalIdCol} = ? LIMIT 1`;
    const [rows] = await db.query(sql, [id]);
    if (!rows || !rows[0]) return null;
    const out = rows[0];
    out.items = out.items ? (() => { try { return JSON.parse(out.items); } catch(e){ return []; } })() : [];
    return out;
  },

  async updateStatus(id, status) {
    await ensureTable();
    const idCol = await findExistingColumn(['id', 'order_id', 'orderId', 'ID']);
    const statusCol = await findExistingColumn(['status', 'order_status', 'state']);
    if (!idCol || !statusCol) return false;
    const completedCol = await findExistingColumn(['completed_at', 'completedAt']);

    const setParts = [`${statusCol} = ?`];
    const params = [status];
    if (completedCol) {
      setParts.push(`${completedCol} = NOW()`);
    }

    const sql = `UPDATE orders SET ${setParts.join(', ')} WHERE ${idCol} = ?`;
    params.push(id);
    await db.execute(sql, params);
    return true;
  },

  async applyPaylaterPayment(userId, amount) {
    await ensureTable();
    if (!userId || !Number.isFinite(Number(amount)) || Number(amount) <= 0) return 0;

    const userCol = await findExistingColumn(['user_id', 'userId', 'user']);
    const statusCol = await findExistingColumn(['status', 'order_status', 'state']);
    const remainingCol = await findExistingColumn(['paylater_remaining', 'paylaterRemaining']);
    const paidCol = await findExistingColumn(['paylater_paid', 'paylaterPaid']);
    const totalCol = await findExistingColumn(['total', 'totalAmount', 'total_amount']);
    const idCol = await findExistingColumn(['id', 'order_id', 'orderId', 'ID']);

    if (!userCol || !statusCol || !remainingCol || !paidCol || !idCol || !totalCol) return 0;

    const [rows] = await db.query(
      `SELECT ${idCol} AS id, ${remainingCol} AS remaining, ${paidCol} AS paid, ${totalCol} AS total
       FROM orders
       WHERE ${userCol} = ? AND ${statusCol} = ?
       ORDER BY created_at ASC`,
      [userId, 'paylater']
    );

    let remainingAmount = Number(amount);
    let applied = 0;

    for (const row of rows) {
      if (remainingAmount <= 0) break;
      const rowRemaining = Number((row.remaining ?? row.total) || 0);
      if (rowRemaining <= 0) continue;
      const pay = Math.min(remainingAmount, rowRemaining);
      const newRemaining = Number((rowRemaining - pay).toFixed(2));
      const newPaid = Number((Number(row.paid || 0) + pay).toFixed(2));
      const newStatus = newRemaining <= 0 ? 'paid' : 'paylater';

      await db.execute(
        `UPDATE orders SET ${remainingCol} = ?, ${paidCol} = ?, ${statusCol} = ? WHERE ${idCol} = ?`,
        [newRemaining, newPaid, newStatus, row.id]
      );

      remainingAmount = Number((remainingAmount - pay).toFixed(2));
      applied = Number((applied + pay).toFixed(2));
    }

    return applied;
  }
};
