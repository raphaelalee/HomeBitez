const db = require('../db');

module.exports = {
    // Ensure points column exists on users table
    async ensurePointsColumn() {
        try {
            await db.execute("ALTER TABLE users ADD COLUMN points INT NOT NULL DEFAULT 0");
        } catch (err) {
            // ignore if exists
        }
    },

    // Ensure points history table exists
    async ensurePointsHistoryTable() {
        const sql = `
            CREATE TABLE IF NOT EXISTS user_points_history (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                points INT NOT NULL,
                description VARCHAR(255) NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`;
        await db.execute(sql);
    },

    async getPoints(userId) {
        await this.ensurePointsColumn();
        const [rows] = await db.execute("SELECT points FROM users WHERE id = ? LIMIT 1", [userId]);
        return rows && rows[0] ? Number(rows[0].points || 0) : 0;
    },

    async getPointsHistory(userId, limit = 50) {
        await this.ensurePointsHistoryTable();
        const safeUserId = Number(userId);
        if (!Number.isFinite(safeUserId)) return [];
        const safeLimit = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
        const [rows] = await db.query(
            `SELECT created_at, description, points
             FROM user_points_history
             WHERE user_id = ?
             ORDER BY created_at ASC
             LIMIT ${safeLimit}`,
            [safeUserId]
        );
        return rows.map(r => ({
            date: r.created_at ? new Date(r.created_at).toLocaleString() : '',
            desc: r.description || '',
            points: Number(r.points || 0)
        }));
    },

    async addPoints(userId, delta, description = null) {
        if (!userId || !Number.isFinite(Number(delta))) return null;
        const pointsToAdd = Number(delta);
        await this.ensurePointsColumn();
        await this.ensurePointsHistoryTable();
        await db.execute("UPDATE users SET points = points + ? WHERE id = ?", [pointsToAdd, userId]);
        await db.execute(
            "INSERT INTO user_points_history (user_id, points, description) VALUES (?, ?, ?)",
            [userId, pointsToAdd, description || 'Points adjustment']
        );
        const [rows] = await db.execute("SELECT points FROM users WHERE id = ? LIMIT 1", [userId]);
        const balance = rows && rows[0] ? Number(rows[0].points || 0) : pointsToAdd;
        return {
            balance,
            entry: {
                date: new Date().toLocaleString(),
                desc: description || 'Points adjustment',
                points: pointsToAdd,
                balanceAfter: balance
            }
        };
    },

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
    },

    async ensurePasswordResetTable() {
        const sql = `
            CREATE TABLE IF NOT EXISTS password_resets (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                token VARCHAR(128) NOT NULL,
                expires_at DATETIME NOT NULL,
                used TINYINT(1) DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_token (token),
                INDEX idx_user (user_id)
            )`;
        await db.execute(sql);
    },

    async createPasswordReset(userId, token, expiresAt) {
        await this.ensurePasswordResetTable();
        await db.execute(
            "INSERT INTO password_resets (user_id, token, expires_at, used) VALUES (?, ?, ?, 0)",
            [userId, token, expiresAt]
        );
        return true;
    },

    async findValidPasswordReset(token) {
        await this.ensurePasswordResetTable();
        const [rows] = await db.execute(
            "SELECT * FROM password_resets WHERE token = ? AND used = 0 AND expires_at > NOW() LIMIT 1",
            [token]
        );
        return rows && rows[0] ? rows[0] : null;
    },

    async markPasswordResetUsed(id) {
        await this.ensurePasswordResetTable();
        await db.execute("UPDATE password_resets SET used = 1 WHERE id = ?", [id]);
        return true;
    }

};

