// progress/progress.js
import { getStudied, getStreak, getStudyDays, getQuizHistory, loadStreakFromServer, getTotalStudySeconds, getMergedLearnedIds, localDateStr } from '../storage/storage.js';
import { getToken } from '../auth/auth.js';

// Helper null-safe — không crash khi element chưa có trong HTML
const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

export async function initProgress() {
    await loadStreakFromServer();

    // ── Fix: tự fetch words nếu chưa có (user navigate thẳng vào Progress) ──
    if (!window._allWords || !window._allWords.length) {
        try {
            const res = await fetch(`${window.API}/api/words`, {
                headers: { Authorization: `Bearer ${getToken()}` }
            });
            if (res.ok) window._allWords = await res.json();
        } catch {}
    }

    const words   = window._allWords || [];
    // FIX: trước đây getStudied() chỉ đọc localStorage nên "Đã thuộc" và tỉ lệ
    // theo từng cấp HSK ở trang Tiến độ có thể lệch với Tổng quan/Flashcard/Hồ
    // sơ (đã hợp nhất thêm dữ liệu server). Dùng chung nguồn getMergedLearnedIds().
    const studied = await getMergedLearnedIds();
    const qhist   = getQuizHistory();
    const days    = getStudyDays();

    const accuracy = qhist.length
        ? Math.round(qhist.reduce((a,b) => a + b.score/b.total, 0) / qhist.length * 100)
        : 0;

    // ── Stat cards ──
    set('p-days',     days.length);
    set('p-quiz',     qhist.length);
    set('p-mastered', studied.size);
    set('p-time',     formatStudyTime(getTotalStudySeconds()));
    set('p-accuracy', accuracy + '%');

    // ── HSK level mastery (cho radar + progress bars) ──
    const hskGroups = {};
    for (let i = 1; i <= 6; i++) hskGroups[i] = { total: 0, done: 0 };
    words.forEach(w => {
        const lvl = Number(w.difficulty) || 1;
        if (hskGroups[lvl]) { hskGroups[lvl].total++; if (studied.has(String(w.id))) hskGroups[lvl].done++; }
    });

    // ── Progress bars ──
    const catEl = document.getElementById('category-progress');
    if (catEl) {
        catEl.innerHTML = Object.entries(hskGroups)
            .filter(([, v]) => v.total > 0)
            .map(([lvl, v]) => {
                const pct = v.total ? Math.round(v.done / v.total * 100) : 0;
                return `<div class="progress-bar-wrap">
                    <div class="progress-bar-label">
                        <span>HSK ${lvl}</span>
                        <span style="color:var(--primary)">${v.done}/${v.total} · ${pct}%</span>
                    </div>
                    <div class="progress-bar"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
                </div>`;
            }).join('');
    }

    // ── Radar chart SVG ──
    renderRadarChart(hskGroups);

    // ── 90-day heatmap ──
    renderHeatmap(days);

    // ── Server analytics (weak topics + accuracy by type) ──
    loadServerAnalytics();

    // ── Word list ──
    renderWordList(words, studied);
}

// ─────────────────────────────────────────────
//  RADAR CHART — SVG thuần, không cần thư viện
//  6 trục = 6 cấp HSK, polygon = tỉ lệ thành thạo
// ─────────────────────────────────────────────
function renderRadarChart(hskGroups) {
    const el = document.getElementById('hsk-radar');
    if (!el) return;

    const W = 280, H = 280, cx = 140, cy = 140, R = 110;
    const levels = [1,2,3,4,5,6];
    const n = levels.length;
    const labels = levels.map(l => `HSK${l}`);
    const pcts   = levels.map(l => hskGroups[l] ? (hskGroups[l].total ? hskGroups[l].done / hskGroups[l].total : 0) : 0);

    function pt(i, r) {
        const angle = -Math.PI/2 + i * (2*Math.PI/n);
        return [cx + r*Math.cos(angle), cy + r*Math.sin(angle)];
    }

    // Grid rings (20%, 40%, 60%, 80%, 100%)
    let grid = '';
    [0.2,0.4,0.6,0.8,1].forEach(f => {
        const pts = levels.map((_,i) => pt(i, R*f).join(',')).join(' ');
        grid += `<polygon points="${pts}" fill="none" stroke="var(--border,#e2e8f0)" stroke-width="1"/>`;
        // ring label
        const [lx, ly] = pt(0, R*f);
        grid += `<text x="${lx+4}" y="${ly}" font-size="9" fill="var(--muted,#94a3b8)">${Math.round(f*100)}%</text>`;
    });

    // Axes
    let axes = '';
    levels.forEach((_,i) => {
        const [x,y] = pt(i, R);
        axes += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="var(--border,#e2e8f0)" stroke-width="1"/>`;
    });

    // Labels
    let lbls = '';
    labels.forEach((lbl,i) => {
        const [x,y] = pt(i, R+22);
        const anchor = x < cx-5 ? 'end' : x > cx+5 ? 'start' : 'middle';
        const colors = ['#e74c3c','#e67e22','#f1c40f','#2ecc71','#3498db','#9b59b6'];
        lbls += `<text x="${x}" y="${y+4}" text-anchor="${anchor}" font-size="12" font-weight="600" fill="${colors[i]}">${lbl}</text>`;
    });

    // Data polygon
    const dataPts = pcts.map((p,i) => pt(i, R*p).join(',')).join(' ');
    const polygon = `<polygon points="${dataPts}" fill="rgba(108,99,255,0.18)" stroke="var(--primary,#6c63ff)" stroke-width="2.5" stroke-linejoin="round"/>`;

    // Dots
    const dots = pcts.map((p,i) => {
        const [x,y] = pt(i, R*p);
        return `<circle cx="${x}" cy="${y}" r="4" fill="var(--primary,#6c63ff)" stroke="#fff" stroke-width="2"/>`;
    }).join('');

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:280px">
        ${grid}${axes}${polygon}${dots}${lbls}
    </svg>`;
}

// ─────────────────────────────────────────────
//  90-DAY HEATMAP — ô màu theo ngày học
// ─────────────────────────────────────────────
function renderHeatmap(days) {
    const el = document.getElementById('study-calendar');
    if (!el) return;

    const today = new Date();
    let html = '<div class="heatmap-grid">';
    for (let i = 89; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        // FIX: toISOString() dùng giờ UTC, lệch ngày với giờ VN vào 0h-7h sáng.
        const key = localDateStr(d);
        const studied = days.includes(key);
        const dayLabel = d.toLocaleDateString('vi-VN', { day:'numeric', month:'numeric' });
        html += `<div class="heatmap-cell ${studied ? 'active' : ''}" title="${key}${studied?' — Đã học':' — Chưa học'}"></div>`;
    }
    html += '</div>';
    // Month labels
    const months = [];
    for (let i = 89; i >= 0; i -= 7) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        months.push(d.toLocaleDateString('vi-VN',{month:'short'}));
    }
    html += `<div class="heatmap-months">${[...new Set(months)].map(m=>`<span>${m}</span>`).join('')}</div>`;
    el.innerHTML = html;
}

// ─────────────────────────────────────────────
//  SERVER ANALYTICS — weak topics + SRS stats
// ─────────────────────────────────────────────
async function loadServerAnalytics() {
    const token = getToken();
    try {
        const [weakRes, srsRes] = await Promise.all([
            fetch(`${window.API}/api/analytics/weak-topics`, { headers:{ Authorization:`Bearer ${token}` } }),
            fetch(`${window.API}/api/srs/stats`,             { headers:{ Authorization:`Bearer ${token}` } }),
        ]);

        if (weakRes.ok) {
            const data = await weakRes.json();
            renderAccuracyByType(data.weakWordTypes || []);
            renderAccuracyByLevel(data.accuracyByLevel || []);
        }
        if (srsRes.ok) {
            const s = await srsRes.json();
            set('p-retention', s.retention != null ? s.retention + '%' : '—');
            set('p-srs-due',   s.due_today ?? '—');
        }
    } catch {}
}

function renderAccuracyByType(types) {
    const el = document.getElementById('accuracy-by-type');
    if (!el) return;
    if (!types.length) {
        el.innerHTML = '<p style="color:var(--muted);font-size:13px">Cần làm quiz/ôn tập thêm để có dữ liệu phân tích.</p>';
        return;
    }
    // Sort worst first
    const sorted = [...types].sort((a,b) => a.accuracy - b.accuracy);
    el.innerHTML = sorted.map(t => {
        const pct = t.accuracy ?? 0;
        const color = pct >= 80 ? '#27ae60' : pct >= 60 ? '#e67e22' : '#e74c3c';
        return `<div style="margin-bottom:12px">
            <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
                <span>${t.word_type || 'Không rõ'}</span>
                <span style="font-weight:600;color:${color}">${pct}% <span style="color:var(--muted);font-weight:400">(${t.attempts} lần)</span></span>
            </div>
            <div class="progress-bar">
                <div class="progress-bar-fill" style="width:${pct}%;background:${color}"></div>
            </div>
        </div>`;
    }).join('');
}

function renderAccuracyByLevel(levels) {
    const el = document.getElementById('accuracy-by-level');
    if (!el || !levels.length) return;
    el.innerHTML = levels.map(l => {
        const pct = l.accuracy ?? 0;
        const color = pct >= 80 ? '#27ae60' : pct >= 60 ? '#e67e22' : '#e74c3c';
        return `<div style="margin-bottom:10px">
            <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
                <span style="font-weight:600">HSK ${l.hsk_level}</span>
                <span style="color:${color};font-weight:600">${pct}%</span>
            </div>
            <div class="progress-bar">
                <div class="progress-bar-fill" style="width:${pct}%;background:${color}"></div>
            </div>
        </div>`;
    }).join('');
}

// ─────────────────────────────────────────────
//  WORD LIST
// ─────────────────────────────────────────────
function renderWordList(words, studied) {
    const pwEl = document.getElementById('progress-word-list');
    if (!pwEl) return;
    const studiedWords   = words.filter(w => studied.has(String(w.id)));
    const unstudiedWords = words.filter(w => !studied.has(String(w.id)));
    const PAGE = 30;
    let page = 0;

    function renderWordPage() {
        const all   = [...studiedWords, ...unstudiedWords];
        const slice = all.slice(0, (page + 1) * PAGE);
        const rows  = slice.map(w => {
            const isStudied = studied.has(String(w.id));
            return isStudied
                ? `<div class="word-item">
                    <span class="word-zh">${w.hanzi}</span>
                    <div style="flex:1"><div class="word-pinyin">${w.pinyin}</div><div class="word-meaning">${w.meaning}</div></div>
                    <span class="word-level" style="background:rgba(16,185,129,.1);color:#059669;border-color:rgba(16,185,129,.2)">✓ Đã học</span>
                   </div>`
                : `<div class="word-item word-item-clickable" onclick="navigateToFlashcard(${w.id})" style="cursor:pointer">
                    <span class="word-zh">${w.hanzi}</span>
                    <div style="flex:1"><div class="word-pinyin">${w.pinyin}</div><div class="word-meaning">${w.meaning}</div></div>
                    <span class="word-level word-badge-unlearned">Chưa học</span>
                   </div>`;
        }).join('');
        const hasMore = slice.length < all.length;
        pwEl.innerHTML = rows + (hasMore
            ? `<div style="text-align:center;padding:16px"><button class="btn btn-secondary" id="prog-load-more">Xem thêm (${all.length-slice.length} từ)</button></div>`
            : `<div style="text-align:center;padding:16px;font-size:13px;color:var(--text3)">Đã hiển thị tất cả ${all.length} từ</div>`);
        if (hasMore) document.getElementById('prog-load-more').addEventListener('click', () => { page++; renderWordPage(); });
    }
    renderWordPage();
}

function formatStudyTime(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    if (m < 1) return '0m';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m/60), rm = m%60;
    return rm > 0 ? `${h}h${rm}m` : `${h}h`;
}
