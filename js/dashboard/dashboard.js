// dashboard/dashboard.js
import { getStudied, getStreak, getStudyDays, getMergedQuizHistory, loadStreakFromServer, localDateStr } from '../storage/storage.js';
import { getToken } from '../auth/auth.js';

let _words = [];
let _srsLearnedIds = new Set();
let _initialized = false;

export async function initDashboard() {
    await loadWords();
    await loadStreakFromServer();
    await loadSRSLearnedIds();
    await renderStats();
    renderTodayWords();
    renderWeekProgress();
    // Tải song song dữ liệu SRS + gợi ý AI (không chặn render chính)
    loadSRSStats();
    loadRecommendation();
    _initialized = true;
}

// FIX: "Từ cần học hôm nay" trước đây chỉ dựa vào cờ "studied" lưu trong
// localStorage của trình duyệt — cờ này KHÔNG đồng bộ khi người dùng học từ
// trực tiếp qua "Ôn tập thông minh" (SRS) thay vì bấm "✓ Đã nhớ" ở Flashcard,
// và cũng mất nếu đổi trình duyệt/thiết bị. Kết quả là dù đã học/ôn xong hết
// qua FSRS, Dashboard vẫn hiển thị y nguyên danh sách từ cần học như cũ.
// Giờ lấy thêm danh sách từ đã đưa vào hệ thống SRS từ server để đối chiếu.
async function loadSRSLearnedIds() {
    try {
        const res = await fetch(`${window.API}/api/srs/learned-ids`, {
            headers: { Authorization: `Bearer ${getToken()}` }
        });
        if (res.ok) {
            const data = await res.json();
            _srsLearnedIds = new Set((data.ids || []).map(String));
        }
    } catch { /* giữ nguyên Set rỗng, fallback về studied cục bộ */ }
}

async function loadWords() {
    try {
        const res = await fetch(`${window.API}/api/words`, {
            headers: { 'Authorization': `Bearer ${getToken()}` }
        });
        if (res.ok) _words = await res.json();
    } catch {
        _words = getFallbackWords();
    }
    window._allWords = _words; // share across modules
}

async function renderStats() {
    const studied   = getStudied();
    const quizHist  = await getMergedQuizHistory();
    const streak    = getStreak();
    const accuracy  = quizHist.length
        ? Math.round(quizHist.reduce((a,b) => a + b.score/b.total, 0) / quizHist.length * 100)
        : 0;

    // FIX: "Đã học" trước đây chỉ đếm studied.size — cờ lưu 100% trong
    // localStorage của trình duyệt, giống hệt lỗi đã sửa ở renderTodayWords()/
    // "Từ cần học hôm nay" nhưng KHÔNG được áp dụng ở đây. Kết quả: nếu người
    // dùng học/ôn trực tiếp qua "Ôn tập thông minh" (SRS) hoặc đổi trình duyệt/
    // thiết bị/chế độ ẩn danh, localStorage rỗng hoặc thiếu → "Đã học" hiển thị
    // số rất thấp dù thực tế đã có nhiều từ trong hệ thống SRS phía server.
    // Hợp nhất với _srsLearnedIds (nguồn sự thật từ server, đã tải ở initDashboard)
    // để ra con số chính xác, đồng bộ mọi thiết bị.
    const learnedCount = new Set([...studied, ..._srsLearnedIds]).size;

    document.getElementById('stat-total').textContent   = _words.length;
    document.getElementById('stat-learned').textContent = learnedCount;
    document.getElementById('stat-streak').textContent  = streak;
    document.getElementById('stat-accuracy').textContent= accuracy + '%';
}

// Lấy số thẻ SM-2 cần ôn hôm nay và tỉ lệ ghi nhớ từ server
async function loadSRSStats() {
    try {
        const res = await fetch(`${window.API}/api/srs/stats`, {
            headers: { Authorization: `Bearer ${getToken()}` }
        });
        if (!res.ok) return;
        const data = await res.json();
        const due = document.getElementById('stat-srs-due');
        const ret = document.getElementById('stat-retention');
        if (due) due.textContent = data.due_today ?? '—';
        if (ret) ret.textContent = data.retention != null ? data.retention + '%' : '—';
    } catch {}
}

// Gọi API recommendation và render block gợi ý AI
async function loadRecommendation() {
    try {
        const res = await fetch(`${window.API}/api/recommend`, {
            headers: { Authorization: `Bearer ${getToken()}` }
        });
        if (!res.ok) return;
        const data = await res.json();

        const block = document.getElementById('ai-recommend-block');
        const content = document.getElementById('ai-recommend-content');
        const cachedBadge = document.getElementById('ai-recommend-cached');
        const weakEl = document.getElementById('ai-weak-topics');

        if (!block || !content) return;
        block.style.display = 'block';
        content.textContent = data.recommendation || '';

        if (cachedBadge) {
            cachedBadge.textContent = data.cached ? '(từ bộ nhớ đệm)' : '';
        }

        // Hiện điểm yếu theo loại từ dưới dạng badge
        if (weakEl && data.weakTopics && data.weakTopics.length) {
            weakEl.innerHTML = data.weakTopics.map(t =>
                `<span style="background:var(--danger-light,#fde8e8);color:var(--danger,#e74c3c);border-radius:20px;padding:4px 12px;font-size:12px;font-weight:500">
                    <i class="fa-solid fa-exclamation-triangle"></i> ${t.word_type || 'Không rõ'}: ${t.accuracy}% chính xác
                </span>`
            ).join('');
        }
    } catch {}
}

function renderTodayWords() {
    const el = document.getElementById('today-words');
    if (!el) return;

    const studied = getStudied();
    const newWords = _words.filter(w => !studied.has(String(w.id)) && !_srsLearnedIds.has(String(w.id)));
    const today = newWords.slice(0, 6);

    if (!today.length) {
        el.innerHTML = `<div class="empty-state" style="padding:24px;text-align:center;color:var(--muted)">
             <i class="fa-solid fa-clipboard-check"></i> Bạn đã học hết từ vựng hiện có!
        </div>`;
        return;
    }

    el.innerHTML = today.map(w => `
        <div class="word-item word-item-clickable" onclick="navigateToFlashcard(${w.id})" style="cursor:pointer" title="Học từ này">
            <span class="word-zh">${w.hanzi}</span>
            <div style="flex:1">
                <div class="word-pinyin">${w.pinyin}</div>
                <div class="word-meaning">${w.meaning}</div>
            </div>
            <span class="word-level">HSK ${w.difficulty}</span>
        </div>`).join('');
}

function renderWeekProgress() {
    const el = document.getElementById('week-progress');
    if (!el) return;
    const days = getStudyDays();
    const labels = ['CN','T2','T3','T4','T5','T6','T7'];
    const today  = new Date();

    let html = '<div class="week-bar">';
    for (let i = 6; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        // FIX: toISOString() dùng giờ UTC, lệch ngày với giờ VN vào 0h-7h sáng.
        const key = localDateStr(d);
        const has = days.includes(key);
        const h   = has ? 72 : 8;
        html += `<div class="week-col">
            <div class="week-fill ${has ? 'has-data' : ''}" style="height:${h}px"></div>
            <div class="week-label">${labels[d.getDay()]}</div>
        </div>`;
    }
    html += '</div>';
    el.innerHTML = html;
}

// Navigate to flashcard and jump to specific word
window.navigateToFlashcard = function(wordId) {
    window.navigate('flashcard');
    setTimeout(() => {
        if (window._jumpToFlashcard) window._jumpToFlashcard(wordId);
    }, 300);
};

function getFallbackWords() {
    return [
        { id:1, hanzi:'你好', pinyin:'nǐ hǎo', meaning:'Xin chào', difficulty:1, category:'Giao tiếp', example:'你好，我是小明。', example_pinyin:'nǐ hǎo, wǒ shì xiǎo míng.', example_meaning:'Xin chào, tôi là Tiểu Minh.' },
        { id:2, hanzi:'谢谢', pinyin:'xiè xie', meaning:'Cảm ơn', difficulty:1, category:'Giao tiếp', example:'谢谢你！', example_pinyin:'xiè xie nǐ!', example_meaning:'Cảm ơn bạn!' },
        { id:3, hanzi:'再见', pinyin:'zài jiàn', meaning:'Tạm biệt', difficulty:1, category:'Giao tiếp', example:'再见，明天见！', example_pinyin:'zài jiàn, míng tiān jiàn!', example_meaning:'Tạm biệt, hẹn gặp lại ngày mai!' },
        { id:4, hanzi:'学习', pinyin:'xué xí', meaning:'Học tập', difficulty:2, category:'Học tập', example:'我喜欢学习汉语。', example_pinyin:'wǒ xǐ huān xué xí hàn yǔ.', example_meaning:'Tôi thích học tiếng Trung.' },
        { id:5, hanzi:'朋友', pinyin:'péng yǒu', meaning:'Bạn bè', difficulty:1, category:'Gia đình', example:'他是我的好朋友。', example_pinyin:'tā shì wǒ de hǎo péng yǒu.', example_meaning:'Anh ấy là bạn tốt của tôi.' },
        { id:6, hanzi:'中国', pinyin:'zhōng guó', meaning:'Trung Quốc', difficulty:1, category:'Du lịch', example:'中国是一个大国。', example_pinyin:'zhōng guó shì yī gè dà guó.', example_meaning:'Trung Quốc là một đất nước lớn.' },
    ];
}

