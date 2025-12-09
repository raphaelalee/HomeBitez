// db.js
const mysql = require('mysql2');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables and override any existing ones
dotenv.config({ path: path.join(__dirname, '.env'), override: true });

// Extract and trim environment variables
const DB_HOST = process.env.DB_HOST?.trim();
const DB_USER = process.env.DB_USER?.trim();
const DB_PASSWORD = process.env.DB_PASSWORD?.trim();
const DB_DATABASE = process.env.DB_DATABASE?.trim();
const DB_PORT = process.env.DB_PORT ? Number(process.env.DB_PORT.trim()) : 3306;

// Create a MySQL connection pool (promise version)
const pool = mysql.createPool({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_DATABASE,
    port: DB_PORT,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
}).promise();

// Test connection immediately
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




