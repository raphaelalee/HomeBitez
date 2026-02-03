// db.js
const mysql = require('mysql2/promise');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env'), override: true });

const DB_HOST = process.env.DB_HOST;
const DB_USER = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;
const DB_DATABASE = process.env.DB_DATABASE;
const DB_PORT = parseInt(process.env.DB_PORT);

const pool = mysql.createPool({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_DATABASE,
    port: DB_PORT,
    waitForConnections: true,
    connectionLimit: 10,
    timezone: 'Z',
});

// Test connection
(async () => {
    try {
        const conn = await pool.getConnection();
        console.log('✅ Database connected successfully!');
        conn.release();
    } catch (err) {
        console.error('❌ Database connection error:', err);
    }
})();

module.exports = pool;
