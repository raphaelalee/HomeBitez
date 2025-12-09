const db = require('../db');

module.exports = {

    async findByEmail(email) {
        const query = `SELECT * FROM users WHERE email = ?`;
        const [rows] = await db.execute(query, [email]);
        return rows[0];
    },

    async create({ email, password }) {
        const query = `INSERT INTO users (email, password) VALUES (?, ?)`;
        await db.execute(query, [email, password]);
        return true;
    }
};
