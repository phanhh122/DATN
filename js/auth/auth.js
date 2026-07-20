// auth/auth.js
import { retryMigrationAfterLogin, syncResetMarker } from '../storage/storage.js';

let _currentUser = null;
let _onLoginCb = null;

export async function initAuth({ onLogin }) {
    _onLoginCb = onLogin;

    // Expose tab switcher
    window._switchAuthTabImpl = switchTab;

    // Check saved session
    const saved = localStorage.getItem('hsk_user');
    if (saved) {
        try {
            _currentUser = JSON.parse(saved);
            // Hide landing immediately to avoid flash while we verify token
            document.getElementById('landing-screen').style.display = 'none';
            // Verify with server
            const res = await fetch(`${window.API}/api/profile`, {
                headers: { 'Authorization': `Bearer ${_currentUser.token}` }
            });
            if (res.ok) {
                const data = await res.json();
                _currentUser = { ..._currentUser, ...data };
                localStorage.setItem('hsk_user', JSON.stringify(_currentUser));
                syncResetMarker(data.progress_reset_at);
                retryMigrationAfterLogin();
                _onLoginCb(_currentUser);
                return;
            } else {
                localStorage.removeItem('hsk_user');
                _currentUser = null;
                document.getElementById('landing-screen').style.display = 'block';
            }
        } catch {
            // Network error — still show landing
            document.getElementById('landing-screen').style.display = 'block';
        }
    }

    // Show auth forms
    // Hiển thị landing page cho khách chưa đăng nhập
    document.getElementById('landing-screen').style.display = 'block';
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('login-form').addEventListener('submit', handleLogin);
    document.getElementById('register-form').addEventListener('submit', handleRegister);
    document.getElementById('forgot-form').addEventListener('submit', handleForgotPassword);

    initGoogleSignIn();
}

// ── Đăng nhập Google (Google Identity Services) ──
function initGoogleSignIn() {
    if (!window.GOOGLE_CLIENT_ID || window.GOOGLE_CLIENT_ID.includes('YOUR_')) {
        // Chưa cấu hình Client ID (xem window.GOOGLE_CLIENT_ID trong js/main.js) — bỏ qua, không render nút.
        return;
    }
    function render() {
        if (!window.google || !window.google.accounts) { setTimeout(render, 200); return; }
        window.google.accounts.id.initialize({
            client_id: window.GOOGLE_CLIENT_ID,
            callback: handleGoogleCredential,
        });
        const el = document.getElementById('google-signin-btn');
        if (el) {
            window.google.accounts.id.renderButton(el, {
                theme: 'outline', size: 'large', width: 320, text: 'continue_with', locale: 'vi',
            });
        }
    }
    render();
}

async function handleGoogleCredential(response) {
    try {
        const res = await fetch(`${window.API}/api/auth/google`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credential: response.credential })
        });
        const data = await res.json();
        if (!res.ok) { showError(data.message || 'Đăng nhập Google thất bại'); return; }

        _currentUser = data;
        localStorage.setItem('hsk_user', JSON.stringify(data));
        syncResetMarker(data.progress_reset_at);
        retryMigrationAfterLogin();
        _onLoginCb(data);
    } catch {
        showError('Không thể kết nối máy chủ');
    }
}

async function handleForgotPassword(e) {
    e.preventDefault();
    const email = document.getElementById('forgot-email').value.trim();
    if (!email) { showError('Vui lòng nhập email'); return; }

    const btn = e.target.querySelector('button[type="submit"]');
    const originalBtnText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Đang gửi... (có thể mất tới 1 phút)'; }

    const el = document.getElementById('auth-error');
    el.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang gửi yêu cầu...';
    el.style.display = 'block';
    el.style.background = '#eef2ff';
    el.style.color = '#3730a3';

    try {
        const res = await fetch(`${window.API}/api/forgot-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });

        let data = {};
        try { data = await res.json(); } catch (parseErr) {
            console.error('[forgot-password] Server không trả JSON hợp lệ:', parseErr);
            showError(`Server phản hồi bất thường (HTTP ${res.status}). Kiểm tra log Render.`);
            return;
        }

        if (!res.ok) {
            console.error('[forgot-password] HTTP', res.status, data);
            showError(data.message || `Gửi yêu cầu thất bại (HTTP ${res.status})`);
            return;
        }

        // Server luôn trả 200 với thông điệp chung (kể cả email không tồn tại) — xem comment trong server.js.
        el.innerHTML = '<i class="fa-solid fa-circle-check"></i> ' + (data.message || 'Đã gửi yêu cầu');
        el.style.display = 'block';
        el.style.background = '#e6f7ee';
        el.style.color = '#0a7a41';
    } catch (err) {
        console.error('[forgot-password] Lỗi kết nối:', err);
        showError('Không thể kết nối máy chủ. Kiểm tra tab Network (F12) hoặc thử lại sau vài giây.');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = originalBtnText; }
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('login-user').value.trim();
    const password = document.getElementById('login-pass').value;
    const errEl = document.getElementById('auth-error');

    if (!username || !password) {
        showError('Vui lòng nhập đầy đủ thông tin');
        return;
    }

    try {
        const res = await fetch(`${window.API}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok) { showError(data.message || 'Đăng nhập thất bại'); return; }

        _currentUser = data;
        localStorage.setItem('hsk_user', JSON.stringify(data));
        syncResetMarker(data.progress_reset_at);
        retryMigrationAfterLogin();
        _onLoginCb(data);
    } catch {
        showError('Không thể kết nối máy chủ');
    }
}

async function handleRegister(e) {
    e.preventDefault();
    const name     = document.getElementById('reg-name').value.trim();
    const username = document.getElementById('reg-user').value.trim();
    const email    = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-pass').value;

    if (!name || !username || !password) { showError('Vui lòng nhập đầy đủ thông tin'); return; }
    if (password.length < 6) { showError('Mật khẩu phải từ 6 ký tự trở lên'); return; }

    try {
        const res = await fetch(`${window.API}/api/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, username, email, password })
        });
        const data = await res.json();
        if (!res.ok) { showError(data.message || 'Đăng ký thất bại'); return; }

        _currentUser = data;
        localStorage.setItem('hsk_user', JSON.stringify(data));
        _onLoginCb(data);
    } catch {
        showError('Không thể kết nối máy chủ');
    }
}

function switchTab(tab) {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    document.getElementById('login-form').style.display    = tab === 'login'    ? 'flex' : 'none';
    document.getElementById('register-form').style.display = tab === 'register' ? 'flex' : 'none';
    document.getElementById('forgot-form').style.display   = tab === 'forgot'   ? 'flex' : 'none';
    if (tab === 'login' || tab === 'register') {
        document.getElementById(tab === 'login' ? 'tab-login' : 'tab-register').classList.add('active');
    }
    document.getElementById('auth-error').style.display = 'none';
}

function showError(msg) {
    const el = document.getElementById('auth-error');
    el.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> ' + msg;
    el.style.display = 'block';
    el.style.background = '';
    el.style.color = '';
}

export function logout() {
    _currentUser = null;
    localStorage.removeItem('hsk_user');
}

export function getCurrentUser() {
    return _currentUser;
}

export function getToken() {
    return _currentUser?.token || '';
}
