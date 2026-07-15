import { showToast } from '../components/toast.js';
import { speakText } from '../components/tts.js';
import { getToken } from '../auth/auth.js';
import { saveQuizResult, getQuizHistory } from '../storage/storage.js';

const HSK_STRUCTURE = {
    1: { vocab: 0.55, pinyin: 0.35, reverse: 0.10, grammar: 0.00 },
    2: { vocab: 0.45, pinyin: 0.25, reverse: 0.30, grammar: 0.00 },
    3: { vocab: 0.35, pinyin: 0.15, reverse: 0.20, grammar: 0.30 },
    4: { vocab: 0.30, pinyin: 0.10, reverse: 0.25, grammar: 0.35 },
    5: { vocab: 0.25, pinyin: 0.10, reverse: 0.25, grammar: 0.40 },
    6: { vocab: 0.20, pinyin: 0.05, reverse: 0.30, grammar: 0.45 },
};

// Tỉ lệ mặc định khi chọn nhiều cấp trộn nhau
const MIX_STRUCTURE = { vocab: 0.35, pinyin: 0.15, reverse: 0.25, grammar: 0.25 };

const EXAM_SECONDS_PER_Q = 60; // 60 giây / câu

let _questions   = [];
let _answers     = {};   // { qi: optionIndex }
let _currentQ    = 0;
let _timerID     = null;
let _timeLeft    = 0;
let _started     = false;
let _selectedLevels = new Set();
let _questionCount  = 10;

export function initExam() {
    _started = false;
    _selectedLevels = new Set();
    showExamSection('exam-setup');
    // Reset level buttons
    document.querySelectorAll('.exam-level-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.exam-count-btn').forEach(b =>
        b.classList.toggle('active', parseInt(b.dataset.count) === _questionCount));
    updateStartButton();
    renderExamHistory();
    renderStructurePreview();
}

// ── Setup controls ────────────────────────────────────────────
export function toggleExamLevel(lvl) {
    if (_selectedLevels.has(lvl)) _selectedLevels.delete(lvl);
    else _selectedLevels.add(lvl);
    document.querySelectorAll('.exam-level-btn').forEach(b =>
        b.classList.toggle('active', _selectedLevels.has(parseInt(b.dataset.level))));
    updateStartButton();
    renderStructurePreview();
}

export function setExamCount(n) {
    _questionCount = n;
    document.querySelectorAll('.exam-count-btn').forEach(b =>
        b.classList.toggle('active', parseInt(b.dataset.count) === n));
}

function updateStartButton() {
    const btn = document.getElementById('exam-start-btn');
    if (btn) btn.disabled = _selectedLevels.size === 0;
}

// ── Hiển thị preview cấu trúc đề theo cấp đã chọn ───────────
function renderStructurePreview() {
    const el = document.getElementById('exam-structure-preview');
    if (!el) return;
    if (!_selectedLevels.size) { el.innerHTML = ''; return; }

    const isMix = _selectedLevels.size > 1;
    let struct;
    if (isMix) {
        // Trung bình có trọng số các cấp đã chọn
        const keys = ['vocab','pinyin','reverse','grammar'];
        struct = Object.fromEntries(keys.map(k => [k, 0]));
        _selectedLevels.forEach(l => {
            const s = HSK_STRUCTURE[l] || MIX_STRUCTURE;
            keys.forEach(k => struct[k] += (s[k] || 0) / _selectedLevels.size);
        });
    } else {
        const lvl = [..._selectedLevels][0];
        struct = HSK_STRUCTURE[lvl] || MIX_STRUCTURE;
    }

    const typeLabels = { vocab:'词义 Chọn nghĩa', pinyin:'拼音 Chọn Pinyin', reverse:'汉字 Chọn Hán tự', grammar:'语法 Điền vào chỗ trống' };
    const typeColors = { vocab:'#3498db', pinyin:'#9b59b6', reverse:'#27ae60', grammar:'#e67e22' };

    const title = isMix
        ? `Cấu trúc đề thi (tổng hợp HSK ${[..._selectedLevels].sort().join('+')})`
        : `Cấu trúc đề thi HSK ${[..._selectedLevels][0]}`;

    el.innerHTML = `<div style="font-size:13px;font-weight:600;margin-bottom:10px;color:var(--text)">${title}</div>` +
        Object.entries(struct)
            .filter(([,v]) => v > 0.01)
            .sort((a,b) => b[1]-a[1])
            .map(([k, v]) => {
                const pct = Math.round(v * 100);
                const count = Math.round(v * _questionCount);
                return `<div style="margin-bottom:8px">
                    <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
                        <span style="color:${typeColors[k]};font-weight:600">${typeLabels[k]}</span>
                        <span style="color:var(--muted)">${pct}% · ~${count} câu</span>
                    </div>
                    <div style="height:6px;border-radius:3px;background:var(--border)">
                        <div style="height:6px;border-radius:3px;background:${typeColors[k]};width:${pct}%;transition:width .4s"></div>
                    </div>
                </div>`;
            }).join('');
}

// ── Tạo đề thi theo cấu trúc HSK ─────────────────────────────
function buildExamQuestions(pool, allWords) {
    const isMix = _selectedLevels.size > 1;
    let struct;
    if (isMix) {
        const keys = ['vocab','pinyin','reverse','grammar'];
        struct = Object.fromEntries(keys.map(k => [k, 0]));
        _selectedLevels.forEach(l => {
            const s = HSK_STRUCTURE[l] || MIX_STRUCTURE;
            keys.forEach(k => struct[k] += (s[k]||0) / _selectedLevels.size);
        });
    } else {
        const lvl = [..._selectedLevels][0];
        struct = HSK_STRUCTURE[lvl] || MIX_STRUCTURE;
    }

    // Phân bổ số câu theo tỉ lệ (làm tròn, đảm bảo tổng = _questionCount)
    const keys = Object.keys(struct).filter(k => struct[k] > 0.01);
    let counts = Object.fromEntries(keys.map(k => [k, Math.floor(struct[k] * _questionCount)]));
    let assigned = Object.values(counts).reduce((a,b)=>a+b, 0);
    // Phân phần dư cho loại có tỉ lệ lớn nhất
    const sorted = keys.sort((a,b) => struct[b]-struct[a]);
    let i = 0;
    while (assigned < _questionCount) { counts[sorted[i++ % sorted.length]]++; assigned++; }

    const shuffledPool = shuffle([...pool]);
    const used = new Set();
    const questions = [];

    for (const type of keys) {
        const n = counts[type];
        const distractorPool = allWords.filter(w => !_selectedLevels.has(Number(w.difficulty)) ? false : true);

        for (let qi = 0; qi < n && used.size < shuffledPool.length; qi++) {
            // Lấy từ chưa dùng
            let correct = null;
            for (const w of shuffledPool) {
                if (!used.has(w.id)) { correct = w; used.add(w.id); break; }
            }
            if (!correct) break;

            const distractors = shuffle(allWords.filter(w => w.id !== correct.id)).slice(0, 3);
            if (distractors.length < 3) continue;

            if (type === 'grammar') {
                const q = buildGrammarQuestion(correct, distractors);
                if (q) { questions.push(q); continue; }
                // Fallback to vocab if can't build grammar
            }

            questions.push({
                type,
                correct,
                opts: shuffle([correct, ...distractors]),
            });
        }
    }

    return shuffle(questions).slice(0, _questionCount);
}

function buildGrammarQuestion(correct, distractors) {
    const ex = correct.example || correct.example_sentence || '';
    if (!ex || !ex.includes(correct.hanzi)) return null;
    const blank = ex.replace(correct.hanzi, '___');
    return {
        type: 'grammar',
        correct,
        opts: shuffle([correct, ...distractors]),
        sentence: blank,
        sentence_meaning: correct.example_meaning || '',
    };
}

// ── Bắt đầu thi ───────────────────────────────────────────────
export function startExam() {
    const allWords = window._allWords || [];
    let pool = _selectedLevels.size
        ? allWords.filter(w => _selectedLevels.has(Number(w.difficulty)))
        : allWords;

    if (pool.length < 4) {
        showToast('Cần ít nhất 4 từ ở cấp độ đã chọn!', 'error');
        return;
    }

    _questions = buildExamQuestions(pool, allWords);
    if (!_questions.length) { showToast('Không đủ từ để tạo đề!', 'error'); return; }

    _answers  = {};
    _currentQ = 0;
    _timeLeft = _questions.length * EXAM_SECONDS_PER_Q;
    _started  = true;

    showExamSection('exam-active');
    renderExamQuestion();
    startTimer();
}

// ── Render câu hỏi ─────────────────────────────────────────────
function renderExamQuestion() {
    if (_currentQ >= _questions.length) return;
    const q = _questions[_currentQ];

    document.getElementById('exam-q-num').textContent   = _currentQ + 1;
    document.getElementById('exam-q-total').textContent = _questions.length;

    const typeLabels = {
        vocab:   '词义 — Chọn nghĩa đúng:',
        pinyin:  '拼音 — Chọn cách đọc Pinyin đúng:',
        reverse: '汉字 — Chọn từ Hán tự đúng:',
        grammar: '语法 — Chọn từ điền vào chỗ trống:',
    };
    document.getElementById('exam-q-label').textContent = typeLabels[q.type] || '';

    // Phần thân câu hỏi
    const bodyEl = document.getElementById('exam-q-body');
    if (q.type === 'grammar') {
        bodyEl.innerHTML = `
            <div style="font-size:22px;font-weight:600;letter-spacing:2px;margin-bottom:8px">${q.sentence}</div>
            ${q.sentence_meaning ? `<div style="font-size:13px;color:var(--muted)">${q.sentence_meaning.replace(q.correct.meaning||'', '___')}</div>` : ''}`;
    } else if (q.type === 'reverse') {
        bodyEl.innerHTML = `<div style="font-size:20px;font-weight:600;color:var(--primary)">${q.correct.meaning}</div>
            <div style="font-size:13px;color:var(--muted);margin-top:4px">${q.correct.pinyin}</div>`;
    } else {
        bodyEl.innerHTML = `<div style="font-size:52px;font-weight:700;letter-spacing:4px;color:var(--primary)">${q.correct.hanzi}</div>`;
        setTimeout(() => speakText(q.correct.hanzi), 150);
    }

    // Options
    const optEl = document.getElementById('exam-options');
    optEl.innerHTML = q.opts.map((w, i) => {
        const chosen  = _answers[_currentQ] === i;
        let optText;
        if (q.type === 'vocab') optText = w.meaning;
        else if (q.type === 'pinyin') optText = w.pinyin;
        else if (q.type === 'reverse') optText = w.hanzi;
        else optText = w.hanzi; // grammar
        return `<button class="exam-option ${chosen ? 'selected' : ''}" onclick="selectExamAnswer(${i})">
            <span class="exam-opt-letter">${'ABCD'[i]}</span>
            <span>${optText}</span>
        </button>`;
    }).join('');

    // Nav pills
    const nav = document.getElementById('exam-question-nav');
    if (nav) {
        nav.innerHTML = _questions.map((qq, i) => {
            const typeColors = { vocab:'#3498db', pinyin:'#9b59b6', reverse:'#27ae60', grammar:'#e67e22' };
            const answered = _answers[i] !== undefined;
            const current  = i === _currentQ;
            return `<button class="exam-nav-pill ${current?'current':answered?'answered':''}"
                style="${answered && !current ? 'border-color:'+typeColors[qq.type] : ''}"
                onclick="goToExamQuestion(${i})" title="${qq.type}">${i+1}</button>`;
        }).join('');
    }

    document.getElementById('exam-prev-btn').disabled = _currentQ === 0;
    document.getElementById('exam-next-btn').textContent =
        _currentQ === _questions.length - 1 ? 'Nộp bài' : 'Tiếp →';
}

export function selectExamAnswer(idx) { _answers[_currentQ] = idx; renderExamQuestion(); }
export function goToExamQuestion(idx) { _currentQ = idx; renderExamQuestion(); }
export function prevExamQuestion() { if (_currentQ > 0) { _currentQ--; renderExamQuestion(); } }

export function nextExamQuestion() {
    if (_currentQ < _questions.length - 1) { _currentQ++; renderExamQuestion(); }
    else {
        const remaining = _questions.length - Object.keys(_answers).length;
        if (remaining > 0 && !confirm(`Còn ${remaining} câu chưa trả lời. Xác nhận nộp bài?`)) return;
        submitExam();
    }
}

// ── Timer ─────────────────────────────────────────────────────
function startTimer() {
    clearInterval(_timerID);
    updateTimerUI();
    _timerID = setInterval(() => {
        _timeLeft--;
        updateTimerUI();
        if (_timeLeft <= 0) { clearInterval(_timerID); showToast('Hết giờ!', 'info'); submitExam(); }
    }, 1000);
}

function updateTimerUI() {
    const el = document.getElementById('exam-timer');
    if (!el) return;
    const m = Math.floor(_timeLeft / 60), s = _timeLeft % 60;
    el.textContent = `⏱ ${m}:${s.toString().padStart(2,'0')}`;
    el.style.color = _timeLeft < 120 ? '#e74c3c' : _timeLeft < 300 ? '#e67e22' : 'var(--text)';
}

// ── Chấm điểm + kết quả ───────────────────────────────────────
function submitExam() {
    clearInterval(_timerID);
    _started = false;

    let correct = 0;
    const wrongList = [];
    const typeStats = {};

    _questions.forEach((q, i) => {
        const chosen = _answers[i];
        const isCorrect = chosen !== undefined && q.opts[chosen]?.id === q.correct.id;
        if (!typeStats[q.type]) typeStats[q.type] = { total:0, correct:0 };
        typeStats[q.type].total++;
        if (isCorrect) { correct++; typeStats[q.type].correct++; }
        else wrongList.push({ q, chosen });
    });

    const total    = _questions.length;
    const score    = Math.round((correct / total) * 100);
    const timeUsed = _questions.length * EXAM_SECONDS_PER_Q - _timeLeft;

    const grade = score >= 90 ? { zh:'优秀', vi:'Xuất sắc', color:'#27ae60' }
                : score >= 75 ? { zh:'良好', vi:'Tốt',       color:'#3498db' }
                : score >= 60 ? { zh:'及格', vi:'Đạt',       color:'#e67e22' }
                :               { zh:'不及格',vi:'Chưa đạt',  color:'#e74c3c' };

    saveQuizResult(correct, total, [..._selectedLevels].sort().join('+'), 'exam');
    renderExamHistory();
    showToast('Đã lưu vào lịch sử thi', 'success');
    showExamSection('exam-result');
    document.getElementById('exam-result-score').textContent  = score;
    document.getElementById('exam-result-grade').textContent  = `${grade.zh} — ${grade.vi}`;
    document.getElementById('exam-result-grade').style.color  = grade.color;
    document.getElementById('exam-result-correct').textContent= `${correct}/${total}`;
    document.getElementById('exam-result-time').textContent   = formatTime(timeUsed);
    document.getElementById('exam-result-levels').textContent =
        [..._selectedLevels].sort().map(l=>`HSK${l}`).join('+') || 'Tất cả';

    // Breakdown theo loại câu
    const breakdownEl = document.getElementById('exam-type-breakdown');
    if (breakdownEl) {
        const typeLabels = { vocab:'词义', pinyin:'拼音', reverse:'汉字', grammar:'语法' };
        const typeColors = { vocab:'#3498db', pinyin:'#9b59b6', reverse:'#27ae60', grammar:'#e67e22' };
        breakdownEl.innerHTML = Object.entries(typeStats).map(([type, s]) => {
            const pct = Math.round(s.correct/s.total*100);
            return `<div style="text-align:center;padding:10px;background:${typeColors[type]}15;border-radius:10px;border:1px solid ${typeColors[type]}30">
                <div style="font-weight:700;color:${typeColors[type]}">${typeLabels[type]||type}</div>
                <div style="font-size:18px;font-weight:800">${pct}%</div>
                <div style="font-size:11px;color:var(--muted)">${s.correct}/${s.total}</div>
            </div>`;
        }).join('');
    }

    // Review câu sai
    const reviewEl = document.getElementById('exam-wrong-review');
    if (reviewEl) {
        reviewEl.innerHTML = !wrongList.length
            ? '<p style="color:#27ae60;font-weight:600;text-align:center;padding:16px"><i class="fa-solid fa-trophy"></i> Hoàn hảo! Không có câu sai.</p>'
            : wrongList.map(({q, chosen}) => {
                const chosenText = chosen !== undefined ? _getOptText(q, chosen) : '(bỏ qua)';
                const correctText = _getCorrectText(q);
                return `<div class="exam-wrong-item">
                    <div style="font-size:22px;font-weight:700;min-width:50px;text-align:center">${q.correct.hanzi}</div>
                    <div style="flex:1">
                        <div style="color:#e74c3c;font-size:13px">✗ Bạn chọn: <strong>${chosenText || '—'}</strong></div>
                        <div style="color:#27ae60;font-size:13px">✓ Đáp án đúng: <strong>${correctText}</strong></div>
                        <div style="font-size:11px;color:var(--muted);margin-top:2px">${q.correct.pinyin} · ${q.correct.meaning}</div>
                    </div>
                </div>`;
            }).join('');
    }

    // Log server
    const token = getToken();
    if (token) {
        _questions.forEach((q, i) => {
            const isCorrect = _answers[i] !== undefined && q.opts[_answers[i]]?.id === q.correct.id;
            fetch(`${window.API}/api/quiz/attempt`, {
                method:'POST',
                headers:{'Content-Type':'application/json', Authorization:`Bearer ${token}`},
                body: JSON.stringify({ word_id: q.correct.id, is_correct: isCorrect })
            }).catch(()=>{});
        });
    }
}

function _getOptText(q, idx) {
    const w = q.opts[idx];
    if (!w) return '';
    if (q.type === 'vocab') return w.meaning;
    if (q.type === 'pinyin') return w.pinyin;
    return w.hanzi;
}
function _getCorrectText(q) {
    if (q.type === 'vocab') return q.correct.meaning;
    if (q.type === 'pinyin') return q.correct.pinyin;
    return q.correct.hanzi;
}

function renderExamHistory() {
    const el = document.getElementById('exam-history');
    if (!el) return;
    const hist = getQuizHistory().filter(r => r.source === 'exam').slice().reverse();
    if (!hist.length) { el.innerHTML = '<p style="color:var(--muted);font-size:13px">Chưa có lịch sử thi.</p>'; return; }
    el.innerHTML = hist.slice(0, 5).map(r => {
        const d = new Date(r.date).toLocaleDateString('vi-VN');
        const pct = Math.round((r.score / r.total) * 100);
        const grade = pct >= 90 ? '优秀' : pct >= 75 ? '良好' : pct >= 60 ? '及格' : '不及格';
        const gc = grade==='优秀'?'#27ae60':grade==='良好'?'#3498db':grade==='及格'?'#e67e22':'#e74c3c';
        return `<div class="exam-history-item">
            <span>${d}</span><span>HSK ${r.level||'?'}</span>
            <span style="font-weight:700">${pct}/100</span>
            <span style="color:${gc};font-weight:600">${grade}</span>
        </div>`;
    }).join('');
}

export function retryExam()      { startExam(); }
export function backToExamSetup(){ showExamSection('exam-setup'); renderExamHistory(); renderStructurePreview(); }

function showExamSection(id) {
    ['exam-setup','exam-active','exam-result'].forEach(s => {
        const el = document.getElementById(s);
        if (el) el.style.display = s===id ? 'block' : 'none';
    });
}
function formatTime(s) { const m=Math.floor(s/60),sec=s%60; return `${m}p${sec.toString().padStart(2,'0')}s`; }
function shuffle(a) { for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a; }
