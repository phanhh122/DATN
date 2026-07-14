// chatbot/chatbot.js
// ════════════════════════════════════════════════════════════════
//  AI Chatbot với Intent Detection Pipeline
//
//  Luồng xử lý mỗi tin nhắn:
//    User input
//      → detectIntent()      — phân loại ý định (regex + heuristic)
//      → buildPrompt()       — xây prompt có cấu trúc theo intent
//      → POST /api/chat      — gọi Gemini (có cache phía server)
//      → renderResponse()    — hiển thị kết quả + intent badge
//
//  Intent types:
//    vocab     — tra nghĩa từ/cụm từ tiếng Trung
//    grammar   — hỏi về cấu trúc ngữ pháp
//    correct   — nhờ sửa câu / kiểm tra lỗi
//    quiz      — yêu cầu ra đề / luyện tập
//    roleplay  — hội thoại thực tế
//    general   — câu hỏi chung
// ════════════════════════════════════════════════════════════════
import { getToken } from '../auth/auth.js';
import { speakText, stopSpeech } from '../components/tts.js';
import { showToast } from '../components/toast.js';

let _mode    = 'explain';
let _loading = false;
let _inited  = false;
let _history = []; // conversation context (tối đa 6 lượt gần nhất)

// ── Intent definitions ──
const INTENTS = {
    vocab: {
        label: 'Tra từ',
        color: '#3498db',
        // Từ/câu tiếng Trung thuần hoặc hỏi nghĩa
        test: t => /^[\u4e00-\u9fff\s·，。！？、；：""''（）《》]+$/.test(t.trim()) ||
                   /nghĩa|có nghĩa|là gì|dịch|translate/i.test(t),
    },
    grammar: {
        label: ' Ngữ pháp',
        color: '#9b59b6',
        test: t => /ngữ pháp|cấu trúc|grammar|用法|怎么用|句型|把|被|得|了|过|着|比|虽然|因为|所以|如果|虽|既然|不但|而且/i.test(t),
    },
    correct: {
        label: 'Sửa câu',
        color: '#e67e22',
        test: t => /sửa|chữa|đúng không|lỗi|sai|correct|check|kiểm tra câu|câu này có/i.test(t) ||
                   (t.length > 8 && /[\u4e00-\u9fff]/.test(t) && /[，。！？]/.test(t)),
    },
    quiz: {
        label: 'Luyện tập',
        color: '#27ae60',
        test: t => /quiz|bài tập|ra đề|câu hỏi|luyện|đề|test|practice|cho.*ví dụ|出题|练习/i.test(t),
    },
    roleplay: {
        label: 'Hội thoại',
        color: '#e74c3c',
        test: t => /roleplay|hội thoại|nói chuyện|đàm thoại|tình huống|conversation|在.*吗|你好|请问|我想/i.test(t) ||
                   _mode === 'roleplay',
    },
};

function detectIntent(text) {
    for (const [key, def] of Object.entries(INTENTS)) {
        if (def.test(text)) return key;
    }
    return 'general';
}

// ── Prompt builders theo intent ──
const PROMPT_BUILDERS = {
    vocab(text) {
        return {
            system: `Bạn là từ điển tiếng Trung thông minh. Khi nhận được từ/cụm từ, hãy trả lời theo đúng cấu trúc sau (văn bản thuần, không dùng ký hiệu markdown):

TỪ: [từ]
PINYIN: [phiên âm]
NGHĨA: [nghĩa tiếng Việt]
LOẠI TỪ: [danh từ/động từ/tính từ/...]
CẤP HSK: [HSK 1-6 hoặc ngoài HSK]
VÍ DỤ: [câu ví dụ tiếng Trung]
PINYIN VÍ DỤ: [phiên âm câu ví dụ]
DỊCH VÍ DỤ: [nghĩa tiếng Việt]
MẸO NHỚ: [1 mẹo ghi nhớ ngắn gọn]

Chỉ trả lời theo cấu trúc trên, không thêm nội dung khác.`,
            message: text,
        };
    },
    grammar(text) {
        return {
            system: `Bạn là giáo viên ngữ pháp tiếng Trung. Giải thích ngữ pháp bằng tiếng Việt theo cấu trúc:

CẤU TRÚC: [mô tả cấu trúc]
CÔNG THỨC: [S + V + O...]
Ý NGHĨA: [giải thích dễ hiểu]
VÍ DỤ 1: [câu tiếng Trung] — [nghĩa]
VÍ DỤ 2: [câu tiếng Trung] — [nghĩa]
LƯU Ý: [điểm dễ sai]

Không dùng markdown, chỉ văn bản thuần.`,
            message: text,
        };
    },
    correct(text) {
        return {
            system: `Bạn là giáo viên sửa lỗi tiếng Trung. Phân tích câu theo cấu trúc:

ĐÁNH GIÁ: [Đúng / Sai / Cần cải thiện]
LỖI: [mô tả lỗi nếu có, hoặc "Không có lỗi"]
CÂU ĐÚNG: [câu đã sửa]
GIẢI THÍCH: [lý do sửa]
CÂU TƯƠNG TỰ: [1 câu ví dụ đúng cùng mẫu]

Không dùng markdown, chỉ văn bản thuần. Trả lời bằng tiếng Việt.`,
            message: text,
        };
    },
    quiz(text) {
        return {
            system: `Bạn là giáo viên tiếng Trung tạo bài tập. Tạo 3 câu hỏi trắc nghiệm theo cấu trúc:

CÂU 1: [câu hỏi]
A. [đáp án]  B. [đáp án]  C. [đáp án]  D. [đáp án]
ĐÁP ÁN: [chữ cái]

(lặp lại cho câu 2 và 3)

Bám sát nội dung/cấp độ người dùng yêu cầu. Không dùng markdown.`,
            message: text,
        };
    },
    roleplay(text) {
        return {
            system: `Bạn là người bản ngữ tiếng Trung trong tình huống hội thoại thực tế. Hãy:
1. Phản hồi tự nhiên bằng tiếng Trung (phù hợp trình độ người học)
2. Thêm Pinyin ngay sau câu tiếng Trung
3. Dịch nghĩa tiếng Việt
4. Đặt 1 câu hỏi gợi mở để duy trì hội thoại
Không dùng markdown.`,
            message: text,
        };
    },
    general(text) {
        return {
            system: `Bạn là gia sư tiếng Trung thân thiện. Trả lời câu hỏi bằng tiếng Việt, rõ ràng và dễ hiểu. Không dùng markdown, không dùng ký hiệu **, *, #.`,
            message: text,
        };
    },
};

// ── Suggestions ──
const SUGGESTIONS = {
    explain: [
        { zh: '把字句怎么用？', label: 'Cách dùng câu "把"' },
        { zh: '学习', label: 'Tra từ 学习' },
        { zh: '我明天去学校', label: 'Kiểm tra câu này' },
        { zh: '给我出3道HSK2题', label: 'Ra đề HSK 2' },
    ],
    correct: [
        { zh: '我很喜欢的她', label: 'Sửa câu này' },
        { zh: '他明天会去不去？', label: 'Câu hỏi có sai không?' },
        { zh: '我吃了饭已经', label: 'Trật tự từ đúng chưa?' },
    ],
    roleplay: [
        { zh: '你好，我想订一个房间', label: 'Đặt phòng khách sạn' },
        { zh: '请问这个多少钱？', label: 'Hỏi giá ở chợ' },
        { zh: '我想点一碗牛肉面', label: 'Gọi đồ ở nhà hàng' },
    ],
};

const QUICK_SUGGESTIONS = [
    { zh: '被字句是什么？', tip: 'Câu bị động tiếng Trung' },
    { zh: '比较级怎么说？', tip: 'Cách so sánh hơn' },
    { zh: '给我出题考HSK3', tip: 'Luyện đề HSK 3' },
    { zh: '在机场用中文怎么说', tip: 'Tình huống sân bay' },
    { zh: '请再说一遍', tip: 'Roleplay: nhờ nhắc lại' },
    { zh: '这句话对吗：我很高兴你', tip: 'Sửa lỗi câu' },
];

export function initChatbot() {
    if (!_inited) {
        setupInput();
        renderQuickSuggestions();
        _inited = true;
    }
    renderSuggestionChips();
}

function setupInput() {
    const input = document.getElementById('chat-input');
    if (!input) return;
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    });
    input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 160) + 'px';
        // Live intent preview
        const preview = document.getElementById('chat-intent-preview');
        if (preview) {
            const intent = detectIntent(input.value.trim());
            if (input.value.trim() && intent !== 'general') {
                const def = INTENTS[intent] || {};
                preview.textContent = `Phát hiện: ${def.label || intent}`;
                preview.style.color = def.color || 'var(--muted)';
                preview.style.display = 'block';
            } else {
                preview.style.display = 'none';
            }
        }
    });
}

export function setChatMode(mode) {
    _mode = mode;
    document.querySelectorAll('.chat-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    renderSuggestionChips();
}

function renderSuggestionChips() {
    const el = document.getElementById('chat-suggestion-chips');
    if (!el) return;
    const list = SUGGESTIONS[_mode] || SUGGESTIONS.explain;
    el.innerHTML = list.map(s =>
        `<button class="chat-suggestion-chip" onclick="window._chatInsert('${esc(s.zh)}')">${s.zh} — ${s.label}</button>`
    ).join('');
}

function renderQuickSuggestions() {
    const el = document.getElementById('suggestion-list');
    if (!el) return;
    el.innerHTML = QUICK_SUGGESTIONS.map(s =>
        `<div class="suggestion-item" onclick="window._chatInsert('${esc(s.zh)}')">
            <div class="suggestion-zh">${s.zh}</div>
            <div style="font-size:12px;color:var(--text3);margin-top:3px">${s.tip}</div>
        </div>`
    ).join('');
}

window._chatInsert = function(text) {
    const inp = document.getElementById('chat-input');
    if (inp) { inp.value = text; inp.focus(); inp.dispatchEvent(new Event('input')); }
};

export async function sendChat() {
    const inp  = document.getElementById('chat-input');
    const text = inp?.value.trim();
    if (!text || _loading) return;

    // ── Step 1: Detect Intent ──
    const intent = detectIntent(text);
    const intentDef = INTENTS[intent] || { label: '<i class="fa-solid fa-comments"></i> Chung', color: 'var(--muted)' };

    appendMessage('user', text);
    inp.value = '';
    inp.style.height = 'auto';
    const preview = document.getElementById('chat-intent-preview');
    if (preview) preview.style.display = 'none';

    _loading = true;
    document.getElementById('chat-send-btn').disabled = true;
    const typingId = appendTyping(intentDef);

    // ── Step 2: Build structured prompt ──
    const builder = PROMPT_BUILDERS[intent] || PROMPT_BUILDERS.general;
    const { system, message } = builder(text);

    // ── Step 3: Send to backend (Gemini + cache) ──
    try {
        const res = await fetch(`${window.API}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
            body: JSON.stringify({ message, system, intent }),
        });
        removeTyping(typingId);
        if (!res.ok) throw new Error('Server error');
        const data = await res.json();

        // ── Step 4: Render response with intent badge ──
        appendMessage('bot', data.reply || 'Xin lỗi, có lỗi xảy ra.', intentDef, data.cached);

        // Update history (tối đa 6 lượt)
        _history.push({ role:'user', text }, { role:'bot', text: data.reply });
        if (_history.length > 12) _history = _history.slice(-12);

    } catch {
        removeTyping(typingId);
        appendMessage('bot', '<i class="fa-solid fa-exclamation-triangle"></i> Không thể kết nối máy chủ. Vui lòng thử lại.');
    }

    _loading = false;
    document.getElementById('chat-send-btn').disabled = false;
}

function appendMessage(role, text, intentDef, cached) {
    const el = document.getElementById('chat-messages');
    const id = 'msg-' + Date.now();
    const isBot = role === 'bot';
    const safeText = text.replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');

    const intentBadge = (isBot && intentDef)
        ? `<span class="intent-badge" style="background:${intentDef.color}20;color:${intentDef.color};border:1px solid ${intentDef.color}40">${intentDef.label}${cached ? ' · cache' : ''}</span>`
        : '';

    const actions = isBot ? `
        <div class="message-actions">
            <button class="msg-action-btn" onclick="window._copyMsg('${esc(text)}')"><i class="fa-solid fa-copy"></i> Sao chép</button>
            <button class="msg-action-btn" onclick="window._speakMsg(this,'${esc(text)}')"><i class="fa-solid fa-volume-up"></i> Nghe</button>
        </div>` : '';

    el.insertAdjacentHTML('beforeend', `
        <div class="message ${role}" id="${id}">
            <div class="message-avatar">${isBot ? '汉' : '你'}</div>
            <div class="message-content">
                ${intentBadge}
                <div class="message-bubble">${safeText}</div>
                ${actions}
            </div>
        </div>`);
    scrollChat();
    return id;
}

function appendTyping(intentDef) {
    const el = document.getElementById('chat-messages');
    const id = 'typing-' + Date.now();
    const badge = intentDef
        ? `<span class="intent-badge" style="background:${intentDef.color}20;color:${intentDef.color};border:1px solid ${intentDef.color}40;display:inline-block;margin-bottom:6px">${intentDef.label}</span><br>`
        : '';
    el.insertAdjacentHTML('beforeend', `
        <div class="message bot" id="${id}">
            <div class="message-avatar">汉</div>
            <div class="message-content">
                ${badge}
                <div class="chat-typing">
                    <div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>
                </div>
            </div>
        </div>`);
    scrollChat();
    return id;
}

function removeTyping(id) { document.getElementById(id)?.remove(); }
function scrollChat() { const el=document.getElementById('chat-messages'); if(el) el.scrollTop=el.scrollHeight; }

window._copyMsg = function(text) {
    navigator.clipboard.writeText(text).then(() => showToast('Đã sao chép!','success'));
};
window._speakMsg = function(btn, text) {
    const zh = (text.match(/[\u4e00-\u9fff\uff00-\uffef，。！？、；：""''【】（）《》]+/g)||[]).join('');
    speakText(zh||text);
    btn.textContent='⏹ Dừng';
    btn.onclick=function(){ stopSpeech(); btn.textContent='<i class="fa-solid fa-volume-up"></i> Nghe'; btn.onclick=function(){ window._speakMsg(btn,text); }; };
};

function esc(s){ return (s||'').replace(/'/g,"\\'").replace(/\n/g,' '); }
