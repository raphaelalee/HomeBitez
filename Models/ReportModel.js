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
            status ENUM('new','in_progress','resolved') DEFAULT 'new',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `;
    await db.execute(createSql);
    tableEnsured = true;
}

module.exports = {
    async create({ userId = null, name, email, subject, description }) {
        await ensureTable();
        const query = `
            INSERT INTO report_messages (user_id, name, email, subject, description, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, NOW())
        `;
        const status = 'new';
        await db.execute(query, [userId, name, email, subject, description, status]);
        return true;
    }
};
