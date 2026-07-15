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
    const password = document.getElementById('reg-pass').value;

    if (!name || !username || !password) { showError('Vui lòng nhập đầy đủ thông tin'); return; }
    if (password.length < 6) { showError('Mật khẩu phải từ 6 ký tự trở lên'); return; }

    try {
        const res = await fetch(`${window.API}/api/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, username, password })
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
    document.getElementById(tab === 'login' ? 'tab-login' : 'tab-register').classList.add('active');
    document.getElementById('auth-error').style.display = 'none';
}

function showError(msg) {
    const el = document.getElementById('auth-error');
    el.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> ' + msg;
    el.style.display = 'block';
}

window.togglePasswordVisibility = function(btn) {
    const input = btn.previousElementSibling;
    if (!input) return;
    const icon = btn.querySelector('i');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    icon.classList.toggle('fa-eye', !show);
    icon.classList.toggle('fa-eye-slash', show);
};

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
