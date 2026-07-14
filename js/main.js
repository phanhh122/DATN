// main.js — Entry point
import { initAuth, logout as authLogout, getCurrentUser } from './auth/auth.js';
import { initDashboard } from './dashboard/dashboard.js';
import { initFlashcard, setFlashcardMode, setLevel, flipCard, prevCard, nextCard, markCard, toggleHideStudied, initStudied } from './flashcard/flashcard.js';
import { initSRS, flipSRSCard, rateSRSCard, restartSRS, waitForPendingSRSReviews } from './srs/srs.js';
import { initExam, toggleExamLevel, setExamCount, startExam, selectExamAnswer, goToExamQuestion, prevExamQuestion, nextExamQuestion, retryExam, backToExamSetup } from './exam/exam.js';
import { initSearch } from './search/search.js';
import { initQuiz, setQuizMode, setQuizLevel, beginQuiz, restartQuiz } from './quiz/quiz.js';
import { initProgress } from './progress/progress.js';
import { initChatbot, sendChat, setChatMode } from './chatbot/chatbot.js';
import { initProfile, saveProfile, changePassword, handleAvatarChange } from './profile/profile.js';
// Admin đã chuyển ra /admin/dashboard.html — không import ở đây nữa
import { showToast } from './components/toast.js';
import { speakText } from './components/tts.js';
import { startStudySession, endStudySession } from './storage/storage.js';

/* ── Global API base ── */
window.API = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ?
    'http://localhost:3000' :
    '';

/* ── Expose globals for inline onclick handlers ── */
window.toggleHideStudied = toggleHideStudied;
window.setFlashcardModeAll = function() {
    _currentLevel = 0;
    document.querySelectorAll('#view-flashcard .tab-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
    applyFilter();
};

// Practice hub: navigate thẳng tới quiz hoặc exam
window.switchPracticeMode = function(mode) {
    navigate(mode === 'quiz' ? 'quiz' : 'exam');
};

window.backToPracticeHub = function() {
    navigate('practice');
};
window.flipSRSCard  = flipSRSCard;
window.rateSRSCard  = rateSRSCard;
window.restartSRS   = restartSRS;
window.toggleExamLevel    = toggleExamLevel;
window.setExamCount       = setExamCount;
window.startExam          = startExam;
window.selectExamAnswer   = selectExamAnswer;
window.goToExamQuestion   = goToExamQuestion;
window.prevExamQuestion   = prevExamQuestion;
window.nextExamQuestion   = nextExamQuestion;
window.retryExam          = retryExam;
window.backToExamSetup    = backToExamSetup;
window.navigate = navigate;
window.logout = logout;
window.setFlashcardMode = setFlashcardMode;
window.setLevel = setLevel;
window.flipCard = flipCard;
window.prevCard = prevCard;
window.nextCard = nextCard;
window.markCard = markCard;
window.setQuizMode = setQuizMode;
window.setQuizLevel = setQuizLevel;
window.beginQuiz = beginQuiz;
window.restartQuiz = restartQuiz;
window.sendChat = sendChat;
window.setChatMode = setChatMode;
window.saveProfile = saveProfile;
window.changePassword = changePassword;
window.handleAvatarChange = handleAvatarChange;
// Admin globals removed — admin panel tách riêng tại /admin/
window.showToast = showToast;
window.speakText = speakText;

/* ── Router ── */
let currentView = 'dashboard';

// Các view được tính là "đang học" để đo thời gian học
const STUDY_VIEWS = ['flashcard', 'quiz', 'srs', 'exam', 'practice', 'studied'];

export async function navigate(view) {
    // FIX: rời trang "Ôn tập thông minh" (SRS) trong khi vẫn còn request
    // POST /api/srs/review đang ghi DB (rateSRSCard không await fetch để UI
    // mượt) → nếu đi thẳng sang Dashboard, GET /api/srs/stats có thể chạy
    // xong TRƯỚC khi review cuối cùng được lưu, khiến Dashboard hiển thị lại
    // số thẻ cần ôn cũ dù người dùng đã ôn hết. Đợi các review đó ghi xong
    // trước khi chuyển trang.
    if (currentView === 'srs' && view !== 'srs') {
        await waitForPendingSRSReviews();
    }

    // Kết thúc session học của view trước đó (nếu có)
    if (STUDY_VIEWS.includes(currentView) && currentView !== view) {
        endStudySession();
    }

    // Close sidebar on mobile
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('open');

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    const el = document.getElementById('view-' + view);
    if (el) el.classList.add('active');

    const navEl = document.querySelector(`.nav-item[data-view="${view}"]`);
    if (navEl) navEl.classList.add('active');

    currentView = view;

    // Lazy-init views
    switch (view) {
        case 'dashboard':
            initDashboard();
            break;
        case 'flashcard':
            initFlashcard();
            _loadSRSBanner();
            break;
        case 'studied':
            initStudied();
            break;
        case 'srs':
            initSRS();
            break;
        case 'practice':
            // Hub: không cần init riêng, chỉ show hub
            document.getElementById('practice-sub').style.display = 'none';
            document.querySelectorAll('.practice-mode-card').forEach(c => c.classList.remove('selected'));
            break;
        case 'exam':
            initExam();
            break;
        case 'search':
            initSearch();
            break;
        case 'quiz':
            initQuiz();
            break;
        case 'progress':
            initProgress();
            break;
        case 'chatbot':
            initChatbot();
            break;
        case 'profile':
            initProfile();
            break;
    }

    // Bắt đầu session mới nếu view này là view "đang học"
    if (STUDY_VIEWS.includes(view)) {
        startStudySession();
    }
}

// Khi tab bị ẩn (chuyển tab khác, minimize) → tạm dừng tính giờ,
// khi quay lại → tính tiếp một phiên mới để không cộng nhầm thời gian rời tab.
document.addEventListener('visibilitychange', () => {
    if (!STUDY_VIEWS.includes(currentView)) return;
    if (document.hidden) {
        endStudySession();
    } else {
        startStudySession();
    }
});

// Khi đóng tab / rời trang → chốt phiên học đang chạy để không mất dữ liệu
window.addEventListener('beforeunload', () => {
    if (STUDY_VIEWS.includes(currentView)) endStudySession();
});

function logout() {
    authLogout();
    document.getElementById('app').style.display = 'none';
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('landing-screen').style.display = 'block';
    window.scrollTo(0, 0);
}

/* ── Bootstrap ── */
async function boot() {
    // Auth init - passes callbacks
    await initAuth({
        onLogin: (user) => {
            document.getElementById('landing-screen').style.display = 'none';
            document.getElementById('auth-screen').style.display = 'none';
            document.getElementById('app').style.cssText = 'display:flex !important; flex-direction:row;';

            // Update sidebar user info
            document.getElementById('user-display-name').textContent = user.name || user.username;
            document.getElementById('user-display-role').textContent = user.role === 'admin' ? 'Quản trị viên' : 'Học viên';
            document.getElementById('welcome-name').textContent = user.name || user.username;

            // Avatar
            const avatarEl = document.getElementById('user-avatar');
            if (user.avatar) {
                avatarEl.innerHTML = `<img src="${user.avatar}" alt="avatar">`;
            } else {
                avatarEl.textContent = (user.name || user.username || 'U')[0].toUpperCase();
            }

            // Admin nav
            if (user.role === 'admin') {
                document.getElementById('admin-nav').style.display = 'block';
            }

            navigate('dashboard');
        }
    });

    window._authReady = true;
    if (window._pendingAuthTab) {
        window._switchAuthTabImpl(window._pendingAuthTab);
    }
}

// Hiện banner nhắc ôn FSRS khi vào flashcard nếu có thẻ đến hạn hôm nay
async function _loadSRSBanner() {
    const banner = document.getElementById('fc-srs-banner');
    const countEl = document.getElementById('fc-srs-due-count');
    if (!banner || !countEl) return;
    try {
        const token = JSON.parse(localStorage.getItem('hsk_user') || '{}').token;
        if (!token) return;
        const res = await fetch(`${window.API}/api/srs/stats`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) return;
        const data = await res.json();
        const due = data.due_today || 0;
        if (due > 0) {
            countEl.textContent = due;
            banner.style.display = 'flex';
        } else {
            banner.style.display = 'none';
        }
    } catch {}
}

boot();