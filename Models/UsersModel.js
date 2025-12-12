const db = require('../db');

module.exports = {

    async findByEmailOrUsername(identifier) {
        const query = `
            SELECT * FROM users
            WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?)
            LIMIT 1
        `;
        const [rows] = await db.execute(query, [identifier, identifier]);
        return rows[0];
    },

    async create({ username, email, contact, password, address = '', role = 'user' }) {
        const query = `
            INSERT INTO users (username, email, password, contact, address, role)
            VALUES (?, ?, ?, ?, ?, ?)
        `;
        await db.execute(query, [username, email, password, contact, address, role]);
        return true;
    }
};
