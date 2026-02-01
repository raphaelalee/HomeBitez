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
      payer_email VARCHAR(200) NULL,
      shipping_name VARCHAR(200) NULL,
      items LONGTEXT NULL,
      subtotal DECIMAL(10,2) NOT NULL DEFAULT 0,
      delivery_fee DECIMAL(10,2) NOT NULL DEFAULT 0,
      total DECIMAL(10,2) NOT NULL DEFAULT 0,
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
      { logical: 'payer_email', candidates: ['payer_email', 'payerEmail', 'email'], value: order.payerEmail || null},
      { logical: 'shipping_name', candidates: ['shipping_name', 'shippingName'], value: order.shippingName || null},
      { logical: 'items', candidates: ['items', 'order_items', 'orderItems'], value: order.items ? JSON.stringify(order.items) : null},
      { logical: 'subtotal', candidates: ['subtotal', 'subTotal'], value: order.subtotal || 0},
      { logical: 'delivery_fee', candidates: ['delivery_fee', 'deliveryFee'], value: order.deliveryFee || 0},
      { logical: 'total', candidates: ['total', 'totalAmount', 'total_amount'], value: order.total || 0},
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
      { alias: 'payer_email', candidates: ['payer_email', 'payerEmail', 'email'] },
      { alias: 'shipping_name', candidates: ['shipping_name', 'shippingName'] },
      { alias: 'items', candidates: ['items', 'order_items', 'orderItems'] },
      { alias: 'subtotal', candidates: ['subtotal', 'subTotal'] },
      { alias: 'delivery_fee', candidates: ['delivery_fee', 'deliveryFee'] },
      { alias: 'total', candidates: ['total', 'totalAmount', 'total_amount'] },
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
      { alias: 'payer_email', candidates: ['payer_email', 'payerEmail', 'email'] },
      { alias: 'shipping_name', candidates: ['shipping_name', 'shippingName'] },
      { alias: 'items', candidates: ['items', 'order_items', 'orderItems'] },
      { alias: 'subtotal', candidates: ['subtotal', 'subTotal'] },
      { alias: 'delivery_fee', candidates: ['delivery_fee', 'deliveryFee'] },
      { alias: 'total', candidates: ['total', 'totalAmount', 'total_amount'] },
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
      { alias: 'payer_email', candidates: ['payer_email', 'payerEmail', 'email'] },
      { alias: 'shipping_name', candidates: ['shipping_name', 'shippingName'] },
      { alias: 'items', candidates: ['items', 'order_items', 'orderItems'] },
      { alias: 'subtotal', candidates: ['subtotal', 'subTotal'] },
      { alias: 'delivery_fee', candidates: ['delivery_fee', 'deliveryFee'] },
      { alias: 'total', candidates: ['total', 'totalAmount', 'total_amount'] },
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
  }
};
