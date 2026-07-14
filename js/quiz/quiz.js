// quiz/quiz.js
import { saveQuizResult, getStudied, recordStudyDay } from '../storage/storage.js';
import { speakText } from '../components/tts.js';

let _words    = [];
let _pool     = [];
let _questions= [];
let _qi       = 0;
let _score    = 0;
let _mode     = 'all';
let _levels   = new Set(); // start empty, user must select
let _answered = false;

export function initQuiz() {
    _words = window._allWords || [];
}

export function setQuizMode(mode) {
    _mode = mode;
    // Cập nhật UI tab active
    document.querySelectorAll('#quiz-mode-tabs .tab-btn').forEach(b => {
        const btnMode = b.getAttribute('onclick')?.match(/setQuizMode\('(\w+)'\)/)?.[1];
        b.classList.toggle('active', btnMode === mode);
    });
}

export function setQuizLevel(lvl) {
    // Toggle in set
    if (_levels.has(lvl)) _levels.delete(lvl);
    else _levels.add(lvl);
    document.querySelectorAll('#quiz-level-tabs .tab-btn').forEach(b => {
        const l = parseInt(b.textContent.replace('HSK ',''));
        b.classList.toggle('active', _levels.has(l));
    });
}

export function beginQuiz() {
    if (_levels.size === 0) {
        alert('Vui lòng chọn ít nhất một cấp độ HSK để bắt đầu!');
        return;
    }
    let pool = _words.filter(w => _levels.has(Number(w.difficulty)));
    if (_mode === 'studied') {
        const studied = getStudied(); // đã là Set<String>
        pool = pool.filter(w => studied.has(String(w.id)));
        if (pool.length < 4) {
            alert(`Bạn mới học ${pool.length} từ ở cấp độ đã chọn. Cần ít nhất 4 từ để làm bài. Hãy học thêm flashcard!`);
            return;
        }
    }
    if (pool.length < 4) {
        alert('Cần ít nhất 4 từ vựng trong nhóm đã chọn. Hãy chọn thêm cấp độ HSK!');
        return;
    }

    // Build questions — đảm bảo luôn đủ 10 câu
    // Nếu pool ít hơn 10 từ → lặp lại pool để đủ số câu (không slice cứng)
    shuffle(pool);
    const TARGET = 10;
    const questionPool = pool.length >= TARGET
        ? pool.slice(0, TARGET)
        : [...pool, ...pool, ...pool].slice(0, TARGET); // lặp nếu ít từ

    _questions = questionPool.map(correct => {
        // Lấy distractors từ toàn bộ pool (loại từ đúng ra)
        const distractors = pool.filter(w => w.id !== correct.id);
        if (distractors.length < 3) {
            // Fallback: dùng lại pool nếu quá ít từ
            const all = pool.filter(w => w.id !== correct.id);
            while (all.length < 3) all.push(...pool.filter(w => w.id !== correct.id));
            shuffle(all);
            return { correct, opts: shuffle([correct, ...all.slice(0, 3)]) };
        }
        shuffle(distractors);
        return { correct, opts: shuffle([correct, ...distractors.slice(0, 3)]) };
    });

    _qi = 0; _score = 0;
    document.getElementById('quiz-setup').style.display  = 'none';
    document.getElementById('quiz-active').style.display = 'block';
    document.getElementById('quiz-result').style.display = 'none';
    renderQuestion();
    recordStudyDay();
}

function renderQuestion() {
    if (_qi >= _questions.length) { showResult(); return; }
    const q = _questions[_qi];
    _answered = false;

    document.getElementById('q-num').textContent      = _qi + 1;
    document.getElementById('q-score').textContent    = _score;
    document.getElementById('q-progress').style.width = ((_qi + 1) / _questions.length * 100) + '%';
    document.getElementById('q-hanzi').textContent    = q.correct.hanzi;

    const type = Math.random() > 0.5 ? 'meaning' : 'hanzi';
    document.getElementById('q-label').textContent = type === 'meaning'
        ? 'Chọn nghĩa đúng của từ trên'
        : 'Chọn cách đọc Pinyin đúng';

    const optEl = document.getElementById('q-options');
    optEl.innerHTML = q.opts.map((w, i) => `
        <button class="quiz-option" onclick="window._answerQuiz(${i})" data-idx="${i}">
            ${type === 'meaning' ? w.meaning : w.pinyin}
        </button>`).join('');

    // Auto-speak question
    setTimeout(() => speakText(q.correct.hanzi), 200);
}

window._answerQuiz = function(idx) {
    if (_answered) return;
    _answered = true;
    const q       = _questions[_qi];
    const chosen  = q.opts[idx];
    const correct = q.correct;
    const isRight = chosen.id === correct.id;

    if (isRight) _score++;

    // Log attempt lên server để phân tích điểm yếu (fire-and-forget)
    const token = _getToken();
    if (token) {
        fetch(`${window.API}/api/quiz/attempt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ word_id: correct.id, is_correct: isRight })
        }).catch(() => {});
    }

    const btns = document.querySelectorAll('.quiz-option');
    btns.forEach((b, i) => {
        if (q.opts[i].id === correct.id) b.classList.add('correct');
        else if (i === idx && !isRight) b.classList.add('wrong');
        b.disabled = true;
    });

    setTimeout(() => {
        _qi++;
        renderQuestion();
    }, 1200);
};

function showResult() {
    document.getElementById('quiz-active').style.display = 'none';
    document.getElementById('quiz-result').style.display = 'block';
    document.getElementById('quiz-setup').style.display  = 'none';

    const total = _questions.length;
    const pct   = Math.round(_score / total * 100);
    let label   = pct >= 90 ? '<i class="fa-solid fa-trophy"></i> Xuất sắc!' : pct >= 70 ? '<i class="fa-solid fa-thumbs-up"></i> Làm tốt lắm!' : pct >= 50 ? '<i class="fa-solid fa-book"></i> Cần luyện thêm!' : '<i class="fa-solid fa-heart"></i> Hãy cố gắng hơn!';

    document.getElementById('result-score').textContent = `${_score}/${total}`;
    document.getElementById('result-label').innerHTML = label;
    document.getElementById('result-accuracy').textContent = `Độ chính xác: ${pct}%`;
    saveQuizResult(_score, total, [..._levels].join(','));
}

// FIX: exported so HTML can call it — resets quiz state and shows setup screen
// keeping the previously selected levels intact so user can retry immediately
export function restartQuiz() {
    _qi = 0; _score = 0; _questions = [];
    document.getElementById('quiz-result').style.display = 'none';
    document.getElementById('quiz-active').style.display = 'none';
    document.getElementById('quiz-setup').style.display  = 'block';
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function _getToken() {
    try { return JSON.parse(localStorage.getItem('hsk_user'))?.token || null; } catch { return null; }
}
