const db = require("../db");

module.exports = {
  async getByUserId(userId) {
    const [rows] = await db.query(
      "SELECT name, price, quantity, image FROM cart_items WHERE user_id = ? ORDER BY id ASC",
      [userId]
    );
    return rows || [];
  },

  async upsertItem(userId, item) {
    const { name, price, quantity, image } = item;
    await db.query(
      `INSERT INTO cart_items (user_id, name, price, quantity, image)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         quantity = quantity + VALUES(quantity),
         price = VALUES(price),
         image = VALUES(image)`,
      [userId, name, price, quantity, image]
    );
  },

  async updateQuantity(userId, name, quantity) {
    await db.query(
      "UPDATE cart_items SET quantity = ? WHERE user_id = ? AND name = ?",
      [quantity, userId, name]
    );
  },

  async removeItem(userId, name) {
    await db.query(
      "DELETE FROM cart_items WHERE user_id = ? AND name = ?",
      [userId, name]
    );
  },

  async clearCart(userId) {
    await db.query(
      "DELETE FROM cart_items WHERE user_id = ?",
      [userId]
    );
  }
};
