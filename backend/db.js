// backend/db.js — Pool MySQL chia sẻ (hỗ trợ callback-style cho admin-routes.js)
// Dùng cùng biến môi trường với server.js để tránh lệch cấu hình DB
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mysql = require('mysql2');

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'hsk_flashcard',
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4',
    // FIX: bật SSL khi deploy lên cloud MySQL (Aiven...) qua biến DB_SSL=true
    ...(process.env.DB_SSL === 'true' ? { ssl: { rejectUnauthorized: false } } : {}),
});

module.exports = pool;
