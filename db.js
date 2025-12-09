// db.js
const mysql = require('mysql2');
const path = require('path');
const dotenv = require('dotenv');

// Force dotenv to load .env from the current directory
dotenv.config({ path: path.join(__dirname, '.env'), debug: true });

// Log environment variables to verify they are loaded
console.log('DB_HOST:', process.env.DB_HOST);
console.log('DB_PORT:', process.env.DB_PORT);
console.log('DB_USER:', process.env.DB_USER);
console.log('DB_DATABASE:', process.env.DB_DATABASE);

// Create MySQL connection pool
const pool = mysql.createPool({
    host: process.env.DB_HOST?.trim(),
    user: process.env.DB_USER?.trim(),
    password: process.env.DB_PASSWORD?.trim(),
    database: process.env.DB_DATABASE?.trim(),
    port: Number(process.env.DB_PORT?.trim()) || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Test the connection immediately
pool.getConnection()
    .then(conn => {
        console.log('✅ Database connected successfully!');
        conn.release();
    })
    .catch(err => {
        console.error('❌ Database connection error:', err);
    });

module.exports = pool.promise();


