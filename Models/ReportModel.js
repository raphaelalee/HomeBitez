const db = require('../db');

// Ensure the table exists before inserts (idempotent)
let tableEnsured = false;
async function ensureTable() {
    if (tableEnsured) return;
    const createSql = `
        CREATE TABLE IF NOT EXISTS report_messages (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NULL,
            name VARCHAR(100) NOT NULL,
            email VARCHAR(150) NOT NULL,
            subject VARCHAR(200) NOT NULL,
            description TEXT NOT NULL,
            order_id VARCHAR(50) NULL,
            address VARCHAR(255) NULL,
            image_url VARCHAR(255) NULL,
            status ENUM('new','in_progress','resolved') DEFAULT 'new',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `;
    await db.execute(createSql);
    try { await db.execute("ALTER TABLE report_messages ADD COLUMN order_id VARCHAR(50) NULL"); } catch (err) {}
    try { await db.execute("ALTER TABLE report_messages ADD COLUMN address VARCHAR(255) NULL"); } catch (err) {}
    try { await db.execute("ALTER TABLE report_messages ADD COLUMN image_url VARCHAR(255) NULL"); } catch (err) {}
    tableEnsured = true;
}

module.exports = {
    async create({ userId = null, name, email, subject, description, orderId = null, address = null, imageUrl = null }) {
        await ensureTable();
        const query = `
            INSERT INTO report_messages (user_id, name, email, subject, description, order_id, address, image_url, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `;
        const status = 'new';
        await db.execute(query, [userId, name, email, subject, description, orderId, address, imageUrl, status]);
        return true;
    }
};
