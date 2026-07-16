// ==============================================
// admin-routes.js — Admin API routes
// Them vao server.js: const adminRoutes = require('./admin-routes');
//                     app.use('/api/admin', adminRoutes);
// ==============================================

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('./db');

const SECRET = process.env.JWT_SECRET || 'hsk_secret_2024';

// ==============================================
// MIDDLEWARE: kiem tra quyen admin
// Xac thuc bang JWT token (Bearer), khong tin header tu client gui truc tiep
// vi header x-admin-id/x-admin-role co the bi gia mao boi bat ky ai.
// ==============================================
function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ message: 'Can dang nhap' });
  }

  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch {
    return res.status(401).json({ message: 'Token khong hop le' });
  }

  if (payload.role !== 'admin') {
    return res.status(403).json({ message: 'Khong co quyen truy cap' });
  }

  // Verify admin thuc su ton tai trong DB (phong truong hop role doi sau khi token duoc cap)
  db.query('SELECT id, role FROM users WHERE id = ? AND role = ?', [payload.id, 'admin'], (err, rows) => {
    if (err || !rows || rows.length === 0) {
      return res.status(403).json({ message: 'Tai khoan admin khong hop le' });
    }
    req.adminUser = rows[0];
    next();
  });
}

// ==============================================
// GET /api/admin/stats
// ==============================================
router.get('/stats', requireAdmin, (req, res) => {
  // FIX: Dùng CURDATE() của MySQL thay vì new Date() của Node.js để tránh lệch timezone.
  // Node.js trả về UTC còn MySQL có thể dùng timezone local (Asia/Ho_Chi_Minh = UTC+7).
  // Dùng CURDATE() của chính MySQL đảm bảo tính đúng "hôm nay" theo timezone server DB.

  db.query('SELECT COUNT(*) AS total FROM users', (err, r1) => {
    if (err) return res.status(500).json({ message: 'Loi DB' });

    db.query('SELECT COUNT(*) AS total FROM vocabulary', (err, r2) => {
      if (err) return res.status(500).json({ message: 'Loi DB' });

      // Active today: dùng CURDATE() của MySQL, không dùng new Date() của Node
      db.query(
        "SELECT COUNT(*) AS total FROM users WHERE DATE(last_active_date) = CURDATE()",
        [],
        (err, r3) => {
          if (err) return res.status(500).json({ message: 'Loi DB' });

          // Tong so tu da hoc (sum progress counts)
          db.query('SELECT SUM(words_learned) AS total FROM users', (err, r4) => {
            if (err) return res.status(500).json({ message: 'Loi DB' });

            // Recent users
            db.query(
              'SELECT id, COALESCE(fullname, name, username) AS name, username, email, role, streak, words_learned, created_at FROM users ORDER BY created_at DESC LIMIT 6',
              (err, recentUsers) => {
                if (err) return res.status(500).json({ message: 'Loi DB' });

                // Vocab by level
                db.query(
                  'SELECT hsk_level AS level, COUNT(*) AS count FROM vocabulary GROUP BY hsk_level ORDER BY hsk_level',
                  (err, vocabByLevel) => {
                    if (err) return res.status(500).json({ message: 'Loi DB' });

                    res.json({
                      totalUsers:   r1[0].total,
                      totalVocab:   r2[0].total,
                      activeToday:  r3[0].total,
                      totalLearned: r4[0].total || 0,
                      recentUsers,
                      vocabByLevel
                    });
                  }
                );
              }
            );
          });
        }
      );
    });
  });
});

// ==============================================
// GET /api/admin/users
// Trả về danh sách user kèm tổng số từ vựng hiện có trong hệ thống,
// để admin có thể hiển thị "đã học X / tổng Y từ" cho mỗi user.
// ==============================================
router.get('/users', requireAdmin, (req, res) => {
  db.query(
    'SELECT id, COALESCE(fullname, name, username) AS name, username, email, role, streak, words_learned, created_at, last_active_date FROM users ORDER BY id DESC',
    (err, rows) => {
      if (err) return res.status(500).json({ message: 'Loi DB' });
      db.query('SELECT COUNT(*) AS total FROM vocabulary', (err2, r2) => {
        if (err2) return res.status(500).json({ message: 'Loi DB' });
        const totalWords = r2[0]?.total || 0;
        res.json({ users: rows, totalWords });
      });
    }
  );
});

// ==============================================
// PUT /api/admin/users/:id  — doi role hoac reset progress
// ==============================================
router.put('/users/:id', requireAdmin, async (req, res) => {
  const userId = parseInt(req.params.id);
  const { role, reset_progress } = req.body;

  if (reset_progress) {
    try {
      // Xoa toan bo trang thai SRS/FSRS (moi the tro thanh "chua hoc")
      await db.promise().query('DELETE FROM word_progress WHERE user_id = ?', [userId]);
      // Xoa lich su lam bai (quiz + flashcard review) de thong ke "tu sai nhieu nhat" cung sach
      await db.promise().query('DELETE FROM quiz_attempts WHERE user_id = ?', [userId]);
      // Reset cac cot tong hop tren bang users + danh dau thoi diem reset
      await db.promise().query(
        'UPDATE users SET words_learned = 0, streak = 0, last_active_date = NULL, progress_reset_at = NOW() WHERE id = ?',
        [userId]
      );
      res.json({ success: true, message: 'Da reset toan bo tien do hoc (bao gom FSRS/SRS)' });
    } catch (e) {
      res.status(500).json({ message: 'Loi reset: ' + e.message });
    }
    return;
  }

  if (role && ['admin', 'user'].includes(role)) {
    if (userId === req.adminUser.id && role !== 'admin') {
      return res.status(400).json({ message: 'Khong the tu ha quyen chinh minh' });
    }
    db.query(
      'UPDATE users SET role = ? WHERE id = ?',
      [role, userId],
      (err) => {
        if (err) return res.status(500).json({ message: 'Loi cap nhat role' });
        res.json({ success: true, message: 'Da doi role' });
      }
    );
    return;
  }

  res.status(400).json({ message: 'Thieu thong tin cap nhat' });
});

// ==============================================
// DELETE /api/admin/users/:id
// ==============================================
router.delete('/users/:id', requireAdmin, async (req, res) => {
  const userId = parseInt(req.params.id);

  if (userId === req.adminUser.id) {
    return res.status(400).json({ message: 'Khong the tu xoa chinh minh' });
  }

  try {
    // Xoa du lieu lien quan truoc (khong co FK CASCADE tren cac bang nay,
    // neu khong xoa thu cong se de lai rows "mo coi" lam sai lech thong ke admin)
    await db.promise().query('DELETE FROM word_progress WHERE user_id = ?', [userId]);
    await db.promise().query('DELETE FROM quiz_attempts WHERE user_id = ?', [userId]);
    await db.promise().query('DELETE FROM users WHERE id = ?', [userId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ message: 'Loi xoa user: ' + e.message });
  }
});

// ==============================================
// GET /api/admin/analytics — biểu đồ user hoạt động 30 ngày, top learners, retention
// ==============================================
router.get('/analytics', requireAdmin, async (req, res) => {
    try {
        // User hoạt động theo ngày (30 ngày gần nhất)
        const [dailyActive] = await db.promise().query(`
            SELECT DATE_FORMAT(last_active_date, '%Y-%m-%d') AS day, COUNT(*) AS count
            FROM users
            WHERE last_active_date >= CURDATE() - INTERVAL 30 DAY
            GROUP BY DATE_FORMAT(last_active_date, '%Y-%m-%d') 
            ORDER BY day ASC`);

        // Top 10 user học nhiều nhất
        const [topLearners] = await db.promise().query(`
            SELECT COALESCE(fullname, name, username) AS name, username,
                   words_learned, streak, last_active_date
            FROM users ORDER BY words_learned DESC LIMIT 10`);

        // Từ bị sai nhiều nhất (top 10)
        const [mostMissed] = await db.promise().query(`
            SELECT v.word AS hanzi, v.pinyin, v.meaning, v.hsk_level,
                   COUNT(*) AS attempts,
                   SUM(CASE WHEN qa.is_correct=0 THEN 1 ELSE 0 END) AS wrong_count,
                   ROUND(SUM(CASE WHEN qa.is_correct=0 THEN 1 ELSE 0 END)/COUNT(*)*100) AS error_rate
            FROM quiz_attempts qa
            JOIN vocabulary v ON v.id = qa.word_id
            GROUP BY v.id, v.word, v.pinyin, v.meaning, v.hsk_level
            HAVING attempts >= 5
            ORDER BY error_rate DESC, attempts DESC
            LIMIT 10`);

        // Tỉ lệ ghi nhớ trung bình toàn hệ thống
        const [[retentionRow]] = await db.promise().query(`
            SELECT COALESCE(ROUND(SUM(total_correct)/NULLIF(SUM(total_reviews),0)*100), 0) AS avg_retention,
                   COUNT(DISTINCT user_id) AS users_using_srs,
                   COALESCE(SUM(total_reviews),0) AS total_reviews
            FROM word_progress`);

        // AI cache stats
        const [[cacheRow]] = await db.promise().query(`
            SELECT COUNT(*) AS total_cached,
                   COALESCE(SUM(hit_count),0) AS total_hits
            FROM ai_cache`);

        // Đăng ký theo ngày (30 ngày)
        const [registrations] = await db.promise().query(`
            SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day, COUNT(*) AS count
            FROM users
            WHERE created_at >= NOW() - INTERVAL 30 DAY
            GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d') 
            ORDER BY day ASC`);

        res.json({ dailyActive, topLearners, mostMissed, retention: retentionRow, cache: cacheRow, registrations });
    } catch (e) {
        console.error('[admin/analytics]', e.message);
        res.status(500).json({ message: 'Lỗi server: ' + e.message });
    }
});

// ==============================================
// GET /api/admin/users/:id/detail
// ==============================================
router.get('/users/:id/detail', requireAdmin, async (req, res) => {
    try {
        const uid = parseInt(req.params.id);
        const [[user]] = await db.promise().query(
            `SELECT id, COALESCE(fullname,name,username) AS name, username, email,
                    role, streak, words_learned, created_at, last_active_date
             FROM users WHERE id = ?`, [uid]);
        if (!user) return res.status(404).json({ message: 'Không tìm thấy user' });

        const [quizHistory] = await db.promise().query(`
            SELECT v.word AS hanzi, v.meaning, qa.is_correct, qa.source, qa.created_at
            FROM quiz_attempts qa JOIN vocabulary v ON v.id = qa.word_id
            WHERE qa.user_id = ? ORDER BY qa.created_at DESC LIMIT 20`, [uid]);

        const [[srsStats]] = await db.promise().query(`
            SELECT COUNT(*) AS cards_in_srs,
                   ROUND(SUM(total_correct)/NULLIF(SUM(total_reviews),0)*100) AS retention,
                   SUM(CASE WHEN next_review_date <= CURDATE() THEN 1 ELSE 0 END) AS due_today
            FROM word_progress WHERE user_id = ?`, [uid]);

        const [byLevel] = await db.promise().query(`
            SELECT hsk_level, COUNT(*) AS attempts,
                   ROUND(SUM(is_correct)/COUNT(*)*100) AS accuracy
            FROM quiz_attempts WHERE user_id = ? AND hsk_level IS NOT NULL
            GROUP BY hsk_level ORDER BY hsk_level`, [uid]);

        res.json({ user, quizHistory, srsStats, byLevel });
    } catch (e) {
        console.error('[admin/user/detail]', e.message);
        res.status(500).json({ message: 'Lỗi server' });
    }
});

// ==============================================
// GET /api/admin/ai-cache
// ==============================================
router.get('/ai-cache', requireAdmin, async (req, res) => {
    try {
        const [rows] = await db.promise().query(`
            SELECT id, kind, LEFT(cache_key,16) AS key_preview,
                   LEFT(response,120) AS response_preview,
                   hit_count, created_at
            FROM ai_cache ORDER BY hit_count DESC LIMIT 50`);
        const [[stats]] = await db.promise().query(
            `SELECT COUNT(*) AS total, COALESCE(SUM(hit_count),0) AS total_hits FROM ai_cache`);
        res.json({ rows, stats });
    } catch (e) { res.status(500).json({ message: 'Lỗi server' }); }
});

router.delete('/ai-cache/:id', requireAdmin, async (req, res) => {
    try {
        await db.promise().query('DELETE FROM ai_cache WHERE id = ?', [req.params.id]);
        res.json({ ok: true });
    } catch { res.status(500).json({ message: 'Lỗi server' }); }
});

router.delete('/ai-cache', requireAdmin, async (req, res) => {
    try {
        await db.promise().query('TRUNCATE TABLE ai_cache');
        res.json({ ok: true });
    } catch { res.status(500).json({ message: 'Lỗi server' }); }
});

// ==============================================
// GET /api/admin/vocab/export — xuất CSV
// ==============================================
router.get('/vocab/export', requireAdmin, async (req, res) => {
    try {
        const [rows] = await db.promise().query(
            `SELECT word AS hanzi, pinyin, meaning, word_type, hsk_level,
                    example_sentence, example_pinyin, example_meaning
             FROM vocabulary ORDER BY hsk_level, id`);
        const esc = v => `"${String(v ?? '').replace(/"/g,'""')}"`;
        const header = 'hanzi,pinyin,meaning,word_type,hsk_level,example,example_pinyin,example_meaning';
        const csv = [header, ...rows.map(r =>
            [r.hanzi,r.pinyin,r.meaning,r.word_type,r.hsk_level,
             r.example_sentence,r.example_pinyin,r.example_meaning].map(esc).join(',')
        )].join('\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="hsk_vocabulary.csv"');
        res.send('\uFEFF' + csv);
    } catch (e) { res.status(500).json({ message: 'Lỗi xuất CSV' }); }
});

// POST /api/admin/vocab/import — nhập CSV
router.post('/vocab/import', requireAdmin, async (req, res) => {
    try {
        const { rows } = req.body;
        if (!Array.isArray(rows) || !rows.length)
            return res.status(400).json({ message: 'Không có dữ liệu' });
        let inserted = 0, skipped = 0;
        for (const r of rows) {
            if (!r.hanzi || !r.meaning) { skipped++; continue; }
            try {
                await db.promise().query(
                    `INSERT IGNORE INTO vocabulary
                        (word, pinyin, meaning, word_type, hsk_level, example_sentence, example_pinyin, example_meaning)
                     VALUES (?,?,?,?,?,?,?,?)`,
                    [r.hanzi, r.pinyin||'', r.meaning, r.word_type||'', parseInt(r.hsk_level)||1,
                     r.example||'', r.example_pinyin||'', r.example_meaning||'']);
                inserted++;
            } catch { skipped++; }
        }
        res.json({ ok: true, inserted, skipped });
    } catch (e) {
        console.error('[vocab/import]', e.message);
        res.status(500).json({ message: 'Lỗi import' });
    }
});

// POST /api/admin/vocab/bulk-delete
router.post('/vocab/bulk-delete', requireAdmin, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || !ids.length)
            return res.status(400).json({ message: 'Không có id' });
        const ph = ids.map(()=>'?').join(',');
        const [result] = await db.promise().query(`DELETE FROM vocabulary WHERE id IN (${ph})`, ids);
        res.json({ ok: true, deleted: result.affectedRows });
    } catch (e) { res.status(500).json({ message: 'Lỗi xóa' }); }
});


module.exports = router;
