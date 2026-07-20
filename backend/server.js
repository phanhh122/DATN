require('dns').setDefaultResultOrder('ipv4first');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const mysql = require('mysql2/promise');
const path = require('path');
const adminRoutes = require('./admin-routes');
const { computeNextState } = require('./srs');
const aiCache = require('./ai-cache');
const fs = require("fs");
const dotenv = require("dotenv");
const crypto = require('crypto');
const { sendResetPasswordEmail } = require('./mailer');
const { OAuth2Client } = require('google-auth-library');
const envPath = path.resolve(__dirname, "..", ".env");
dotenv.config({ path: envPath });

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'hsk_secret_2024';
// FIX: base URL dùng để dựng link đặt lại mật khẩu trong email — đặt
// APP_URL=https://ten-app.onrender.com trong .env khi deploy, để trống thì
// mặc định trỏ về localhost cho môi trường dev.
const APP_URL = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// FIX: đảm bảo mọi response /api/* luôn được coi là "không cache" — dữ liệu
// như due_today, danh sách thẻ SRS... thay đổi liên tục sau mỗi lần ôn tập,
// tuyệt đối không được để trình duyệt/thiết bị trung gian lưu lại bản cũ.
app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    next();
});

// FIX: Mount API routes BEFORE static middleware.
// express.static runs first and could theoretically interfere;
// placing all /api/* routes before it guarantees they are matched first.
app.use('/api/admin', adminRoutes);

// FIX BẢO MẬT (quan trọng khi deploy public): express.static bên dưới serve
// TOÀN BỘ thư mục gốc project (vì frontend nằm cùng cấp với backend/). Nếu
// không chặn, ai cũng có thể truy cập trực tiếp
// https://yourapp.com/backend/server.js, /backend/migrations/schema.sql,
// /backend/package.json... và đọc được toàn bộ source code + cấu trúc DB.
// Chặn mọi request vào /backend/* và các phần mở rộng nhạy cảm TRƯỚC khi tới
// express.static.
app.use((req, res, next) => {
    if (/^\/backend\//i.test(req.path) || /\.(sql|env|log)$/i.test(req.path)) {
        return res.status(404).end();
    }
    next();
});

// FIX: trình duyệt có thể cache module JS (import trong main.js như srs.js,
// dashboard.js...) rất lâu vì server không hề gửi header Cache-Control, khiến
// người dùng vẫn chạy code JS cũ dù server.js/index.html đã cập nhật — dẫn
// đến các fix ở frontend "không có tác dụng" cho tới khi hard-refresh thủ công.
// Tắt cache cho .js/.css để mọi lần tải trang luôn dùng bản mới nhất.
app.use(express.static(path.join(__dirname, '..'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
    }
}));

// ── MySQL Pool ──
// FIX: nhiều nhà cung cấp MySQL free trên cloud (Aiven, PlanetScale...) bắt
// buộc kết nối qua SSL, khác với XAMPP local (không cần SSL). Đặt biến môi
// trường DB_SSL=true khi deploy để bật, để trống/không đặt khi chạy local.
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'hsk_flashcard',
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4',
    ...(process.env.DB_SSL === 'true' ? { ssl: { rejectUnauthorized: false } } : {}),
});

async function q(sql, params = []) {
    const [rows] = await pool.execute(sql, params);
    return rows;
}
async function q1(sql, params = []) {
    const rows = await q(sql, params);
    return rows[0] || null;
}

// ── Test kết nối DB + đảm bảo schema đầy đủ (idempotent, chạy 1 lần lúc khởi động) ──
pool.getConnection()
    .then(async conn => {
        console.log('MySQL kết nối thành công');
        conn.release();
        await ensureSchema();
    })
    .catch(err => {
        console.error('MySQL lỗi kết nối:', err.message);
        process.exit(1);
    });

// Đảm bảo các bảng/cột cần thiết tồn tại (an toàn khi chạy nhiều lần).
// Xem backend/migrations/schema.sql để biết chi tiết + cách setup DB thủ công.
async function ensureSchema() {
    try {
        await pool.execute(`CREATE TABLE IF NOT EXISTS word_progress (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL, word_id INT NOT NULL,
            repetitions INT NOT NULL DEFAULT 0,
            ease_factor DECIMAL(4,2) NOT NULL DEFAULT 2.50,
            interval_days INT NOT NULL DEFAULT 0,
            next_review_date DATE NOT NULL DEFAULT (CURRENT_DATE),
            last_quality TINYINT NULL, last_reviewed_at DATETIME NULL,
            total_reviews INT NOT NULL DEFAULT 0, total_correct INT NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_user_word (user_id, word_id),
            KEY idx_user_due (user_id, next_review_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

        await pool.execute(`CREATE TABLE IF NOT EXISTS quiz_attempts (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL, word_id INT NOT NULL,
            hsk_level INT NULL, word_type VARCHAR(50) NULL,
            source ENUM('quiz','srs') NOT NULL DEFAULT 'quiz',
            is_correct TINYINT(1) NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            KEY idx_user_time (user_id, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

        await pool.execute(`CREATE TABLE IF NOT EXISTS ai_cache (
            id INT AUTO_INCREMENT PRIMARY KEY,
            cache_key VARCHAR(191) NOT NULL UNIQUE,
            kind VARCHAR(30) NOT NULL DEFAULT 'chat',
            response MEDIUMTEXT NOT NULL,
            hit_count INT NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            KEY idx_kind (kind)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

        // FIX (quên mật khẩu): bảng lưu token đặt lại mật khẩu. Token thật
        // gửi qua email KHÔNG được lưu trực tiếp trong DB — chỉ lưu bản
        // băm SHA-256 của nó (giống cách lưu password), để nếu DB bị lộ thì
        // kẻ tấn công vẫn không có token hợp lệ để dùng.
        await pool.execute(`CREATE TABLE IF NOT EXISTS password_resets (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            token_hash CHAR(64) NOT NULL,
            expires_at DATETIME NOT NULL,
            used TINYINT(1) NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            KEY idx_user (user_id),
            KEY idx_token (token_hash),
            CONSTRAINT fk_pr_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

        // Cột FSRS trên word_progress — thêm nếu chưa có (MySQL < 8 không hỗ trợ
        // "ADD COLUMN IF NOT EXISTS" nên phải try/catch từng cột).
        const fsrsCols = [
            `ALTER TABLE word_progress ADD COLUMN stability    DECIMAL(8,4) NULL`,
            `ALTER TABLE word_progress ADD COLUMN difficulty   DECIMAL(5,4) NULL`,
            `ALTER TABLE word_progress ADD COLUMN fsrs_state   TINYINT NOT NULL DEFAULT 0`,
            `ALTER TABLE word_progress ADD COLUMN elapsed_days INT NOT NULL DEFAULT 0`,
            // Đánh dấu thời điểm admin reset tiến độ — client dùng để biết cần xoá
            // cache localStorage cũ thay vì tự đồng bộ ngược đè lên bản đã reset.
            `ALTER TABLE users ADD COLUMN progress_reset_at DATETIME NULL`,
            // FIX (đăng nhập Google): lưu Google "sub" (id định danh duy nhất,
            // không đổi kể cả khi user đổi email) để nhận diện tài khoản Google
            // ở những lần đăng nhập sau, nhanh và ổn định hơn so với so email.
            `ALTER TABLE users ADD COLUMN google_id VARCHAR(64) NULL`,
        ];
        for (const sql of fsrsCols) {
            try { await pool.execute(sql); } catch (e) {
                if (!e.message.includes('Duplicate column')) console.warn('[schema] bỏ qua:', e.message);
            }
        }

        // FIX (đăng nhập Google): tài khoản tạo qua Google không có mật khẩu nội
        // bộ. Nếu cột `password` đang là NOT NULL (thường do tạo tay qua
        // phpMyAdmin lúc đầu dự án), phải nới thành NULL — nếu không mọi lần
        // tạo user Google mới sẽ lỗi "Column 'password' cannot be null".
        try {
            await pool.execute(`ALTER TABLE users MODIFY password VARCHAR(255) NULL`);
        } catch (e) { console.warn('[schema] bỏ qua (MODIFY password nullable):', e.message); }

        // FIX (đăng nhập Google + quên mật khẩu): đảm bảo mỗi email chỉ gắn
        // với đúng 1 tài khoản — nếu không, /api/auth/google và
        // /api/forgot-password có thể chọn nhầm user khi có 2 tài khoản
        // trùng email (trước đây `email` chỉ được kiểm tra trùng ở tầng ứng
        // dụng, không có ràng buộc UNIQUE thật ở DB).
        try {
            await pool.execute(`ALTER TABLE users ADD UNIQUE KEY uniq_email (email)`);
        } catch (e) {
            if (!/Duplicate key name|Duplicate entry|check that column\/key exists/i.test(e.message)) {
                console.warn('[schema] bỏ qua (UNIQUE email) — có thể có email trùng lặp sẵn trong DB:', e.message);
            }
        }
        try {
            await pool.execute(`ALTER TABLE users ADD UNIQUE KEY uniq_google_id (google_id)`);
        } catch (e) {
            if (!/Duplicate key name|check that column\/key exists/i.test(e.message)) {
                console.warn('[schema] bỏ qua (UNIQUE google_id):', e.message);
            }
        }

        // FIX QUAN TRỌNG: nếu bảng word_progress được tạo TỪ TRƯỚC (vd. qua
        // phpMyAdmin ở giai đoạn đầu dự án) mà KHÔNG có UNIQUE KEY
        // (user_id, word_id), thì `CREATE TABLE IF NOT EXISTS` ở trên sẽ
        // không làm gì (bảng đã tồn tại) — ràng buộc UNIQUE bị thiếu vĩnh viễn.
        // Hậu quả: câu `INSERT ... ON DUPLICATE KEY UPDATE` trong /api/srs/review
        // không có gì để "trùng" vào, nên mỗi lần ôn tập sẽ INSERT một dòng
        // MỚI thay vì cập nhật dòng cũ — dòng cũ (vẫn đang đến hạn hôm nay)
        // không hề bị thay đổi. Đây chính là nguyên nhân "ôn xong thẻ vẫn
        // hiện lại", "Đã học/Đã nhớ lệch số nhau" mà không có lỗi nào hiện ra,
        // vì mọi INSERT đều "thành công" — chỉ là thành công sai chỗ.
        // Cách sửa: gộp các dòng trùng (user_id, word_id) — giữ lại dòng có id
        // lớn nhất (mới nhất) — rồi thêm lại UNIQUE KEY nếu chưa có.
        try {
            const dupCheck = await pool.execute(
                `SELECT user_id, word_id, COUNT(*) c FROM word_progress
                 GROUP BY user_id, word_id HAVING c > 1 LIMIT 1`
            );
            if (dupCheck[0].length > 0) {
                console.warn('[schema] Phát hiện word_progress có dòng trùng lặp — đang gộp lại...');
                const [delResult] = await pool.execute(
                    `DELETE wp1 FROM word_progress wp1
                     INNER JOIN word_progress wp2
                       ON wp1.user_id = wp2.user_id
                      AND wp1.word_id = wp2.word_id
                      AND wp1.id < wp2.id`
                );
                console.warn(`[schema] Đã xoá ${delResult.affectedRows} dòng trùng lặp (giữ lại bản mới nhất mỗi từ/người dùng).`);
            }
            await pool.execute(
                `ALTER TABLE word_progress ADD UNIQUE KEY uniq_user_word (user_id, word_id)`
            );
            console.warn('[schema] Đã thêm UNIQUE KEY (user_id, word_id) cho word_progress.');
        } catch (e) {
            // "Duplicate key name" / "already exists" nghĩa là ràng buộc đã có sẵn — bỏ qua an toàn.
            if (!/Duplicate key name|check that column\/key exists/i.test(e.message)) {
                console.error('[schema] LỖI khi thêm UNIQUE KEY cho word_progress — /api/srs/review có thể lưu SAI (tạo dòng trùng thay vì cập nhật):', e.message);
            }
        }
    } catch (e) {
        console.error('Lỗi khởi tạo schema DB:', e.message);
    }
}

// ── Auth Middleware ──
function auth(req, res, next) {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ message: 'Cần đăng nhập' });
    try {
        req.user = jwt.verify(token, SECRET);
        next();
    } catch { res.status(401).json({ message: 'Token không hợp lệ' }); }
}

function adminOnly(req, res, next) {
    if (req.user.role !== 'admin') return res.status(403).json({ message: 'Không có quyền' });
    next();
}

// ── Map user row → safe object (chuẩn hóa tên cột ra ngoài) ──
function safeUser(u) {
    if (!u) return null;
    const { password, ...rest } = u;
    // Đổi fullname → name để frontend dùng thống nhất
    return {...rest, name: u.fullname || u.name || '' };
}

// ════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════
app.post('/api/login', async(req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ message: 'Thiếu thông tin' });

        const user = await q1('SELECT * FROM users WHERE username = ?', [username]);
        if (!user || !bcrypt.compareSync(password, user.password))
            return res.status(401).json({ message: 'Sai tên đăng nhập hoặc mật khẩu' });

        const token = jwt.sign({ id: user.id, username: user.username, role: user.role || 'user' },
            SECRET, { expiresIn: '30d' }
        );
        res.json({...safeUser(user), token });
    } catch (e) {
        console.error('[server]', e.message);
        res.status(500).json({ message: 'Lỗi server' });
    }
});

app.post('/api/register', async(req, res) => {
    try {
        const { username, password, name } = req.body;
        // FIX (quên mật khẩu): thu thập email ngay lúc đăng ký — không bắt
        // buộc (để không phá vỡ luồng đăng ký cũ), nhưng nếu không có email,
        // tài khoản sẽ không dùng được tính năng "Quên mật khẩu" sau này.
        const email = (req.body.email || '').trim() || null;
        if (!username || !password || !name)
            return res.status(400).json({ message: 'Vui lòng nhập đầy đủ thông tin' });
        if (password.length < 6)
            return res.status(400).json({ message: 'Mật khẩu tối thiểu 6 ký tự' });

        const exists = await q1('SELECT id FROM users WHERE username = ?', [username]);
        if (exists) return res.status(409).json({ message: 'Tên đăng nhập đã tồn tại' });

        if (email) {
            const emailTaken = await q1('SELECT id FROM users WHERE email = ?', [email]);
            if (emailTaken) return res.status(409).json({ message: 'Email đã được dùng bởi tài khoản khác' });
        }

        const hash = bcrypt.hashSync(password, 10);
        const result = await q(
            'INSERT INTO users (username, password, fullname, name, email, role) VALUES (?,?,?,?,?,?)', [username, hash, name, name, email, 'user']
        );
        const user = await q1('SELECT * FROM users WHERE id = ?', [result.insertId]);
        const token = jwt.sign({ id: user.id, username: user.username, role: user.role || 'user' },
            SECRET, { expiresIn: '30d' }
        );
        res.status(201).json({...safeUser(user), token });
    } catch (e) {
        console.error('[server]', e.message);
        res.status(500).json({ message: 'Lỗi server' });
    }
});

// ── FIX: Quên mật khẩu — bước 1: yêu cầu gửi email đặt lại mật khẩu ──
// Luôn trả về cùng 1 thông điệp thành công dù email có tồn tại hay không,
// để tránh lộ thông tin "email này có trong hệ thống hay không" (user
// enumeration) cho kẻ dò quét.
app.post('/api/forgot-password', async(req, res) => {
    const genericMsg = { message: 'Một liên kết đặt lại mật khẩu đã được gửi.' };
    try {
        const email = (req.body.email || '').trim();
        if (!email) return res.status(400).json({ message: 'Vui lòng nhập email' });

        const user = await q1('SELECT id, email FROM users WHERE email = ?', [email]);
        if (!user) return res.json(genericMsg); // không tiết lộ email không tồn tại

        // Token thô gửi cho user qua email; chỉ bản băm SHA-256 được lưu ở DB.
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 phút

        // Vô hiệu hoá các token cũ chưa dùng của user này trước khi tạo token mới.
        await q('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0', [user.id]);
        await q('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?,?,?)',
            [user.id, tokenHash, expiresAt]);

        const resetLink = `${APP_URL}/reset-password.html?token=${rawToken}`;
        try {
            await sendResetPasswordEmail(user.email, resetLink);
        } catch (mailErr) {
            // Không để lỗi gửi mail rò rỉ ra ngoài (vẫn trả thông điệp chung),
            // nhưng log lại để dev biết SMTP_USER/SMTP_PASS có vấn đề.
            console.error('[forgot-password] Gửi email thất bại:', mailErr.message);
        }
        res.json(genericMsg);
    } catch (e) {
        console.error('[server]', e.message);
        res.status(500).json({ message: 'Lỗi server' });
    }
});

// ── FIX: Quên mật khẩu — bước 2: xác nhận token + đặt mật khẩu mới ──
app.post('/api/reset-password', async(req, res) => {
    try {
        const { token, newPassword } = req.body;
        if (!token || !newPassword) return res.status(400).json({ message: 'Thiếu thông tin' });
        if (newPassword.length < 6) return res.status(400).json({ message: 'Mật khẩu mới tối thiểu 6 ký tự' });

        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const reset = await q1(
            `SELECT * FROM password_resets
             WHERE token_hash = ? AND used = 0 AND expires_at > NOW()
             ORDER BY id DESC LIMIT 1`, [tokenHash]
        );
        if (!reset) return res.status(400).json({ message: 'Liên kết không hợp lệ hoặc đã hết hạn' });

        const hash = bcrypt.hashSync(newPassword, 10);
        await q('UPDATE users SET password = ? WHERE id = ?', [hash, reset.user_id]);
        await q('UPDATE password_resets SET used = 1 WHERE id = ?', [reset.id]);

        res.json({ message: 'Đặt lại mật khẩu thành công, vui lòng đăng nhập lại' });
    } catch (e) {
        console.error('[server]', e.message);
        res.status(500).json({ message: 'Lỗi server' });
    }
});

// ── FIX: Đăng nhập bằng Google (Google Identity Services) ──
// Frontend dùng Google Sign-In để lấy `credential` (ID token JWT do Google
// ký) rồi gửi lên đây. Server xác thực chữ ký với Google (KHÔNG tự tin vào
// bất kỳ thông tin nào client tự khai) rồi mới tìm/tạo user tương ứng.
app.post('/api/auth/google', async(req, res) => {
    try {
        const { credential } = req.body;
        if (!credential) return res.status(400).json({ message: 'Thiếu thông tin đăng nhập Google' });

        let payload;
        try {
            const ticket = await googleClient.verifyIdToken({
                idToken: credential,
                audience: process.env.GOOGLE_CLIENT_ID,
            });
            payload = ticket.getPayload();
        } catch (verifyErr) {
            return res.status(401).json({ message: 'Token Google không hợp lệ' });
        }

        const { sub: googleId, email, name, picture } = payload;
        if (!email) return res.status(400).json({ message: 'Tài khoản Google không có email' });

        // Ưu tiên tìm theo google_id (ổn định lâu dài), nếu chưa có thì tìm
        // theo email để LIÊN KẾT với tài khoản thường (username/password) đã
        // tồn tại sẵn — tránh tạo ra 2 tài khoản trùng cho cùng 1 người.
        let user = await q1('SELECT * FROM users WHERE google_id = ?', [googleId]);
        if (!user) {
            user = await q1('SELECT * FROM users WHERE email = ?', [email]);
            if (user) {
                await q('UPDATE users SET google_id = ? WHERE id = ?', [googleId, user.id]);
            } else {
                // Tạo tài khoản mới — không có mật khẩu nội bộ (chỉ đăng nhập
                // qua Google). username tự sinh từ email để tránh trùng cột
                // username NOT NULL/UNIQUE sẵn có trong bảng users.
                let username = 'gg_' + email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40);
                if (await q1('SELECT id FROM users WHERE username = ?', [username])) {
                    username = username + '_' + googleId.slice(-6);
                }
                const result = await q(
                    `INSERT INTO users (username, password, fullname, name, email, avatar, google_id, role)
                     VALUES (?,NULL,?,?,?,?,?,?)`,
                    [username, name || email, name || email, email, picture || null, googleId, 'user']
                );
                user = await q1('SELECT * FROM users WHERE id = ?', [result.insertId]);
            }
        }

        const jwtToken = jwt.sign({ id: user.id, username: user.username, role: user.role || 'user' },
            SECRET, { expiresIn: '30d' }
        );
        res.json({...safeUser(user), token: jwtToken });
    } catch (e) {
        console.error('[server]', e.message);
        res.status(500).json({ message: 'Lỗi server' });
    }
});

// ════════════════════════════════════════
//  PROFILE  (bảng users)
//  Cột thực tế: fullname, email, birthday, gender, learning_goal, avatar
//               streak, words_learned, last_active_date
// ════════════════════════════════════════
app.get('/api/profile', auth, async(req, res) => {
    try {
        // FIX: Cập nhật last_active_date mỗi khi user xác thực phiên (login/refresh).
        // Điều này đảm bảo admin thấy đúng số user "active hôm nay",
        // không cần chờ user trigger streak sync.
        await q('UPDATE users SET last_active_date = NOW() WHERE id = ?', [req.user.id]);

        const user = await q1(
            `SELECT id, username, fullname, name, email, birthday, gender,
                    learning_goal, avatar, role, streak, words_learned, last_active_date,
                    progress_reset_at, google_id
             FROM users WHERE id = ?`, [req.user.id]
        );
        if (!user) return res.status(404).json({ message: 'Không tìm thấy người dùng' });
        res.json(safeUser(user));
    } catch (e) {
        console.error('[server]', e.message);
        res.status(500).json({ message: 'Lỗi server' });
    }
});

app.put('/api/profile', auth, async(req, res) => {
    try {
        const { name, email, birthday, gender, learning_goal, avatar } = req.body;
        if (email !== undefined) {
            const current = await q1('SELECT email, google_id FROM users WHERE id = ?', [req.user.id]);
            if (current && current.google_id && email !== current.email) {
                return res.status(403).json({ message: 'Email được quản lý bởi tài khoản Google, không thể chỉnh sửa tại đây' });
            }
        }
        // Kiểm tra email trùng
        if (email) {
            const dup = await q1('SELECT id FROM users WHERE email = ? AND id != ?', [email, req.user.id]);
            if (dup) return res.status(409).json({ message: 'Email đã được dùng bởi tài khoản khác' });
        }

        const fields = [],
            vals = [];
        // Cập nhật cả fullname lẫn name để tương thích
        if (name !== undefined) {
            fields.push('fullname = ?');
            vals.push(name);
            fields.push('name = ?');
            vals.push(name);
        }
        if (email !== undefined) {
            fields.push('email = ?');
            vals.push(email);
        }
        if (birthday !== undefined) {
            fields.push('birthday = ?');
            vals.push(birthday || null);
        }
        if (gender !== undefined) {
            fields.push('gender = ?');
            vals.push(gender);
        }
        if (learning_goal !== undefined) {
            fields.push('learning_goal = ?');
            vals.push(learning_goal);
        }
        if (avatar !== undefined) {
            fields.push('avatar = ?');
            vals.push(avatar);
        }

        if (!fields.length) return res.status(400).json({ message: 'Không có dữ liệu cập nhật' });

        vals.push(req.user.id);
        await q(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, vals);

        const updated = await q1(
            `SELECT id, username, fullname, name, email, birthday, gender,
                    learning_goal, avatar, role, streak, words_learned, last_active_date,
                    progress_reset_at, google_id
             FROM users WHERE id = ?`, [req.user.id]
        );
        res.json(safeUser(updated));
    } catch (e) {
        console.error('[server]', e.message);
        res.status(500).json({ message: 'Lỗi server' });
    }
});

app.put('/api/profile/password', auth, async(req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;
        if (!oldPassword || !newPassword) return res.status(400).json({ message: 'Thiếu thông tin' });
        if (newPassword.length < 6) return res.status(400).json({ message: 'Mật khẩu mới tối thiểu 6 ký tự' });

        const user = await q1('SELECT * FROM users WHERE id = ?', [req.user.id]);
        if (!bcrypt.compareSync(oldPassword, user.password))
            return res.status(401).json({ message: 'Mật khẩu hiện tại không đúng' });

        const hash = bcrypt.hashSync(newPassword, 10);
        await q('UPDATE users SET password = ? WHERE id = ?', [hash, req.user.id]);
        res.json({ message: 'Đổi mật khẩu thành công' });
    } catch (e) {
        console.error('[server]', e.message);
        res.status(500).json({ message: 'Lỗi server' });
    }
});

// ════════════════════════════════════════
//  PROGRESS — Cập nhật số từ đã học ngay lập tức (không cần qua streak sync)
//  Route này được gọi mỗi khi user đánh dấu một từ là "đã nhớ" trong flashcard.
//  Đảm bảo admin admin luôn thấy số từ đúng, không phải 0.
// ════════════════════════════════════════
app.post('/api/progress/words', auth, async(req, res) => {
    try {
        const { words_learned } = req.body;
        if (words_learned == null || isNaN(Number(words_learned))) {
            return res.status(400).json({ message: 'Thiếu words_learned' });
        }
        // Chỉ cập nhật nếu giá trị mới >= giá trị cũ (không bao giờ giảm số từ đã học)
        await q(
            'UPDATE users SET words_learned = GREATEST(words_learned, ?) WHERE id = ?', [Number(words_learned), req.user.id]
        );
        res.json({ ok: true });
    } catch (e) {
        console.error('[server]', e.message);
        res.status(500).json({ message: 'Lỗi server' });
    }
});

// ════════════════════════════════════════
//  STREAK SYNC
//  Ghi nhận ngày học và tính streak phía server.
//
//  Lưu ý quan trọng (đã từng là nguyên nhân gây bug "streak nhảy lên mỗi khi
//  học 1 từ"):
//  1) Dùng CURDATE() / DATE() của MySQL làm chuẩn duy nhất để xác định "hôm
//     nay", KHÔNG dùng new Date() của Node, để tránh lệch ngày do timezone
//     khác nhau giữa Node process và MySQL session.
//  2) Dùng transaction + "SELECT ... FOR UPDATE" để lock đúng dòng user này
//     lại trong lúc đọc-rồi-ghi. Nếu không lock, khi client gửi nhiều request
//     sync gần như đồng thời (vd: do nhiều tab, double-click, hoặc do code
//     cũ gọi recordStudyDay() 2 lần liên tiếp), các request có thể cùng đọc
//     được last_active_date "chưa cập nhật" và mỗi request đều tưởng "hôm
//     nay chưa học" rồi cùng +1 streak → streak tăng vọt trong 1 ngày.
// ════════════════════════════════════════
app.post('/api/streak/sync', auth, async(req, res) => {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.execute(
            `SELECT streak, words_learned,
                    DATE(last_active_date) AS last_active_date,
                    (DATE(last_active_date) = CURDATE()) AS is_today,
                    (DATE(last_active_date) = CURDATE() - INTERVAL 1 DAY) AS is_yesterday
             FROM users WHERE id = ? FOR UPDATE`, [req.user.id]
        );
        const user = rows[0];
        if (!user) {
            await conn.rollback();
            return res.status(404).json({ message: 'Không tìm thấy người dùng' });
        }

        const { words_learned: wl, local_streak } = req.body || {};
        const newWordsLearned = wl != null ? wl : user.words_learned;

        if (user.is_today) {
            // Đã ghi nhận hôm nay — cập nhật words_learned và xem có cần tăng streak không
            // (trường hợp client gửi local_streak cao hơn vì có dữ liệu lịch sử localStorage)
            const clientStreak = Number(local_streak) || 0;
            const finalStreak  = Math.max(user.streak || 0, clientStreak);
            await conn.execute(
                'UPDATE users SET streak = ?, words_learned = ? WHERE id = ?',
                [finalStreak, newWordsLearned, req.user.id]
            );
            await conn.commit();
            return res.json({ streak: finalStreak, words_learned: newWordsLearned });
        }

        let serverStreak;
        if (user.is_yesterday) {
            serverStreak = (user.streak || 0) + 1;
        } else {
            serverStreak = 1; // Ngắt quãng hoặc lần đầu
        }

        // Nếu client gửi local_streak hợp lý (≤ server+3 để chống gian lận đơn giản) thì dùng MAX
        const clientStreak = Number(local_streak) || 0;
        const newStreak    = (clientStreak > 0 && clientStreak <= serverStreak + 3)
            ? Math.max(serverStreak, clientStreak)
            : serverStreak;

        await conn.execute(
            'UPDATE users SET streak = ?, last_active_date = CURDATE(), words_learned = ? WHERE id = ?',
            [newStreak, newWordsLearned, req.user.id]
        );
        await conn.commit();
        res.json({ streak: newStreak, words_learned: newWordsLearned });
    } catch (e) {
        await conn.rollback().catch(() => {});
        console.error('[server]', e.message);
        res.status(500).json({ message: 'Lỗi server' });
    } finally {
        conn.release();
    }
});

// ════════════════════════════════════════
//  VOCABULARY  (bảng vocabulary)
//  Cột: id, word, pinyin, word_type, meaning,
//       example_sentence, example_pinyin, example_meaning, hsk_level
//
//  Frontend dùng: hanzi→word, difficulty→hsk_level, category→word_type,
//                 example→example_sentence
// ════════════════════════════════════════

// Map row từ DB → object frontend quen dùng
function mapWord(v) {
    if (!v) return null;
    return {
        id: v.id,
        hanzi: v.word,
        word: v.word,
        pinyin: v.pinyin || '',
        meaning: v.meaning || '',
        category: v.word_type || 'Khác',
        word_type: v.word_type || '',
        difficulty: v.hsk_level || 1,
        hsk_level: v.hsk_level || 1,
        example: v.example_sentence || '',
        example_sentence: v.example_sentence || '',
        example_pinyin: v.example_pinyin || '',
        example_meaning: v.example_meaning || '',
    };
}

app.get('/api/words', async(req, res) => {
    try {
        const rows = await q('SELECT * FROM vocabulary ORDER BY hsk_level, id');
        res.json(rows.map(mapWord));
    } catch (e) {
        console.error('[server]', e.message);
        res.status(500).json({ message: 'Lỗi server' });
    }
});

app.get('/api/words/all', auth, async(req, res) => {
    try {
        const rows = await q('SELECT * FROM vocabulary ORDER BY hsk_level, id');
        res.json(rows.map(mapWord));
    } catch (e) {
        console.error('[server]', e.message);
        res.status(500).json({ message: 'Lỗi server' });
    }
});

app.get('/api/words/:id', async(req, res) => {
    try {
        const row = await q1('SELECT * FROM vocabulary WHERE id = ?', [req.params.id]);
        if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
        res.json(mapWord(row));
    } catch (e) { res.status(500).json({ message: 'Lỗi server' }); }
});

app.post('/api/words', auth, adminOnly, async(req, res) => {
    try {
        const {
            hanzi,
            word,
            pinyin,
            meaning,
            category,
            word_type,
            difficulty,
            hsk_level,
            example,
            example_sentence,
            example_pinyin,
            example_meaning
        } = req.body;

        const _word = word || hanzi;
        const _type = word_type || category || '';
        const _level = hsk_level || difficulty || 1;
        const _example = example_sentence || example || '';

        if (!_word || !meaning)
            return res.status(400).json({ message: 'Thiếu từ hoặc nghĩa' });

        const result = await q(
            `INSERT INTO vocabulary
                (word, pinyin, word_type, meaning, example_sentence, example_pinyin, example_meaning, hsk_level)
             VALUES (?,?,?,?,?,?,?,?)`, [_word, pinyin || '', _type, meaning, _example, example_pinyin || '', example_meaning || '', _level]
        );
        const newRow = await q1('SELECT * FROM vocabulary WHERE id = ?', [result.insertId]);
        res.status(201).json(mapWord(newRow));
    } catch (e) {
        console.error('[server]', e.message);
        res.status(500).json({ message: 'Lỗi server' });
    }
});

app.put('/api/words/:id', auth, adminOnly, async(req, res) => {
    try {
        const {
            hanzi,
            word,
            pinyin,
            meaning,
            category,
            word_type,
            difficulty,
            hsk_level,
            example,
            example_sentence,
            example_pinyin,
            example_meaning
        } = req.body;

        const _word = word || hanzi;
        const _type = word_type || category || '';
        const _level = hsk_level || difficulty || 1;
        const _example = example_sentence || example || '';

        await q(
            `UPDATE vocabulary SET
                word=?, pinyin=?, word_type=?, meaning=?,
                example_sentence=?, example_pinyin=?, example_meaning=?, hsk_level=?
             WHERE id=?`, [_word, pinyin || '', _type, meaning, _example,
                example_pinyin || '', example_meaning || '', _level, req.params.id
            ]
        );
        const updated = await q1('SELECT * FROM vocabulary WHERE id = ?', [req.params.id]);
        res.json(mapWord(updated));
    } catch (e) {
        console.error('[server]', e.message);
        res.status(500).json({ message: 'Lỗi server' });
    }
});

app.delete('/api/words/:id', auth, adminOnly, async(req, res) => {
    try {
        await q('DELETE FROM vocabulary WHERE id = ?', [req.params.id]);
        res.json({ message: 'Đã xóa' });
    } catch (e) { res.status(500).json({ message: 'Lỗi server' }); }
});

// ════════════════════════════════════════
//  HELPER: Gọi Gemini API (dùng chung cho chat / recommend / quiz-gen)
// ════════════════════════════════════════
async function callGemini(promptText) {
    if (!process.env.GEMINI_API_KEY) return null;
    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: promptText }] }] })
        }
    );
    const data = await response.json();
    if (data.error) throw new Error(data.error.message || 'Gemini error');
    const parts = data?.candidates?.[0]?.content?.parts;
    return (parts && parts.length) ? parts[0].text : null;
}

// ════════════════════════════════════════
//  SPACED REPETITION (SM-2)
//  Bảng word_progress lưu trạng thái ôn tập theo thuật toán SuperMemo-2
//  cho từng cặp (user, từ vựng). Xem chi tiết thuật toán trong srs.js.
// ════════════════════════════════════════

// SRS Due: CHỈ trả về thẻ đã từng học (có trong word_progress) và đến hạn hôm nay.
// Từ mới được đưa vào SRS khi người dùng bấm "✓ Đã nhớ" trong Flashcard
// (gọi POST /api/srs/init nhiều từ cùng lúc) — không tự động lấy random từ DB nữa.
app.get('/api/srs/due', auth, async(req, res) => {
    try {
        const limit = Math.min(Number(req.query.limit) || 30, 100) | 0;

        const due = await q(
            `SELECT v.*, wp.stability, wp.difficulty, wp.fsrs_state,
                    wp.interval_days, wp.next_review_date, wp.total_reviews
             FROM word_progress wp
             JOIN vocabulary v ON v.id = wp.word_id
             WHERE wp.user_id = ? AND wp.next_review_date <= CURDATE()
             ORDER BY wp.fsrs_state ASC, wp.next_review_date ASC
             LIMIT ${limit}`, [req.user.id]
        );

        const newLimit = Math.max(0, Math.min(10, limit - due.length)) | 0;
        const fresh = newLimit > 0 ? await q(
            `SELECT v.* FROM vocabulary v
             LEFT JOIN word_progress wp ON wp.word_id = v.id AND wp.user_id = ?
             WHERE wp.id IS NULL
             ORDER BY v.hsk_level ASC, v.id ASC
             LIMIT ${newLimit}`, [req.user.id]
        ) : [];

        const cards = [
            ...due.map(mapWord),
            ...fresh.map(w => ({ ...mapWord(w), isNew: true })),
        ];

        res.json({ cards, dueCount: due.length, newCount: fresh.length });
    } catch (e) {
        console.error('[SRS /due]', e.message, e.stack?.split('\n')[1]);
        res.status(500).json({ message: 'Lỗi server SRS: ' + e.message });
    }
});

// FIX: Dashboard cần biết những từ nào đã được đưa vào hệ thống SRS (word_progress)
// để không hiển thị lại chúng trong danh sách "từ cần học hôm nay" — trước đây Dashboard
// chỉ dựa vào cờ "studied" trong localStorage, thứ không đồng bộ khi đổi trình duyệt/thiết bị
// hoặc khi từ được học trực tiếp qua "Ôn tập thông minh" thay vì qua Flashcard.
app.get('/api/srs/learned-ids', auth, async(req, res) => {
    try {
        const rows = await q('SELECT word_id FROM word_progress WHERE user_id = ?', [req.user.id]);
        res.json({ ids: rows.map(r => r.word_id) });
    } catch (e) {
        console.error('[SRS /learned-ids]', e.message);
        res.status(500).json({ message: 'Lỗi server' });
    }
});

// Khởi tạo nhiều từ vào SRS khi user bấm "✓ Đã nhớ" trong Flashcard.
// initial_rating: 1=Mới học(1 ngày) 2=Khá nhớ(3 ngày) 3=Nhớ tốt(7 ngày) 4=Nhớ chắc(15 ngày)
// Dùng INSERT IGNORE để không ghi đè thẻ đã có lịch sử ôn tập.
app.post('/api/srs/init', auth, async(req, res) => {
    const { word_ids, initial_rating = 1 } = req.body;
    if (!Array.isArray(word_ids) || !word_ids.length)
        return res.status(400).json({ message: 'word_ids phải là mảng' });

    try {
        // Tính stability ban đầu dựa trên rating người dùng chọn
        const { initStability, initDifficulty } = require('./srs');
        const rating   = Math.min(Math.max(Number(initial_rating), 1), 4);
        const stability   = initStability(rating);   // FSRS w[rating-1]
        const difficulty  = initDifficulty(rating);  // FSRS initial difficulty
        const intervalDays = Math.max(1, Math.round(stability));
        const fsrs_state   = 2; // Review (đã biết → vào hàng chờ review dài hạn)

        // FIX: .toISOString() trả về giờ UTC — với múi giờ VN (UTC+7), vào
        // buổi sáng sớm (0h–7h giờ VN) ngày UTC vẫn còn là NGÀY HÔM TRƯỚC, nên
        // dateStr bị lùi 1 ngày (giống hệt bug đã sửa trong srs.js). Dùng các
        // thành phần ngày giờ địa phương thay vì chuyển qua UTC.
        const next = new Date();
        next.setDate(next.getDate() + intervalDays);
        const dateStr = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;

        const placeholders = word_ids.map(() =>
            `(?,?,?,?,?,?,?,NOW(),0,0)`).join(',');
        const values = word_ids.flatMap(id =>
            [req.user.id, id, stability, difficulty, fsrs_state, intervalDays, dateStr]);

        await q(
            `INSERT IGNORE INTO word_progress
                (user_id, word_id, stability, difficulty, fsrs_state,
                 interval_days, next_review_date, last_reviewed_at, total_reviews, total_correct)
             VALUES ${placeholders}`,
            values
        );
        res.json({ ok: true, initialized: word_ids.length, interval_days: intervalDays, next_review_date: dateStr });
    } catch (e) {
        console.error('[SRS /init]', e.message);
        res.status(500).json({ message: 'Lỗi server' });
    }
});

// SRS Upcoming: các thẻ sẽ đến hạn trong 7 ngày tới
app.get('/api/srs/upcoming', auth, async(req, res) => {
    try {
        const rows = await q(
            `SELECT v.word AS hanzi, v.meaning, wp.next_review_date,
                    DATEDIFF(wp.next_review_date, CURDATE()) AS days_until
             FROM word_progress wp
             JOIN vocabulary v ON v.id = wp.word_id
             WHERE wp.user_id = ? AND wp.next_review_date > CURDATE()
             ORDER BY wp.next_review_date ASC
             LIMIT 20`, [req.user.id]
        );
        const total = await q1(
            `SELECT COUNT(*) AS cnt FROM word_progress WHERE user_id = ?`, [req.user.id]
        );
        res.json({ upcoming: rows, totalInSystem: total?.cnt || 0 });
    } catch (e) {
        console.error('[SRS /upcoming]', e.message);
        res.status(500).json({ message: 'Lỗi server' });
    }
});

// SRS Schedule 7 ngày: đếm số thẻ đến hạn theo từng ngày (hôm nay + 6 ngày tới),
// dùng cho card "Lịch ôn 7 ngày tới" ở màn hình Hoàn thành buổi ôn tập.
// CHỈ ĐỌC next_review_date đã được FSRS tính sẵn — không tính lại FSRS.
app.get('/api/srs/schedule-7d', auth, async(req, res) => {
    try {
        const rows = await q(
            `SELECT DATE_FORMAT(d.date_val, '%Y-%m-%d') AS date, COALESCE(cnt.c, 0) AS count
             FROM (
                 SELECT CURDATE() AS date_val
                 UNION ALL SELECT DATE_ADD(CURDATE(), INTERVAL 1 DAY)
                 UNION ALL SELECT DATE_ADD(CURDATE(), INTERVAL 2 DAY)
                 UNION ALL SELECT DATE_ADD(CURDATE(), INTERVAL 3 DAY)
                 UNION ALL SELECT DATE_ADD(CURDATE(), INTERVAL 4 DAY)
                 UNION ALL SELECT DATE_ADD(CURDATE(), INTERVAL 5 DAY)
                 UNION ALL SELECT DATE_ADD(CURDATE(), INTERVAL 6 DAY)
             ) d
             LEFT JOIN (
                 SELECT next_review_date, COUNT(*) AS c
                 FROM word_progress
                 WHERE user_id = ?
                 GROUP BY next_review_date
             ) cnt ON cnt.next_review_date = d.date_val
             ORDER BY d.date_val ASC`,
            [req.user.id]
        );
        res.json({ schedule: rows });
    } catch (e) {
        console.error('[SRS /schedule-7d]', e.message);
        res.status(500).json({ message: 'Lỗi server' });
    }
});

// rating: 1=Again 2=Hard 3=Good 4=Easy
app.post('/api/srs/review', auth, async(req, res) => {
    const { word_id, rating } = req.body;
    if (word_id == null || ![1, 2, 3, 4].includes(Number(rating))) {
        return res.status(400).json({ message: 'Thiếu word_id hoặc rating không hợp lệ (1-4)' });
    }
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.execute(
            `SELECT stability, difficulty, fsrs_state, interval_days, last_reviewed_at
             FROM word_progress WHERE user_id = ? AND word_id = ? FOR UPDATE`,
            [req.user.id, word_id]
        );
        const prev = rows[0] || { stability: null, difficulty: null, fsrs_state: 0, interval_days: 0 };

        // Tính elapsed_days từ last_reviewed_at
        if (prev.last_reviewed_at) {
            const ms = Date.now() - new Date(prev.last_reviewed_at).getTime();
            prev.elapsed_days = Math.max(0, Math.floor(ms / 86400000));
        } else {
            prev.elapsed_days = 0;
        }

        const next = computeNextState(prev, Number(rating));

        await conn.execute(
            `INSERT INTO word_progress
                (user_id, word_id, stability, difficulty, fsrs_state, interval_days,
                 next_review_date, last_quality, last_reviewed_at, elapsed_days, total_reviews, total_correct)
             VALUES (?,?,?,?,?,?,?,?,NOW(),?,1,?)
             ON DUPLICATE KEY UPDATE
                stability = VALUES(stability), difficulty = VALUES(difficulty),
                fsrs_state = VALUES(fsrs_state), interval_days = VALUES(interval_days),
                next_review_date = VALUES(next_review_date), last_quality = VALUES(last_quality),
                last_reviewed_at = NOW(), elapsed_days = VALUES(elapsed_days),
                total_reviews = total_reviews + 1, total_correct = total_correct + ?`,
            [req.user.id, word_id, next.stability, next.difficulty, next.fsrs_state,
             next.interval_days, next.next_review_date, rating, prev.elapsed_days,
             next.is_correct, next.is_correct]
        );

        const word = await q1('SELECT hsk_level, word_type FROM vocabulary WHERE id = ?', [word_id]);
        if (word) {
            await conn.execute(
                'INSERT INTO quiz_attempts (user_id, word_id, hsk_level, word_type, source, is_correct) VALUES (?,?,?,?,\'srs\',?)',
                [req.user.id, word_id, word.hsk_level, word.word_type, next.is_correct]
            );
        }

        await conn.commit();
        res.json({
            stability: next.stability,
            difficulty: next.difficulty,
            fsrs_state: next.fsrs_state,
            interval_days: next.interval_days,
            next_review_date: next.next_review_date,
        });
    } catch (e) {
        await conn.rollback().catch(() => {});
        console.error('[server]', e.message);
        res.status(500).json({ message: 'Lỗi server' });
    } finally {
        conn.release();
    }
});

// Thống kê SRS tổng quan: số thẻ đến hạn, số từ đã đưa vào hệ thống ôn tập,
// tỉ lệ nhớ (retention rate) = total_correct / total_reviews.
app.get('/api/srs/stats', auth, async(req, res) => {
    try {
        const stats = await q1(
            `SELECT
                COUNT(*) AS cards_in_system,
                SUM(CASE WHEN next_review_date <= CURDATE() THEN 1 ELSE 0 END) AS due_today,
                COALESCE(SUM(total_reviews),0) AS total_reviews,
                COALESCE(SUM(total_correct),0) AS total_correct
             FROM word_progress WHERE user_id = ?`, [req.user.id]
        );
        const retention = stats.total_reviews > 0 ?
            Math.round((stats.total_correct / stats.total_reviews) * 100) : null;
        res.json({...stats, retention });
    } catch (e) {
        console.error('[server]', e.message);
        res.status(500).json({ message: 'Lỗi server' });
    }
});

// ════════════════════════════════════════
//  LOG KẾT QUẢ QUIZ (cho phân tích điểm yếu)
// ════════════════════════════════════════
app.post('/api/quiz/attempt', auth, async(req, res) => {
    try {
        const { word_id, is_correct } = req.body;
        if (word_id == null || is_correct == null) {
            return res.status(400).json({ message: 'Thiếu word_id hoặc is_correct' });
        }
        const word = await q1('SELECT hsk_level, word_type FROM vocabulary WHERE id = ?', [word_id]);
        await q(
            'INSERT INTO quiz_attempts (user_id, word_id, hsk_level, word_type, source, is_correct) VALUES (?,?,?,?,\'quiz\',?)',
            [req.user.id, word_id, word?.hsk_level || null, word?.word_type || null, is_correct ? 1 : 0]
        );
        res.json({ ok: true });
    } catch (e) {
        console.error('[server]', e.message);
        res.status(500).json({ message: 'Lỗi server' });
    }
});

app.post('/api/quiz/session', auth, async (req, res) => {
    try {
        const { source, hsk_level, score, total } = req.body;
        await pool.execute(
            'INSERT INTO quiz_sessions (user_id, source, hsk_level, score, total) VALUES (?,?,?,?,?)',
            [req.user.id, source === 'exam' ? 'exam' : 'quiz', hsk_level || null, score, total]
        );
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'server_error' }); }
});

app.get('/api/quiz/sessions', auth, async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT source, hsk_level, score, total, created_at FROM quiz_sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 100',
            [req.user.id]
        );
        res.json({ sessions: rows });
    } catch (e) { res.status(500).json({ error: 'server_error' }); }
});
// ════════════════════════════════════════
//  LEARNING ANALYTICS — điểm yếu theo loại từ (word_type) và theo cấp HSK
// ════════════════════════════════════════
app.get('/api/analytics/weak-topics', auth, async(req, res) => {
    try {
        const byType = await q(
            `SELECT word_type, COUNT(*) AS attempts, SUM(is_correct) AS correct,
                    ROUND(SUM(is_correct) / COUNT(*) * 100) AS accuracy
             FROM quiz_attempts
             WHERE user_id = ? AND word_type IS NOT NULL AND word_type <> ''
             GROUP BY word_type
             HAVING attempts >= 3
             ORDER BY accuracy ASC
             LIMIT 5`, [req.user.id]
        );

        const byLevel = await q(
            `SELECT hsk_level, COUNT(*) AS attempts, SUM(is_correct) AS correct,
                    ROUND(SUM(is_correct) / COUNT(*) * 100) AS accuracy
             FROM quiz_attempts
             WHERE user_id = ? AND hsk_level IS NOT NULL
             GROUP BY hsk_level
             ORDER BY hsk_level ASC`, [req.user.id]
        );

        // Độ phủ theo cấp HSK: đã đưa vào ôn tập (word_progress) bao nhiêu % so với tổng từ của cấp đó
        const coverage = await q(
            `SELECT v.hsk_level,
                    COUNT(DISTINCT v.id) AS total_words,
                    COUNT(DISTINCT wp.word_id) AS studied_words
             FROM vocabulary v
             LEFT JOIN word_progress wp ON wp.word_id = v.id AND wp.user_id = ?
             GROUP BY v.hsk_level
             ORDER BY v.hsk_level ASC`, [req.user.id]
        );

        res.json({ weakWordTypes: byType, accuracyByLevel: byLevel, levelCoverage: coverage });
    } catch (e) {
        console.error('[server]', e.message);
        res.status(500).json({ message: 'Lỗi server' });
    }
});

// ════════════════════════════════════════
//  AI RECOMMENDATION — đề xuất lộ trình học cá nhân hoá
//  Luồng xử lý: thu thập dữ liệu học tập (mastery theo cấp HSK, điểm yếu
//  theo loại từ) → dựng prompt có cấu trúc → gọi Gemini → cache theo
//  user + ngày (dữ liệu học không đổi nhiều trong 1 ngày nên không cần
//  gọi AI lại mỗi lần mở dashboard) → trả về JSON cho frontend.
// ════════════════════════════════════════
app.get('/api/recommend', auth, async(req, res) => {
    try {
        const coverage = await q(
            `SELECT v.hsk_level,
                    COUNT(DISTINCT v.id) AS total_words,
                    COUNT(DISTINCT wp.word_id) AS studied_words
             FROM vocabulary v
             LEFT JOIN word_progress wp ON wp.word_id = v.id AND wp.user_id = ?
             GROUP BY v.hsk_level ORDER BY v.hsk_level ASC`, [req.user.id]
        );
        const weakTypes = await q(
            `SELECT word_type, ROUND(SUM(is_correct)/COUNT(*)*100) AS accuracy, COUNT(*) AS attempts
             FROM quiz_attempts
             WHERE user_id = ? AND word_type IS NOT NULL AND word_type <> ''
             GROUP BY word_type HAVING attempts >= 3
             ORDER BY accuracy ASC LIMIT 3`, [req.user.id]
        );

        const levelMastery = coverage.map(c => ({
            hsk_level: c.hsk_level,
            total_words: c.total_words,
            studied_words: c.studied_words,
            mastery_pct: c.total_words ? Math.round((c.studied_words / c.total_words) * 100) : 0
        }));

        // Không đủ dữ liệu (user mới) → trả gợi ý mặc định, không tốn lượt gọi Gemini
        const hasEnoughData = levelMastery.some(l => l.studied_words > 0);
        if (!hasEnoughData) {
            return res.json({
                levelMastery,
                weakTopics: weakTypes,
                recommendation: 'Bạn vừa mới bắt đầu! Hãy học khoảng 15-20 thẻ ở HSK 1 hôm nay để hệ thống có đủ dữ liệu đưa ra gợi ý cá nhân hoá cho bạn.',
                cached: false
            });
        }

        // ── AI Cache: 1 bản ghi nhớ / user / ngày ──
        // FIX: .toISOString() dùng giờ UTC — vào buổi sáng sớm giờ VN (0h-7h),
        // ngày UTC vẫn là hôm qua, khiến cache "theo ngày" bị lệch múi giờ.
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const cachePayload = { userId: req.user.id, date: today, levelMastery, weakTypes };
        const cacheRes = await aiCache.getCached(pool, 'recommend', cachePayload);
        if (cacheRes.hit) {
            return res.json({ levelMastery, weakTopics: weakTypes, recommendation: cacheRes.response, cached: true });
        }

        const masteryText = levelMastery
            .map(l => `HSK${l.hsk_level}: ${l.mastery_pct}% (${l.studied_words}/${l.total_words} từ)`)
            .join(', ');
        const weakText = weakTypes.length ?
            weakTypes.map(w => `${w.word_type} (đúng ${w.accuracy}%)`).join(', ') :
            'chưa có đủ dữ liệu sai/đúng theo loại từ';

        const prompt = `Bạn là trợ lý học tiếng Trung. Dựa trên dữ liệu học tập sau của một học viên, hãy đưa ra ĐÚNG 2-3 câu gợi ý ngắn gọn, cụ thể, bằng tiếng Việt, về việc nên học gì tiếp theo. Không chào hỏi, không giải thích dài dòng, đi thẳng vào gợi ý.

Mức độ thành thạo theo cấp HSK: ${masteryText}
Loại từ vựng hay sai nhất: ${weakText}

Yêu cầu: nêu rõ nên tập trung cấp HSK nào tiếp theo và nên luyện thêm loại từ nào.`;

        let recommendation;
        try {
            recommendation = await callGemini(prompt);
        } catch (e) {
            console.error('Gemini recommend error:', e.message);
        }
        if (!recommendation) {
            // Fallback rule-based nếu Gemini lỗi/không có key — vẫn đảm bảo tính năng hoạt động
            const weakestLevel = [...levelMastery].sort((a, b) => a.mastery_pct - b.mastery_pct)[0];
            recommendation = `Bạn nên tập trung học thêm HSK${weakestLevel.hsk_level} (mới đạt ${weakestLevel.mastery_pct}%).` +
                (weakTypes.length ? ` Ngoài ra nên luyện thêm loại từ "${weakTypes[0].word_type}" vì độ chính xác hiện chỉ ${weakTypes[0].accuracy}%.` : '');
        } else if (cacheRes.key) {
            await aiCache.setCached(pool, cacheRes.key, 'recommend', recommendation);
        }

        res.json({ levelMastery, weakTopics: weakTypes, recommendation, cached: false });
    } catch (e) {
        console.error('[server]', e.message);
        res.status(500).json({ message: 'Lỗi server' });
    }
});

// ════════════════════════════════════════
//  CHAT  (có AI Cache để giảm số lần gọi Gemini cho câu hỏi trùng lặp)
// ════════════════════════════════════════
app.post('/api/chat', auth, async(req, res) => {
    try {
        const { message, system } = req.body;

        if (!message) {
            return res.status(400).json({
                message: "Thiếu nội dung"
            });
        }

        if (!process.env.GEMINI_API_KEY) {
            return res.json({ reply: "Gemini API chưa được cấu hình." });
        }

        // Tra cache trước khi gọi Gemini (khoá = system prompt + nội dung hỏi,
        // không gắn user_id vì câu hỏi tra từ/ngữ pháp không phụ thuộc người hỏi)
        const cacheRes = await aiCache.getCached(pool, 'chat', { system: system || '', message });
        if (cacheRes.hit) {
            return res.json({ reply: cacheRes.response, cached: true });
        }

        const promptText = `${system || "Bạn là gia sư tiếng Trung."}

Người dùng:
${message}`;

        let reply;
        try {
            reply = await callGemini(promptText);
        } catch (err) {
            console.error('[chat]', err.message);
            return res.status(500).json({ message: err.message });
        }
        reply = reply || "Không có phản hồi.";

        if (cacheRes.key) await aiCache.setCached(pool, cacheRes.key, 'chat', reply);
        res.json({ reply, cached: false });

    } catch (err) {
        console.error('[chat outer]', err.message);
        res.status(500).json({ message: err.message });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Gemini API: ${process.env.GEMINI_API_KEY ? 'OK' : 'Missing key'}`);
});

module.exports = app;