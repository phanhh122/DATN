// search/search.js
import { speakText } from '../components/tts.js';

let _words   = [];
let _level   = 0;
let _inited  = false;

export async function initSearch() {
    _words = window._allWords || [];
    if (!_words.length) {
        try {
            const res = await fetch(`${window.API}/api/words`);
            if (res.ok) { _words = await res.json(); window._allWords = _words; }
        } catch {}
    }

    if (!_inited) {
        renderChips();
        document.getElementById('search-input').addEventListener('input', renderResults);
        _inited = true;
    }

    renderResults();
}

function renderChips() {
    const el = document.getElementById('filter-chips');
    if (!el) return;
    const chips = [{ label:'Tất cả', val:0 }, ...([1,2,3,4,5,6].map(n => ({ label:`HSK ${n}`, val:n })))];
    el.innerHTML = chips.map(c => `
        <button class="chip ${c.val === _level ? 'active' : ''}"
            onclick="window._searchSetLevel(${c.val})">${c.label}</button>`).join('');
}

window._searchSetLevel = function(lvl) {
    _level = lvl;
    renderChips();
    renderResults();
};

function renderResults() {
    const q   = (document.getElementById('search-input')?.value || '').toLowerCase().trim();
    const el  = document.getElementById('search-results');
    if (!el) return;

    let filtered = _level ? _words.filter(w => w.difficulty == _level) : [..._words];
    if (q) {
        filtered = filtered.filter(w =>
            w.hanzi.includes(q) ||
            (w.pinyin || '').toLowerCase().includes(q) ||
            (w.meaning || '').toLowerCase().includes(q)
        );
    }

    if (!filtered.length) {
        el.innerHTML = '<div style="text-align:center;padding:48px;color:var(--text3)">Không tìm thấy kết quả</div>';
        return;
    }

    el.innerHTML = filtered.slice(0, 60).map(w => `
        <div class="search-word-item">
            <div class="search-zh">${w.hanzi}</div>
            <div class="search-info">
                <div class="search-pinyin">${w.pinyin || ''}</div>
                <div class="search-meaning">${w.meaning || ''}</div>
                ${w.example ? `<div class="search-example">${w.example}</div>` : ''}
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex-shrink:0">
                <span class="word-level">HSK ${w.difficulty}</span>
                <button class="btn-speak" onclick="window.speakText('${escQ(w.hanzi)}')">
                    <i class="fa-solid fa-volume-up"></i> Nghe
                </button>
            </div>
        </div>`).join('');
}

function escQ(s) { return s.replace(/'/g, "\\'"); }
