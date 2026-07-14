// storage/storage.js — localStorage helpers
//
// QUAN TRỌNG: Mọi dữ liệu học (từ đã học, streak cache, lịch sử quiz, thời
// gian học...) phải được lưu RIÊNG cho từng user, không dùng chung 1 key cho
// mọi tài khoản trên cùng máy/trình duyệt.
const PREFIX = 'hsk_';

// FIX: .toISOString().split('T')[0] trả về ngày theo giờ UTC. Với múi giờ VN
// (UTC+7), vào khoảng 0h-7h sáng giờ VN, ngày UTC vẫn còn là NGÀY HÔM QUA —
// khiến "hôm nay" bị tính lùi 1 ngày. Điều này làm sai streak, study_days,
// study_time, heatmap... đặc biệt với người dùng học vào sáng sớm. Dùng hàm
// này (dựa trên getFullYear/getMonth/getDate — giờ địa phương) ở MỌI nơi cần
// chuỗi ngày "YYYY-MM-DD", thay vì gọi toISOString() trực tiếp.
export function localDateStr(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function _currentUserId() {
    try {
        const u = localStorage.getItem('hsk_user');
        if (!u) return 'guest';
        const parsed = JSON.parse(u);
        return parsed?.id != null ? String(parsed.id) : 'guest';
    } catch { return 'guest'; }
}

function _namespacedKey(key) {
    return `${PREFIX}u${_currentUserId()}_${key}`;
}

export function get(key, def = null) {
    try {
        const v = localStorage.getItem(_namespacedKey(key));
        return v !== null ? JSON.parse(v) : def;
    } catch { return def; }
}

export function set(key, val) {
    try { localStorage.setItem(_namespacedKey(key), JSON.stringify(val)); } catch {}
}

export function remove(key) {
    localStorage.removeItem(_namespacedKey(key));
}

export function clearAllUserData() {
    const uid = _currentUserId();
    const prefix = `${PREFIX}u${uid}_`;
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) toRemove.push(k);
    }
    toRemove.forEach(k => localStorage.removeItem(k));
}

const _OLD_KEYS = ['studied', 'quiz_history', 'study_days', 'study_time', 'server_streak', 'last_streak_sync_day'];

function _migrateLegacyDataOnce() {
    try {
        if (localStorage.getItem(PREFIX + 'migrated_v2') === '1') return;
        const uid = _currentUserId();
        if (uid === 'guest') return;
        _OLD_KEYS.forEach(key => {
            const oldRaw = localStorage.getItem(PREFIX + key);
            if (oldRaw === null) return;
            const newKey = `${PREFIX}u${uid}_${key}`;
            if (localStorage.getItem(newKey) === null) {
                localStorage.setItem(newKey, oldRaw);
            }
        });
        _OLD_KEYS.forEach(key => localStorage.removeItem(PREFIX + key));
        localStorage.setItem(PREFIX + 'migrated_v2', '1');
    } catch {}
}
_migrateLegacyDataOnce();

export function retryMigrationAfterLogin() {
    _migrateLegacyDataOnce();
}

// FIX: Khi admin reset tiến độ học của user ở phía server (xoá word_progress,
// quiz_attempts, words_learned...), trình duyệt của user đó vẫn còn cache cũ
// trong localStorage (danh sách từ đã học, streak...). Nếu không xử lý, lần
// đăng nhập kế tiếp các hàm sync (vì luôn lấy MAX(local, server)) sẽ tự đẩy
// dữ liệu cũ lên server, vô tình HOÀN TÁC thao tác reset của admin.
//
// Giải pháp: server trả về `progress_reset_at` (thời điểm admin reset gần
// nhất). Client lưu lại mốc này; nếu server báo một mốc MỚI HƠN mốc đã lưu,
// nghĩa là có một lần reset mà client chưa biết → xoá sạch cache local
// trước khi bất kỳ logic đồng bộ nào khác chạy.
export function syncResetMarker(serverResetAt) {
    if (!serverResetAt) return; // user này chưa từng bị admin reset
    const localMarker = get('progress_reset_at', null);
    if (localMarker === serverResetAt) return; // đã biết về lần reset này rồi

    clearAllUserData(); // xoá toàn bộ cache (studied, streak, quiz_history, study_days/time...)
    set('progress_reset_at', serverResetAt); // đặt lại SAU khi clear, để mốc không bị xoá theo
}

// Studied words: Set of word IDs
export function getStudied() {
    return new Set(get('studied', []).map(String));
}

// FIX: "Đã học" (Tổng quan) và "Đã nhớ" (Flashcard) trước đây mỗi trang tính
// một kiểu — có nơi chỉ dựa vào cờ "studied" cục bộ (localStorage), có nơi đã
// hợp nhất thêm dữ liệu server. Kết quả 2 trang hiện số khác nhau (vd.
// Flashcard "Đã nhớ (26)" nhưng Tổng quan "Đã học (33)") dù cùng một ý nghĩa,
// gây khó hiểu cho người dùng. Hàm dùng chung này là NGUỒN DUY NHẤT cho "số từ
// đã học" ở mọi nơi — luôn hợp nhất studied cục bộ + word_progress phía server
// (nguồn sự thật, không mất khi đổi trình duyệt/thiết bị/chế độ ẩn danh).
let _serverLearnedIdsCache = null;
function _tokenFromStorage() {
    try { return JSON.parse(localStorage.getItem('hsk_user') || 'null')?.token || ''; }
    catch { return ''; }
}
export async function getMergedLearnedIds() {
    const local = getStudied();
    if (_serverLearnedIdsCache) return new Set([...local, ..._serverLearnedIdsCache]);
    try {
        const token = _tokenFromStorage();
        if (!token || !window.API) return local;
        const res = await fetch(`${window.API}/api/srs/learned-ids`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
            const data = await res.json();
            _serverLearnedIdsCache = new Set((data.ids || []).map(String));
            return new Set([...local, ..._serverLearnedIdsCache]);
        }
    } catch { /* fallback: chỉ dùng local nếu server lỗi/offline */ }
    return local;
}

export function markStudied(id) {
    const s = getStudied();
    s.add(String(id));
    set('studied', [...s]);
    // FIX: Sync words_learned lên server ngay lập tức khi đánh dấu từ mới,
    // không chờ đến lần sync streak. Điều này đảm bảo admin thấy đúng số từ đã học.
    _syncWordsLearnedToServer(s.size).catch(() => {});
}

export function unmarkStudied(id) {
    const s = getStudied();
    s.delete(String(id));
    set('studied', [...s]);
    _syncWordsLearnedToServer(s.size).catch(() => {});
}

// Quiz history
export function saveQuizResult(score, total, level) {
    const hist = get('quiz_history', []);
    hist.push({ score, total, level, date: new Date().toISOString() });
    if (hist.length > 100) hist.shift();
    set('quiz_history', hist);
}
export function getQuizHistory() { return get('quiz_history', []); }

// Study sessions — track date strings
export function recordStudyDay() {
    const today = localDateStr();
    const days  = get('study_days', []);
    if (!days.includes(today)) {
        days.push(today);
        set('study_days', days);
    }

    // Chỉ gọi sync streak lên server MỘT LẦN cho mỗi ngày
    const lastSyncedDay = get('last_streak_sync_day', null);
    if (lastSyncedDay !== today) {
        set('last_streak_sync_day', today);
        _syncStreakToServer().catch(() => {
            // Nếu sync lỗi, cho phép thử lại ở lần gọi kế tiếp
            set('last_streak_sync_day', lastSyncedDay);
        });
    }
}
export function getStudyDays() { return get('study_days', []); }

// Study time tracking
let _sessionStart = null;

export function startStudySession() {
    _sessionStart = Date.now();
}

export function endStudySession() {
    if (_sessionStart === null) return;
    const elapsedSec = Math.round((Date.now() - _sessionStart) / 1000);
    _sessionStart = null;
    if (elapsedSec < 2 || elapsedSec > 3 * 3600) return;
    const today = localDateStr();
    const times = get('study_time', {});
    times[today] = (times[today] || 0) + elapsedSec;
    set('study_time', times);
}

export function getTotalStudySeconds() {
    const times = get('study_time', {});
    return Object.values(times).reduce((a, b) => a + b, 0);
}

export function getStudySecondsForDay(dateStr) {
    const times = get('study_time', {});
    return times[dateStr] || 0;
}

// Streak — trả về MAX(server, local) để tránh trường hợp server bị tụt
export function getStreak() {
    const serverStreak = get('server_streak', null);
    const localStreak  = _calcLocalStreak();
    if (serverStreak === null) return localStreak;
    return Math.max(serverStreak, localStreak);
}

function _calcLocalStreak() {
    const days = [...new Set(getStudyDays())].sort().reverse(); // dedup + sort mới nhất trước
    if (!days.length) return 0;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = localDateStr(today);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yestStr = localDateStr(yesterday);

    // Streak chỉ hợp lệ nếu học hôm nay hoặc hôm qua
    if (!days.includes(todayStr) && !days.includes(yestStr)) return 0;

    let streak  = 0;
    let cursor  = new Date(today);

    for (const day of days) {
        const dd   = new Date(day + 'T00:00:00');
        const diff = Math.round((cursor - dd) / 86400000);
        if (diff === 0) {
            streak++;
            cursor.setDate(cursor.getDate() - 1);
        } else if (diff === 1 && streak === 0) {
            // Hôm qua là ngày đầu tiên trong chuỗi (học hôm qua, chưa học hôm nay)
            streak++;
            cursor = new Date(dd);
            cursor.setDate(cursor.getDate() - 1);
        } else if (diff > 1) {
            break; // Chuỗi bị ngắt
        }
        // diff === 1 && streak > 0: ngày bị duplicate hoặc sắp xếp lỗi → bỏ qua
    }
    return streak;
}

// FIX: Tách hàm sync words_learned riêng để có thể gọi ngay khi markStudied()
async function _syncWordsLearnedToServer(count) {
    const token = _getToken();
    if (!token) return;
    const api = window.API || (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        ? 'http://localhost:3000' : '');
    if (!api && api !== '') return;
    try {
        await fetch(`${api}/api/progress/words`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ words_learned: count })
        });
    } catch {}
}

async function _syncStreakToServer() {
    const token = _getToken();
    if (!token) return;
    const api = window.API || (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        ? 'http://localhost:3000' : '');
    const studied     = getStudied();
    const localStreak = _calcLocalStreak(); // gửi kèm để server dùng MAX
    try {
        const res = await fetch(`${api}/api/streak/sync`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ words_learned: studied.size, local_streak: localStreak })
        });
        if (res.ok) {
            const data = await res.json();
            // Luôn lưu MAX để không bao giờ xuống thấp hơn local
            set('server_streak', Math.max(data.streak, localStreak));
        }
    } catch {}
}

function _getToken() {
    try {
        const u = localStorage.getItem('hsk_user');
        return u ? JSON.parse(u).token : null;
    } catch { return null; }
}

export async function loadStreakFromServer() {
    const token = _getToken();
    if (!token) return;
    const api = window.API || (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        ? 'http://localhost:3000' : '');
    try {
        const res = await fetch(`${api}/api/profile`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            const data = await res.json();
            const serverStreak = data.streak ?? 0;
            const localStreak  = _calcLocalStreak();

            // Luôn lưu MAX để tránh server streak thấp hơn thực tế
            set('server_streak', Math.max(serverStreak, localStreak));

            // Nếu local cao hơn server → sync lên để server cập nhật
            if (localStreak > serverStreak) {
                _syncStreakToServer().catch(() => {});
            }

            if (data.words_learned != null) {
                const localStudied = getStudied();
                if (data.words_learned > localStudied.size) {
                    set('server_words_learned', data.words_learned);
                }
            }
        }
    } catch {}
}
