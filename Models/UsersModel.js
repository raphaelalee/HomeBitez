const db = require('../db');

module.exports = {

    // Find user by email or username (login)
    async findByEmailOrUsername(identifier) {
        const query = `
            SELECT * FROM users
            WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?)
            LIMIT 1
        `;
        const [rows] = await db.execute(query, [identifier, identifier]);
        return rows[0];
    },

    // Find user by email (registration check)
    async findByEmail(email) {
        const query = `
            SELECT * FROM users
            WHERE LOWER(email) = LOWER(?)
            LIMIT 1
        `;
        const [rows] = await db.execute(query, [email]);
        return rows[0];
    },

    // Find user by ID (for change password)
    async findById(id) {
        const query = `
            SELECT * FROM users
            WHERE id = ?
            LIMIT 1
        `;
        const [rows] = await db.execute(query, [id]);
        return rows;
    },

    // Create new user
    async create({ username, email, contact, password, address = '', role = 'user' }) {
        const query = `
            INSERT INTO users (username, email, password, contact, address, role)
            VALUES (?, ?, ?, ?, ?, ?)
        `;
        await db.execute(query, [username, email, password, contact, address, role]);
        return true;
    },

    // Update user password
    async updatePassword(id, hashedPassword) {
        const query = `
            UPDATE users
            SET password = ?
            WHERE id = ?
        `;
        await db.execute(query, [hashedPassword, id]);
        return true;
    }

};

