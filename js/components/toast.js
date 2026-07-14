// components/toast.js
let _timer = null;

export function showToast(msg, type = 'success') {
    const el   = document.getElementById('toast');
    const icon = document.getElementById('toast-icon');
    const txt  = document.getElementById('toast-msg');

    icon.innerHTML = type === 'success' ? '<i class="fa-solid fa-check"></i>' : type === 'error' ? '<i class="fa-solid fa-times"></i>' : '<i class="fa-solid fa-info-circle"></i>';
    txt.textContent  = msg;
    el.className     = `toast ${type}`;
    el.style.display = 'flex';

    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(() => { el.style.display = 'none'; }, 3000);
}
