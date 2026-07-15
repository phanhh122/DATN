// flashcard/flashcard.js
import { getStudied, markStudied, unmarkStudied, recordStudyDay, getMergedLearnedIds } from '../storage/storage.js';
import { speakText } from '../components/tts.js';
import { showToast } from '../components/toast.js';
import { getToken } from '../auth/auth.js';

let _words    = [];
let _filtered = [];
let _idx      = 0;
let _flipped  = false;
let _hideStudied  = true;
let _currentLevel = 0;

// ── Init ─────────────────────────────────────────────────────
export async function initFlashcard() {
    _words = (window._allWords && window._allWords.length) ? window._allWords : [];
    if (!_words.length) {
        try {
            const res = await fetch(`${window.API}/api/words`, {
                headers: { Authorization: `Bearer ${getToken()}` }
            });
            if (res.ok) { _words = await res.json(); window._allWords = _words; }
        } catch (e) { console.error('[FC] load words:', e); }
    }
    renderModeBar();
    applyFilter();
}

// ── Mode bar ─────────────────────────────────────────────────
async function renderModeBar() {
    const el = document.getElementById('fc-hide-studied-toggle');
    if (!el) return;
    // FIX: trước đây chỉ dùng getStudied() (localStorage cục bộ) nên số
    // "Đã nhớ" ở đây có thể lệch với "Đã học" ở Tổng quan (vốn đã hợp nhất
    // thêm dữ liệu server) — giờ dùng chung 1 nguồn cho cả 2 nơi.
    const studied = await getMergedLearnedIds();
    const n = _words.filter(w => studied.has(String(w.id))).length;
    el.innerHTML = `
        <button class="fc-toggle-btn ${_hideStudied ? 'active' : ''}" onclick="toggleHideStudied()">
            ${_hideStudied ? '<i class="fa-solid fa-eye-slash"></i> Ẩn từ đã nhớ' : '<i class="fa-solid fa-eye"></i> Hiện tất cả'}
        </button>
        <button class="fc-toggle-btn fc-review-btn" onclick="navigate('studied')">
            <i class="fa-solid fa-book"></i> Đã nhớ (${n})
        </button>`;
    const cntEl = document.getElementById('fc-filter-count');
    if (cntEl) cntEl.textContent = (_hideStudied && n > 0) ? `(đang ẩn ${n} từ đã nhớ)` : '';
}

export function toggleHideStudied() {
    _hideStudied = !_hideStudied;
    renderModeBar();
    applyFilter();
    showToast(_hideStudied ? '<i class="fa-solid fa-eye-slash"></i> Đã ẩn từ đã nhớ' : '<i class="fa-solid fa-eye"></i> Hiện tất cả từ', 'info');
}

// ── Filter + Render ───────────────────────────────────────────
function applyFilter() {
    const studied = getStudied();
    let pool = _currentLevel ? _words.filter(w => w.difficulty == _currentLevel) : [..._words];
    if (_hideStudied) pool = pool.filter(w => !studied.has(String(w.id)));
    // Shuffle
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    _filtered = pool;
    _idx = 0;
    _flipped = false;
    renderCard();
}

function renderCard() {
    const cardWrap  = document.getElementById('fc-card-wrap');
    const fcActions = document.getElementById('fc-actions');
    const counter   = document.getElementById('fc-counter');
    const progBar   = document.getElementById('fc-progress-bar');
    const hint      = document.getElementById('fc-empty-hint');
    const card      = document.getElementById('flashcard');

    if (!_filtered.length) {
        // Ẩn card, hiện message
        if (cardWrap)  cardWrap.style.display  = 'none';
        if (fcActions) fcActions.style.display = 'none';
        if (counter)   counter.style.display   = 'none';
        if (progBar)   progBar.style.display   = 'none';

        const studied    = getStudied();
        const levelWords = _currentLevel ? _words.filter(w => w.difficulty == _currentLevel) : _words;
        const allStudied = levelWords.length > 0 && levelWords.every(w => studied.has(String(w.id)));
        const lvlLabel   = _currentLevel ? `HSK ${_currentLevel}` : 'tất cả cấp';

        let html = '';
        if (!_words.length) {
            html = `<div style="font-size:40px;margin-bottom:12px"><i class="fa-solid fa-book"></i></div>
                <p style="font-size:16px;font-weight:600">Chưa có từ vựng nào.</p>`;
        } else if (_hideStudied && allStudied) {
            html = `<div style="font-size:48px;margin-bottom:12px"><i class="fa-solid fa-clipboard-check"></i></div>
                <p style="font-size:18px;font-weight:700;margin-bottom:6px">Hoàn thành ${lvlLabel}!</p>
                <p style="font-size:14px;color:var(--muted);margin-bottom:20px">
                    Đã nhớ tất cả ${levelWords.length} từ. FSRS sẽ nhắc ôn lại đúng lúc.
                </p>
                <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
                    <button class="btn btn-primary" onclick="toggleHideStudied()"><i class="fa-solid fa-eye"></i> Xem lại tất cả</button>
                    <button class="btn btn-secondary" onclick="navigate('srs')"><i class="fa-solid fa-brain"></i> Ôn tập FSRS</button>
                    ${_currentLevel ? `<button class="btn btn-secondary" onclick="window.setFlashcardModeAll()"><i class="fa-solid fa-book-open"></i> Học cấp khác</button>` : ''}
                </div>`;
        } else if (_hideStudied) {
            html = `<div style="font-size:40px;margin-bottom:12px"><i class="fa-solid fa-check-circle"></i></div>
                <p style="font-size:16px;font-weight:600;margin-bottom:6px">Hết thẻ ${lvlLabel}!</p>
                <p style="font-size:14px;color:var(--muted);margin-bottom:16px">Tất cả từ ở cấp này đã được ẩn.</p>
                <button class="btn btn-primary" onclick="toggleHideStudied()"><i class="fa-solid fa-eye"></i> Hiện tất cả từ</button>`;
        } else {
            html = `<div style="font-size:40px;margin-bottom:12px"><i class="fa-solid fa-inbox"></i></div>
                <p style="font-size:14px;color:var(--muted)">Không có từ nào ở cấp này.</p>`;
        }
        if (hint) { hint.style.display = 'block'; hint.innerHTML = `<div style="text-align:center;padding:40px 20px;max-width:480px;margin:0 auto">${html}</div>`; }
        return;
    }

    // Có thẻ — hiện card
    if (cardWrap)  cardWrap.style.display  = '';
    if (fcActions) fcActions.style.display = '';
    if (counter)   counter.style.display   = '';
    if (progBar)   progBar.style.display   = '';
    if (hint) { hint.style.display = 'none'; hint.innerHTML = ''; }

    const w = _filtered[_idx];
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val ?? ''; };
    set('fc-hanzi',          w.hanzi);
    set('fc-back-hanzi',     w.hanzi);
    set('fc-pinyin',         w.pinyin   || '');
    set('fc-meaning',        w.meaning  || '');
    set('fc-example-zh',     w.example  || '');
    set('fc-example-pinyin', w.example_pinyin  || '');
    set('fc-example-meaning',w.example_meaning || '');
    set('fc-current',        _idx + 1);
    set('fc-total',          _filtered.length);

    const bar = document.getElementById('fc-progress');
    if (bar) bar.style.width = (_idx / Math.max(_filtered.length - 1, 1) * 100).toFixed(1) + '%';

    const badge = document.getElementById('fc-studied-badge');
    if (badge) badge.style.display = getStudied().has(String(w.id)) ? 'inline-block' : 'none';

    if (card && _flipped) { card.classList.remove('flipped'); _flipped = false; }
}

// ── Tab / Level controls ──────────────────────────────────────
export function setFlashcardMode() {
    _currentLevel = 0;
    document.querySelectorAll('#view-flashcard .tab-btn').forEach((b,i) => b.classList.toggle('active', i===0));
    applyFilter();
}

export function setLevel(lvl) {
    _currentLevel = lvl;
    document.querySelectorAll('#view-flashcard .tab-btn').forEach(b => {
        const btnLvl = parseInt(b.getAttribute('onclick')?.match(/setLevel\((\d+)\)/)?.[1]);
        b.classList.toggle('active', btnLvl === lvl);
    });
    applyFilter();
}

window._jumpToFlashcard = function(wordId) {
    _currentLevel = 0; _hideStudied = false;
    _filtered = [..._words];
    const i = _filtered.findIndex(w => String(w.id) === String(wordId));
    if (i > 0) { const [t] = _filtered.splice(i,1); _filtered.unshift(t); }
    _idx = 0;
    document.querySelectorAll('#view-flashcard .tab-btn').forEach((b,i) => b.classList.toggle('active', i===0));
    renderModeBar();
    renderCard();
};

window.setFlashcardModeAll = function() {
    _currentLevel = 0;
    document.querySelectorAll('#view-flashcard .tab-btn').forEach((b,i) => b.classList.toggle('active', i===0));
    applyFilter();
};

// ── Flip / Navigate ───────────────────────────────────────────
export function flipCard() {
    const card = document.getElementById('flashcard');
    if (!card) return;
    _flipped = !_flipped;
    card.classList.toggle('flipped', _flipped);
    if (_flipped && _filtered[_idx]) setTimeout(() => speakText(_filtered[_idx].hanzi), 400);
}

export function nextCard() {
    if (!_filtered.length) return;
    _idx = (_idx + 1) % _filtered.length;
    _flipped = false;
    renderCard();
    recordStudyDay();
}

export function prevCard() {
    if (!_filtered.length) return;
    _idx = (_idx - 1 + _filtered.length) % _filtered.length;
    _flipped = false;
    renderCard();
}

// ── Mark card ─────────────────────────────────────────────────
export function markCard(known) {
    if (!_filtered.length) return;
    const w = _filtered[_idx];
    if (!known) { showToast(`↺ "${w.hanzi}" sẽ lặp lại sau`, 'info'); nextCard(); return; }
    _showMemoryPicker(w);
}

function _showMemoryPicker(w) {
    document.getElementById('fc-memory-picker')?.remove();
    const levels = [
        { rating:1, label:'Mới học',  sub:'Ôn lại ngày mai',   color:'#e74c3c', days:'ngày mai', icon:'🔴' },
        { rating:2, label:'Khá nhớ',  sub:'Ôn lại sau 1 ngày', color:'#e67e22', days:'1 ngày',   icon:'🟠' },
        { rating:3, label:'Nhớ tốt',  sub:'Ôn lại sau 3 ngày', color:'#3498db', days:'3 ngày',   icon:'🔵' },
        { rating:4, label:'Nhớ chắc', sub:'Ôn lại sau 15 ngày',color:'#27ae60', days:'15 ngày',  icon:'🟢' },
    ];
    const overlay = document.createElement('div');
    overlay.id = 'fc-memory-picker';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
    overlay.innerHTML = `
        <div style="background:var(--surface,#fff);border-radius:20px;padding:28px 24px;max-width:420px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.25)">
            <div style="text-align:center;margin-bottom:20px">
                <div style="font-size:36px;font-weight:800;color:var(--primary)">${w.hanzi}</div>
                <div style="font-size:14px;color:var(--muted);margin-top:4px">${w.pinyin} · ${w.meaning}</div>
                <div style="font-size:15px;font-weight:600;margin-top:14px">Bạn nhớ từ này ở mức nào?</div>
                <div style="font-size:12px;color:var(--muted);margin-top:4px">FSRS sẽ lên lịch ôn dựa trên mức bạn chọn</div>
            </div>
            <div style="display:flex;flex-direction:column;gap:10px">
                ${levels.map(l => `
                    <button onclick="window._confirmMemoryLevel(${l.rating})"
                        style="display:flex;align-items:center;gap:14px;padding:14px 16px;border:2px solid ${l.color}22;
                            border-radius:12px;background:${l.color}0d;cursor:pointer;font-family:inherit;text-align:left;width:100%"
                        onmouseover="this.style.background='${l.color}20';this.style.borderColor='${l.color}'"
                        onmouseout="this.style.background='${l.color}0d';this.style.borderColor='${l.color}22'">
                        <span style="font-size:22px">${l.icon}</span>
                        <div style="flex:1">
                            <div style="font-weight:700;color:${l.color};font-size:15px">${l.label}</div>
                            <div style="font-size:12px;color:var(--muted)">${l.sub}</div>
                        </div>
                        <span style="font-size:11px;font-weight:600;color:${l.color};background:${l.color}15;padding:3px 10px;border-radius:20px">${l.days}</span>
                    </button>`).join('')}
            </div>
            <button onclick="document.getElementById('fc-memory-picker').remove()"
                style="width:100%;margin-top:14px;padding:10px;border:none;background:none;color:var(--muted);cursor:pointer;font-size:13px;font-family:inherit">Huỷ</button>
        </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

window._confirmMemoryLevel = function(rating) {
    document.getElementById('fc-memory-picker')?.remove();
    if (!_filtered.length) return;
    const w = _filtered[_idx];
    markStudied(String(w.id));
    const msgs = { 1:`🔴 "${w.hanzi}" — ôn ngày mai`, 2:`🟠 "${w.hanzi}" — ôn sau 1 ngày`, 3:`🔵 "${w.hanzi}" — ôn sau 3 ngày`, 4:`🟢 "${w.hanzi}" — ôn sau 15 ngày` };
    showToast(msgs[rating] + ' (FSRS)', 'success');
    const token = getToken();
    if (token) fetch(`${window.API}/api/srs/init`, {
        method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${token}`},
        body: JSON.stringify({ word_ids:[w.id], initial_rating:rating })
    }).catch(()=>{});
    renderModeBar();
    if (_hideStudied) { _filtered.splice(_idx,1); if (_idx >= _filtered.length) _idx = Math.max(0,_filtered.length-1); renderCard(); return; }
    nextCard();
};

// ── Studied words view (view-studied) ────────────────────────
export function initStudied() {
    const el = document.getElementById('studied-word-list');
    if (!el) return;
    if (!_words.length && window._allWords?.length) _words = window._allWords;

    const studied  = getStudied();
    const doneList = _words.filter(w => studied.has(String(w.id)));

    if (!doneList.length) {
        el.innerHTML = `<div style="text-align:center;padding:60px 20px">
            <div style="font-size:48px;margin-bottom:12px"><i class="fa-solid fa-inbox"></i></div>
            <p style="color:var(--muted)">Chưa có từ nào được đánh dấu.</p>
            <p style="font-size:13px;color:var(--muted);margin-top:6px">Học flashcard và bấm <strong>✓ Đã nhớ</strong> để từ xuất hiện ở đây.</p>
            <button class="btn btn-primary" style="margin-top:20px" onclick="navigate('flashcard')">← Quay lại học</button>
        </div>`;
        return;
    }

    const byLevel = {};
    doneList.forEach(w => { const l = w.difficulty||1; if(!byLevel[l]) byLevel[l]=[]; byLevel[l].push(w); });

    let html = `<p style="color:var(--muted);font-size:13px;margin-bottom:20px">${doneList.length} từ đã nhớ</p>`;
    Object.entries(byLevel).sort(([a],[b])=>a-b).forEach(([lvl, words]) => {
        html += `<div style="margin-bottom:24px">
            <div style="font-size:12px;font-weight:700;color:var(--primary);letter-spacing:1px;
                text-transform:uppercase;margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid var(--primary)">
                HSK ${lvl} · ${words.length} từ
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px">
                ${words.map(w => `
                    <div class="studied-word-card" onclick="window._reviewWord(${w.id})">
                        <div style="display:flex;justify-content:space-between;align-items:flex-start">
                            <span style="font-size:24px;font-weight:700;color:var(--primary)">${w.hanzi}</span>
                            <button class="unmark-btn" onclick="event.stopPropagation();window._unmarkWord(${w.id},this)" title="Bỏ đánh dấu">✕</button>
                        </div>
                        <div style="font-size:13px;color:var(--text2);margin-top:4px">${w.pinyin||''}</div>
                        <div style="font-size:14px;color:var(--text);margin-top:2px">${w.meaning||''}</div>
                    </div>`).join('')}
            </div>
        </div>`;
    });
    el.innerHTML = html;
}

window._unmarkWord = function(wordId) {
    unmarkStudied(String(wordId));
    const w = _words.find(w => w.id === wordId);
    if (w) showToast(`↩ Đã bỏ đánh dấu "${w.hanzi}"`, 'info');
    initStudied(); // re-render studied view
};

window._reviewWord = function(wordId) {
    navigate('flashcard');
    setTimeout(() => { if (window._jumpToFlashcard) window._jumpToFlashcard(wordId); }, 300);
};

export { applyFilter };
