// backend/ai-cache.js
// ════════════════════════════════════════════════════════════════
//  AI Response Cache — giảm số lần gọi Gemini API cho nội dung trùng lặp.
//
//  Ý tưởng: nhiều người dùng thường hỏi cùng một câu phổ biến
//  ("你好 nghĩa là gì", "giải thích 把 字句"...). Thay vì gọi Gemini
//  mỗi lần, ta băm (SHA-256) nội dung yêu cầu thành 1 khóa, tra trong
//  bảng ai_cache trước. Nếu có → trả ngay (tiết kiệm thời gian + quota
//  API). Nếu chưa có → gọi Gemini rồi lưu lại cho lần sau.
//
//  Lưu ý: chỉ cache những nội dung KHÔNG phụ thuộc vào lịch sử hội
//  thoại / dữ liệu cá nhân tại thời điểm hỏi (ví dụ: tra nghĩa từ,
//  giải thích ngữ pháp) để tránh trả lời sai ngữ cảnh.
// ════════════════════════════════════════════════════════════════
const crypto = require('crypto');

function makeCacheKey(kind, payload) {
    const raw = `${kind}::${JSON.stringify(payload)}`;
    return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

async function getCached(q, kind, payload) {
    const key = makeCacheKey(kind, payload);
    const [rows] = await q.execute(
        'SELECT id, response FROM ai_cache WHERE cache_key = ?', [key]
    );
    if (rows.length) {
        // Tăng hit_count để theo dõi hiệu quả cache (phục vụ chương đánh giá trong báo cáo)
        q.execute('UPDATE ai_cache SET hit_count = hit_count + 1 WHERE id = ?', [rows[0].id]).catch(() => {});
        return { hit: true, response: rows[0].response };
    }
    return { hit: false, key };
}

async function setCached(q, key, kind, response) {
    try {
        await q.execute(
            'INSERT INTO ai_cache (cache_key, kind, response) VALUES (?,?,?) ON DUPLICATE KEY UPDATE response = VALUES(response)',
            [key, kind, response]
        );
    } catch (e) {
        console.error('ai_cache save error:', e.message);
    }
}

module.exports = { makeCacheKey, getCached, setCached };
