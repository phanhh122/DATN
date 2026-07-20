// profile/profile.js
import { getToken, getCurrentUser } from '../auth/auth.js';
import { getStudied, getStreak, loadStreakFromServer, getMergedLearnedIds } from '../storage/storage.js';
import { showToast } from '../components/toast.js';

export async function initProfile() {
    try {
        const res = await fetch(`${window.API}/api/profile`, {
            headers: { 'Authorization': `Bearer ${getToken()}` }
        });
        if (res.ok) {
            const data = await res.json();
            populateForm(data);
            updateProfileCard(data);
        }
    } catch {
        // Fallback to local user
        const u = getCurrentUser();
        if (u) { populateForm(u); updateProfileCard(u); }
    }

    await loadStreakFromServer();
    // Stats
    // FIX: trước đây dùng getStudied().size (chỉ localStorage) nên số "Đã học"
    // ở đây lệch với Tổng quan/Flashcard (vốn đã hợp nhất thêm dữ liệu server).
    // Dùng chung getMergedLearnedIds() để cả 3 nơi luôn khớp nhau.
    const learnedIds = await getMergedLearnedIds();
    document.getElementById('profile-stat-learned').textContent = learnedIds.size;
    document.getElementById('profile-stat-streak').textContent  = getStreak();
}

function populateForm(u) {
    setValue('pf-name',     u.name || '');
    setValue('pf-username', u.username || '');
    setValue('pf-email',    u.email || '');
    setValue('pf-birthday', u.birthday ? u.birthday.split('T')[0] : '');
    setValue('pf-gender',   u.gender || '');
    setValue('pf-goal',     u.learning_goal || '');

    const emailInput = document.getElementById('pf-email');
    const emailHint  = document.getElementById('pf-email-hint');
    const isGoogleLinked = !!u.google_id;
    if (emailInput) {
        emailInput.disabled = isGoogleLinked;
        emailInput.style.opacity = isGoogleLinked ? '.6' : '';
    }
    if (emailHint) emailHint.style.display = isGoogleLinked ? 'block' : 'none';
}

function updateProfileCard(u) {
    document.getElementById('profile-card-name').textContent  = u.name || u.username || 'Người dùng';
    document.getElementById('profile-card-email').textContent = u.email || '';
    document.getElementById('profile-card-role').innerHTML  = u.role === 'admin' ? '<i class="fa-solid fa-gear"></i> Quản trị viên' : '<i class="fa-solid fa-book"></i> Học viên';

    const avatarEl = document.getElementById('profile-avatar-display');
    if (u.avatar) {
        avatarEl.innerHTML = `<img src="${u.avatar}" alt="avatar">`;
    } else {
        avatarEl.textContent = (u.name || u.username || 'U')[0].toUpperCase();
    }

    // Sync sidebar avatar
    const sideAv = document.getElementById('user-avatar');
    if (sideAv) {
        if (u.avatar) sideAv.innerHTML = `<img src="${u.avatar}" alt="avatar">`;
        else sideAv.textContent = (u.name || u.username || 'U')[0].toUpperCase();
    }
    const sideNm = document.getElementById('user-display-name');
    if (sideNm) sideNm.textContent = u.name || u.username;
}

export async function saveProfile() {
    const emailInput = document.getElementById('pf-email');
    const emailLocked = !!emailInput?.disabled;

    const payload = {
        name:          getValue('pf-name'),
        birthday:      getValue('pf-birthday'),
        gender:        getValue('pf-gender'),
        learning_goal: getValue('pf-goal'),
    };
    
    if (!emailLocked) payload.email = getValue('pf-email');
    if (!payload.name) { showToast('Vui lòng nhập họ tên', 'error'); return; }
    if (payload.email && !isValidEmail(payload.email)) { showToast('Email không hợp lệ', 'error'); return; }

    try {
        const res = await fetch(`${window.API}/api/profile`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${getToken()}`
            },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Lưu thất bại', 'error'); return; }

        updateProfileCard(data);
        // Update localStorage
        const saved = JSON.parse(localStorage.getItem('hsk_user') || '{}');
        localStorage.setItem('hsk_user', JSON.stringify({ ...saved, ...data }));
        showToast('Đã lưu thông tin thành công!', 'success');
    } catch {
        showToast('Lỗi kết nối máy chủ', 'error');
    }
}

export async function changePassword() {
    const oldPass  = getValue('pf-old-pass');
    const newPass  = getValue('pf-new-pass');
    const confirm  = getValue('pf-confirm-pass');

    if (!oldPass || !newPass || !confirm) { showToast('Vui lòng nhập đầy đủ', 'error'); return; }
    if (newPass.length < 6) { showToast('Mật khẩu mới phải từ 6 ký tự', 'error'); return; }
    if (newPass !== confirm) { showToast('Mật khẩu xác nhận không khớp', 'error'); return; }

    try {
        const res = await fetch(`${window.API}/api/profile/password`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${getToken()}`
            },
            body: JSON.stringify({ oldPassword: oldPass, newPassword: newPass })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.message || 'Đổi mật khẩu thất bại', 'error'); return; }

        showToast('Đã đổi mật khẩu thành công!', 'success');
        setValue('pf-old-pass', '');
        setValue('pf-new-pass', '');
        setValue('pf-confirm-pass', '');
    } catch {
        showToast('Lỗi kết nối máy chủ', 'error');
    }
}

export function handleAvatarChange(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { showToast('Ảnh tối đa 2MB', 'error'); return; }

    const reader = new FileReader();
    reader.onload = async (e) => {
        const base64 = e.target.result;

        // Immediate preview
        document.getElementById('profile-avatar-display').innerHTML = `<img src="${base64}" alt="avatar">`;
        const sideAv = document.getElementById('user-avatar');
        if (sideAv) sideAv.innerHTML = `<img src="${base64}" alt="avatar">`;

        // Upload to server
        try {
            const res = await fetch(`${window.API}/api/profile`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${getToken()}`
                },
                body: JSON.stringify({ avatar: base64 })
            });
            if (res.ok) {
                const saved = JSON.parse(localStorage.getItem('hsk_user') || '{}');
                localStorage.setItem('hsk_user', JSON.stringify({ ...saved, avatar: base64 }));
                showToast('Đã cập nhật ảnh đại diện!', 'success');
            }
        } catch { showToast('Lưu ảnh thất bại', 'error'); }
    };
    reader.readAsDataURL(file);
}

// Helpers
function getValue(id) { return document.getElementById(id)?.value || ''; }
function setValue(id, v) { const el = document.getElementById(id); if (el) el.value = v; }
function isValidEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
