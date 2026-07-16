// js/srs/srs.js — FSRS-4.5 Review Interface
import { speakText } from '../components/tts.js';
import { showToast } from '../components/toast.js';
import { recordStudyDay, markStudied } from '../storage/storage.js';

let _cards       = [];   // tất cả thẻ trong session (due trước, new sau)
let _dueCount    = 0;    // số thẻ đến hạn thực sự (index 0 → _dueCount-1)
let _idx         = 0;
let _flipped     = false;
let _sessionLog  = [];
let _stats       = { again:0, hard:0, good:0, easy:0 };
let _initialized = false;
let _token       = null;
let _shownTransition = false; 
let _pendingReviews = [];


export function waitForPendingSRSReviews() {
    return Promise.allSettled(_pendingReviews);
}

function _getToken() {
    try { return JSON.parse(localStorage.getItem('hsk_user'))?.token || null; } catch { return null; }
}

export async function initSRS() {
    _token = _getToken();
    _initialized = false;
    _sessionLog  = [];
    _stats       = { again:0, hard:0, good:0, easy:0 };
    _shownTransition = false;
    _pendingReviews = [];

    _showSection('srs-loading');

    try {
        const res = await fetch(`${window.API}/api/srs/due?limit=30`, {
            headers: { Authorization: `Bearer ${_token}` }
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        _cards    = data.cards || [];
        _dueCount = data.dueCount || 0;

        // FIX: các số đếm trong legend ("Cần ôn (X)" / "Từ mới (Y)") chưa từng
        // được cập nhật, luôn hiển thị giá trị mặc định "0" trong HTML.
        _setText('srs-due-count', _dueCount);
        _setText('srs-new-count', _cards.length - _dueCount);
    } catch (e) {
        console.error('[SRS]', e);
        _showSection('srs-empty');
        document.getElementById('srs-empty-msg').textContent = 'Không tải được danh sách. Kiểm tra kết nối.';
        return;
    }

    if (!_cards.length) {
        _showSection('srs-empty');
        // Tải lịch ôn sắp tới để hiện thay vì thông báo rỗng chung chung
        _loadUpcoming();
        return;
    }

    _idx     = 0;
    _flipped = false;
    _showSection('srs-session');
    renderSRSCard();
    _initialized = true;
}

// ── Render ─────────────────────────────────────────────────────
function renderSRSCard() {
    if (_idx >= _cards.length) { showSRSResult(); return; }

    // Toast chuyển giao: vừa xong hết due → bắt đầu thẻ mới
    if (!_shownTransition && _dueCount > 0 && _idx === _dueCount) {
        _shownTransition = true;
        const newCount = _cards.length - _dueCount;
        showToast(`Ôn xong ${_dueCount} thẻ đến hạn! Tiếp theo: ${newCount} từ mới.`, 'success');
    }

    const w = _cards[_idx];
    const isDue = _idx < _dueCount;
    _flipped = false;

    const card = document.getElementById('srs-card');
    if (card) card.classList.remove('flipped');

    // ── Nội dung ──
    _setText('srs-hanzi',          w.hanzi);
    _setText('srs-back-hanzi',     w.hanzi);
    _setText('srs-pinyin',         w.pinyin || '');
    _setText('srs-meaning',        w.meaning || '');
    _setText('srs-example-zh',     w.example || '');
    _setText('srs-example-pinyin', w.example_pinyin || '');
    _setText('srs-example-meaning',w.example_meaning || '');

    // ── Badge: "Cần ôn" vs "Mới" ──
    const dueBadge = document.getElementById('srs-due-badge');
    const newBadge = document.getElementById('srs-new-badge');
    if (dueBadge) dueBadge.style.display = isDue  ? 'inline-block' : 'none';
    if (newBadge) newBadge.style.display  = !isDue && w.isNew ? 'inline-block' : 'none';

    // ── Màu viền card theo loại ──
    if (card) {
        card.classList.toggle('card-due', isDue);
        card.classList.toggle('card-new', !isDue && !!w.isNew);
    }

    // ── Thông tin stability nếu là thẻ đến hạn ──
    const infoEl = document.getElementById('srs-card-info');
    if (infoEl) {
        if (isDue && w.stability) {
            const retDays = Math.round(w.interval_days || 0);
            infoEl.innerHTML = `<span style="color:var(--muted);font-size:11px">
                Stability: ${Number(w.stability).toFixed(1)} ngày ·
                Interval trước: ${retDays} ngày
            </span>`;
            infoEl.style.display = 'block';
        } else {
            infoEl.style.display = 'none';
        }
    }

    // ── Progress bar kép: phần due (đỏ/cam) + phần new (xanh) ──
    renderProgressBar();

    // ── Counter ──
    _setText('srs-current', _idx + 1);
    _setText('srs-total',   _cards.length);

    // ── Label section ──
    const sectionEl = document.getElementById('srs-section-label');
    if (sectionEl) {
        if (isDue) {
            const doneCount = _idx;
            const leftDue   = _dueCount - _idx;
            sectionEl.innerHTML = `<span class="srs-label-due"><i class="fa-solid fa-bell"></i> Ôn tập đến hạn</span>
                <span style="color:var(--muted);font-size:12px">Còn ${leftDue} thẻ đến hạn</span>`;
        } else {
            const newDone = _idx - _dueCount + 1;
            const newLeft = _cards.length - _idx;
            sectionEl.innerHTML = `<span class="srs-label-new"><i class="fa-solid fa-star"></i> Từ mới</span>
                <span style="color:var(--muted);font-size:12px">Từ mới ${_idx - _dueCount + 1}/${_cards.length - _dueCount}</span>`;
        }
    }

    // ── Ẩn nút đánh giá cho đến khi lật ──
    const ratingEl = document.getElementById('srs-rating-btns');
    if (ratingEl) ratingEl.style.display = 'none';
    const hintEl = document.getElementById('srs-flip-hint');
    if (hintEl) hintEl.style.display = 'block';
}

function renderProgressBar() {
    const bar = document.getElementById('srs-progress');
    if (!bar) return;

    const total    = _cards.length;
    const doneAll  = _idx;
    const doneDue  = Math.min(_idx, _dueCount);
    const doneNew  = Math.max(0, _idx - _dueCount);
    const duePct   = _dueCount   > 0 ? (_dueCount / total * 100).toFixed(1) : 0;
    const newPct   = (total - _dueCount) > 0 ? ((total - _dueCount) / total * 100).toFixed(1) : 0;
    const fillDue  = _dueCount   > 0 ? (doneDue  / _dueCount * duePct).toFixed(1)              : 0;
    const fillNew  = (total - _dueCount) > 0 ? (doneNew / (total - _dueCount) * newPct).toFixed(1) : 0;

    // Dùng thanh kép: 2 màu gradient
    bar.style.width      = '100%';
    bar.style.background = 'none';
    bar.innerHTML = `
        <div style="display:flex;height:100%;border-radius:4px;overflow:hidden;width:100%">
            ${_dueCount > 0 ? `<div style="width:${duePct}%;background:#e2e8f0;position:relative;border-right:2px solid var(--surface,#fff)">
                <div style="width:${doneDue > 0 ? (doneDue/_dueCount*100).toFixed(0) : 0}%;height:100%;background:linear-gradient(90deg,#e67e22,#e74c3c);transition:width .3s;border-radius:4px 0 0 4px"></div>
            </div>` : ''}
            ${(total - _dueCount) > 0 ? `<div style="flex:1;background:#e2e8f0;position:relative">
                <div style="width:${doneNew > 0 ? (doneNew/(total-_dueCount)*100).toFixed(0) : 0}%;height:100%;background:linear-gradient(90deg,#27ae60,#2ecc71);transition:width .3s;border-radius:${_dueCount===0?'4px':'0'} 4px 4px ${_dueCount===0?'4px':'0'}"></div>
            </div>` : ''}
        </div>`;
}

function _setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

// ── Flip & Rate ────────────────────────────────────────────────
export function flipSRSCard() {
    const card = document.getElementById('srs-card');
    if (!card) return;
    _flipped = !_flipped;
    card.classList.toggle('flipped', _flipped);
    if (_flipped) {
        const w = _cards[_idx];
        if (w) setTimeout(() => speakText(w.hanzi), 400);
        const ratingEl = document.getElementById('srs-rating-btns');
        if (ratingEl) ratingEl.style.display = 'flex';
        const hintEl = document.getElementById('srs-flip-hint');
        if (hintEl) hintEl.style.display = 'none';
    }
}

export async function rateSRSCard(rating) {
    if (!_initialized || _idx >= _cards.length) return;
    if (![1,2,3,4].includes(rating)) return;
    const w = _cards[_idx];
    const labels = { 1:'again', 2:'hard', 3:'good', 4:'easy' };
    _stats[labels[rating]]++;
    _sessionLog.push({ word_id: w.id, rating });
    markStudied(String(w.id));

    const reviewReq = fetch(`${window.API}/api/srs/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${_token}` },
        body: JSON.stringify({ word_id: w.id, rating })
    }).then(async res => {
        if (!res.ok) {
            const msg = await res.json().catch(() => ({}));
            console.error('[SRS review] Lưu thất bại:', res.status, msg);
            showToast(`Không lưu được kết quả ôn tập (lỗi ${res.status}). Số thẻ cần ôn có thể không cập nhật đúng.`, 'error');
        }
        return res;
    }).catch(err => {
        console.error('[SRS review] Lỗi mạng:', err);
        showToast('Mất kết nối khi lưu kết quả ôn tập — thử lại khi có mạng.', 'error');
    });
    _pendingReviews.push(reviewReq);

    const toastMap = {
        1: 'Quên — ôn lại ngay hôm nay',
        2: 'Hard — stability tăng chậm',
        3: 'Good — stability tăng bình thường',
        4: 'Easy — stability tăng mạnh!',
    };
    showToast(toastMap[rating], rating >= 3 ? 'success' : 'info');

    _idx++;
    recordStudyDay();
    renderSRSCard();
}

// ── Result 
function showSRSResult() {
    _showSection('srs-result');
    const total   = _sessionLog.length;
    const correct = _stats.good + _stats.easy;
    const pct     = total ? Math.round((correct / total) * 100) : 0;

    _setText('srs-result-total',   total);
    _setText('srs-result-correct', correct);
    _setText('srs-result-pct',     pct + '%');
    _setText('srs-result-again',   _stats.again);
    _setText('srs-result-hard',    _stats.hard);
    _setText('srs-result-good',    _stats.good);
    _setText('srs-result-easy',    _stats.easy);

    // Breakdown: thẻ đến hạn vs thẻ mới
    const breakEl = document.getElementById('srs-result-breakdown');
    if (breakEl && _dueCount > 0 && _cards.length > _dueCount) {
        const newCount = _cards.length - _dueCount;
        breakEl.innerHTML = `
            <div style="display:flex;gap:16px;justify-content:center;flex-wrap:wrap;margin-bottom:16px;font-size:13px">
                <span style="color:#e67e22"><i class="fa-solid fa-bell"></i> Ôn lại: <strong>${_dueCount}</strong> thẻ đến hạn</span>
                <span style="color:#27ae60"><i class="fa-solid fa-star"></i> Học mới: <strong>${newCount}</strong> từ mới</span>
            </div>`;
    } else if (breakEl) {
        breakEl.innerHTML = '';
    }

    const msg = pct >= 90 ? '<Xuất sắc! Bộ nhớ dài hạn của bạn rất tốt!'
              : pct >= 70 ? 'Tốt lắm! Tiếp tục duy trì!'
              : pct >= 50 ? 'Cần luyện thêm — FSRS sẽ ưu tiên các từ bạn chưa nhớ.'
              : 'Đừng nản! FSRS sẽ lên lịch ôn lại đúng lúc để giúp bạn nhớ lâu hơn.';
    _setText('srs-result-msg', msg);
}

function _showSection(id) {
    ['srs-loading','srs-session','srs-empty','srs-result'].forEach(s => {
        const el = document.getElementById(s);
        if (el) el.style.display = s === id ? 'block' : 'none';
    });
}

export async function restartSRS() {
    await waitForPendingSRSReviews();
    return initSRS();
}

async function _loadUpcoming() {
    const msgEl = document.getElementById('srs-empty-msg');
    const schedEl = document.getElementById('srs-upcoming-schedule');
    if (msgEl) msgEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang tải lịch ôn tập...';

    try {
        const res = await fetch(`${window.API}/api/srs/upcoming`, {
            headers: { Authorization: `Bearer ${_token}` }
        });
        if (!res.ok) throw new Error();
        const data = await res.json();

        if (data.totalInSystem === 0) {
            // Chưa có từ nào trong SRS
            if (msgEl) msgEl.innerHTML = `
                <div style="font-size:48px;margin-bottom:12px"><i class="fa-solid fa-inbox"></i></div>
                <strong>Chưa có từ nào trong hệ thống ôn tập</strong><br>
                <span style="font-size:14px;color:var(--muted)">Vào <strong>Flashcard</strong>, học từ mới và bấm <strong>✓ Đã nhớ</strong>
                để thêm từ vào lịch ôn FSRS.</span>`;
        } else if (!data.upcoming?.length) {
            if (msgEl) msgEl.innerHTML = `
                <div style="font-size:48px;margin-bottom:12px"><i class="fa-solid fa-clipboard-check"></i></div>
                <strong>Xuất sắc! Hôm nay không có thẻ nào cần ôn.</strong><br>
                <span style="font-size:14px;color:var(--muted)">${data.totalInSystem} từ đang trong hệ thống FSRS. Hẹn gặp lại ngày mai!</span>`;
        } else {
            // Hiện lịch ôn sắp tới
            const groups = {};
            data.upcoming.forEach(r => {
                const d = r.days_until === 1 ? 'Ngày mai' : `${r.days_until} ngày nữa`;
                if (!groups[d]) groups[d] = [];
                groups[d].push(r);
            });

            if (msgEl) msgEl.innerHTML = `
                <div style="font-size:36px;margin-bottom:8px"><i class="fa-solid fa-check-circle"></i></div>
                <strong>Hôm nay đã ôn xong!</strong>
                <div style="font-size:13px;color:var(--muted);margin-top:4px">${data.totalInSystem} từ trong hệ thống FSRS</div>`;

            if (schedEl) {
                schedEl.innerHTML = `<div class="section-title" style="margin-bottom:12px"><i class="fa-solid fa-calendar-days"></i> Lịch ôn sắp tới</div>` +
                    Object.entries(groups).slice(0, 4).map(([label, words]) =>
                        `<div style="margin-bottom:16px">
                            <div style="font-size:12px;font-weight:700;color:var(--primary);margin-bottom:8px">${label} (${words.length} thẻ)</div>
                            <div style="display:flex;flex-wrap:wrap;gap:8px">
                                ${words.slice(0,8).map(w =>
                                    `<span style="background:var(--surface2,rgba(108,99,255,.07));border:1px solid var(--border);
                                        border-radius:8px;padding:4px 12px;font-size:13px">
                                        <strong>${w.hanzi}</strong> ${w.meaning}
                                    </span>`
                                ).join('')}
                                ${words.length > 8 ? `<span style="color:var(--muted);font-size:12px;padding:4px">+${words.length-8} từ nữa</span>` : ''}
                            </div>
                        </div>`
                    ).join('');
                schedEl.style.display = 'block';
            }
        }
    } catch {
        if (msgEl) msgEl.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> Có lỗi xảy ra khi tải lịch ôn tập!';
    }
}

