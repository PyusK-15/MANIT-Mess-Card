const API_URL = '/api';
const SESSION_KEY = 'manit_session';

let verifiedScholarId = '';
let uploadedPhotoBase64 = '';
let clockInterval = null;
let pollInterval = null;
let qrInterval = null;
let resendTimer = null;
let session = null;      // { token, student }
let staffToken = null;   // kept in memory only; staff must log in again after a reload

// ---------------------------------------------------------------- helpers
function showToast(msg, type) {
    const toast = document.getElementById('toast');
    toast.className = `toast ${type} show`;
    toast.textContent = msg; // textContent, never innerHTML (names are user-controlled)
    setTimeout(() => toast.classList.remove('show'), 3500);
}

function switchView(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
}

async function api(path, { method = 'GET', body, token } = {}) {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${API_URL}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = {};
    try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
    return { res, data };
}

function updateDerivedEmail() {
    const val = document.getElementById('reg-init-id').value.trim().toLowerCase();
    document.getElementById('derived-email').textContent = val ? `${val}@stu.manit.ac.in` : 'scholar@stu.manit.ac.in';
}

// ---------------------------------------------------------------- registration (OTP)
function startResendTimer(seconds = 60) {
    const btn = document.getElementById('btn-resend-otp');
    if (!btn) return;
    if (resendTimer) clearInterval(resendTimer);
    let left = seconds;
    btn.disabled = true;
    btn.textContent = `Resend OTP in ${left}s`;
    resendTimer = setInterval(() => {
        left--;
        if (left <= 0) {
            clearInterval(resendTimer);
            btn.disabled = false;
            btn.textContent = 'Resend OTP';
        } else {
            btn.textContent = `Resend OTP in ${left}s`;
        }
    }, 1000);
}

async function handleSendOtp(isResend) {
    const resend = isResend === true;
    const scholarId = resend
        ? verifiedScholarId
        : document.getElementById('reg-init-id').value.trim().toLowerCase();
    const btn = document.getElementById(resend ? 'btn-resend-otp' : 'btn-send-otp');
    if (!scholarId) return showToast('Enter your Scholar Number', 'error');

    btn.disabled = true;
    if (!resend) btn.textContent = 'Sending OTP...';
    try {
        const { res, data } = await api('/request-otp', { method: 'POST', body: { scholarId } });
        if (res.ok && data.success) {
            verifiedScholarId = scholarId;
            showToast(`OTP sent to ${data.email}. Check your inbox (and spam).`, 'success');
            switchView('view-register-step2');
            startResendTimer(60);
        } else {
            showToast(data.message || 'Could not send OTP', 'error');
            if (resend) btn.disabled = false;
        }
    } catch (e) {
        showToast('Server connection error.', 'error');
        if (resend) btn.disabled = false;
    } finally {
        if (!resend) { btn.disabled = false; btn.textContent = 'Send Verification OTP'; }
    }
}

function previewPhoto(event) {
    const file = event.target.files[0];
    if (!file) return;
    uploadedPhotoBase64 = '';
    document.getElementById('photo-preview-container').style.display = 'none';

    const reader = new FileReader();
    reader.onload = function (e) {
        const img = new Image();
        img.onload = function () {
            const TARGET_WIDTH = 350;
            const scale = Math.min(1, TARGET_WIDTH / img.width); // never upscale, keep aspect ratio
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            uploadedPhotoBase64 = canvas.toDataURL('image/jpeg', 0.82);

            document.getElementById('reg-photo-preview').src = uploadedPhotoBase64;
            document.getElementById('photo-preview-container').style.display = 'flex';
            const sizeInKb = (Math.round((uploadedPhotoBase64.length * 3) / 4) / 1024).toFixed(1);
            document.getElementById('photo-size-label').textContent = `Ready (${sizeInKb} KB)`;
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

async function handleFinalRegister() {
    const otp = document.getElementById('reg-otp').value.trim();
    const name = document.getElementById('reg-name').value.trim();
    const room = document.getElementById('reg-room').value.trim();
    const password = document.getElementById('reg-pass').value;
    const btn = document.getElementById('btn-final-register');

    if (!otp || !name || !room || !password || !uploadedPhotoBase64) {
        return showToast('Please fill all fields and provide photo & OTP', 'error');
    }
    if (password.length < 6) return showToast('Password must be at least 6 characters', 'error');

    btn.disabled = true; btn.textContent = 'Validating...';
    try {
        const { res, data } = await api('/verify-and-register', {
            method: 'POST',
            body: { scholarId: verifiedScholarId, otp, name, room, password, photo: uploadedPhotoBase64 }
        });
        if (res.ok && data.success) {
            showToast('Identity pass registered successfully! Please log in.', 'success');
            document.getElementById('reg-otp').value = '';
            document.getElementById('reg-pass').value = '';
            switchView('view-login');
        } else {
            showToast(data.message || 'OTP verification failed', 'error');
        }
    } catch (e) {
        showToast('Server verification failure.', 'error');
    } finally {
        btn.disabled = false; btn.textContent = 'Verify OTP & Activate Card';
    }
}

// ---------------------------------------------------------------- student login + card
async function handleLogin() {
    const scholarId = document.getElementById('login-id').value.trim();
    const password = document.getElementById('login-pass').value;
    const btn = document.getElementById('btn-login');
    if (!scholarId || !password) return showToast('Enter Scholar ID and Password', 'error');

    btn.disabled = true; btn.textContent = 'Verifying...';
    try {
        const { res, data } = await api('/login', { method: 'POST', body: { scholarId, password } });
        if (res.ok && data.success) {
            session = { token: data.token, student: data.student };
            localStorage.setItem(SESSION_KEY, JSON.stringify(session));
            renderStudentCard(session.student);
        } else {
            showToast(data.message || 'Invalid credentials', 'error');
        }
    } catch (err) {
        showToast('Server connection failure', 'error');
    } finally {
        btn.disabled = false; btn.textContent = 'Display Identity Card';
    }
}

function renderQr(text) {
    const box = document.getElementById('qrcode');
    box.innerHTML = '';
    new QRCode(box, { text, width: 160, height: 160, colorDark: '#0a2540', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
}

async function refreshQr() {
    if (!session) return;
    try {
        const { res, data } = await api('/qr-token', { token: session.token });
        if (res.status === 401) return logout();
        if (data.token) renderQr(data.token);
    } catch (e) { /* offline: keep showing the last QR until it expires */ }
}

function renderStudentCard(s) {
    document.getElementById('card-name').textContent = s.name;
    document.getElementById('card-id').textContent = s.scholarId;
    document.getElementById('card-room').textContent = s.room;
    document.getElementById('card-photo').src = s.photo;

    switchView('view-student');

    if (clockInterval) clearInterval(clockInterval);
    clockInterval = setInterval(() => {
        document.getElementById('live-clock').textContent = new Date().toLocaleTimeString('en-US');
    }, 1000);

    // The QR is a signed token that expires in 60 s, so a screenshot or a guessed scholar number is useless.
    if (qrInterval) clearInterval(qrInterval);
    refreshQr();
    qrInterval = setInterval(refreshQr, 40000);

    if (pollInterval) clearInterval(pollInterval);
    checkMealStatus();
    pollInterval = setInterval(checkMealStatus, 8000);
}

async function checkMealStatus() {
    if (!session) return;
    try {
        const { res, data } = await api('/status', { token: session.token });
        if (res.status === 401) return logout();

        const qrWrapper = document.getElementById('qr-container-box');
        const claimedBox = document.getElementById('claimed-container-box');
        document.getElementById('current-meal').textContent = `${data.activeSlot} Active`;

        if (data.claimed) {
            qrWrapper.style.display = 'none';
            claimedBox.style.display = 'block';
        } else {
            qrWrapper.style.display = 'block';
            claimedBox.style.display = 'none';
        }
    } catch (e) { /* ignore transient network errors */ }
}

function logout() {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem('manit_active_student'); // old key from the previous version
    if (clockInterval) clearInterval(clockInterval);
    if (pollInterval) clearInterval(pollInterval);
    if (qrInterval) clearInterval(qrInterval);
    session = null;
    document.getElementById('login-pass').value = '';
    switchView('view-login');
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && session) { refreshQr(); checkMealStatus(); }
});

window.addEventListener('DOMContentLoaded', () => {
    localStorage.removeItem('manit_active_student'); // old insecure cache
    const cached = localStorage.getItem(SESSION_KEY);
    if (cached) {
        try {
            session = JSON.parse(cached);
            if (!session.token || !session.student) throw new Error('bad session');
            renderStudentCard(session.student);
        } catch (e) { localStorage.removeItem(SESSION_KEY); session = null; }
    }
});

// ---------------------------------------------------------------- staff terminal
let html5QrcodeScanner = null;
let isProcessingScan = false;

async function handleAdminLogin() {
    const password = document.getElementById('admin-pass').value;
    if (!password) return showToast('Enter staff password', 'error');
    try {
        const { res, data } = await api('/staff-login', { method: 'POST', body: { password } });
        if (!(res.ok && data.success)) return showToast(data.message || 'Invalid Staff Password', 'error');
        staffToken = data.token;
        document.getElementById('admin-pass').value = '';
        switchView('view-admin');
        if (!html5QrcodeScanner) {
            html5QrcodeScanner = new Html5QrcodeScanner('reader', { fps: 15, qrbox: { width: 220, height: 220 } }, false);
            html5QrcodeScanner.render(onScanSuccess);
        }
    } catch (e) {
        showToast('Server connection error', 'error');
    }
}

function showScanResult(status, data) {
    const box = document.getElementById('scan-result');
    if (!box) return;
    box.innerHTML = '';
    const ok = status === 'allowed';
    const wrap = document.createElement('div');
    wrap.style.cssText = `display:flex;gap:12px;align-items:center;padding:10px;border-radius:12px;border:2px solid ${ok ? '#059669' : '#dc2626'};background:${ok ? '#ecfdf5' : '#fef2f2'};`;

    if (data.photo) {
        const img = document.createElement('img');
        img.src = data.photo; // server only ever stores validated data:image/jpeg URLs
        img.style.cssText = 'width:64px;height:78px;object-fit:cover;border-radius:8px;border:1px solid #cbd5e1;';
        wrap.appendChild(img);
    }
    const text = document.createElement('div');
    text.style.cssText = 'text-align:left;font-size:13px;';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:800;margin-bottom:2px;';
    title.textContent = ok ? 'APPROVED' : 'ALREADY RECEIVED';
    const nm = document.createElement('div');
    nm.textContent = `${data.name} (${data.scholarId})`;
    const rm = document.createElement('div');
    rm.textContent = data.room;
    text.append(title, nm, rm);
    wrap.appendChild(text);
    box.appendChild(wrap);
}

function staffSessionExpired() {
    staffToken = null;
    showToast('Staff session expired. Please log in again.', 'error');
    stopScannerAndLogout();
}

async function onScanSuccess(decodedText) {
    if (isProcessingScan) return;
    isProcessingScan = true;
    try {
        const { res, data } = await api('/scan', { method: 'POST', token: staffToken, body: { token: decodedText } });
        if (res.status === 401) return staffSessionExpired();

        if (data.status === 'allowed' || data.status === 'denied') {
            showScanResult(data.status, data);
            showToast(data.status === 'allowed' ? `APPROVED: ${data.name}` : `LIMIT REACHED: ${data.name} already received meal!`,
                      data.status === 'allowed' ? 'success' : 'error');
        } else {
            const box = document.getElementById('scan-result');
            if (box) box.innerHTML = '';
            showToast(data.message || 'INVALID CARD', 'error');
        }
    } catch (e) {
        showToast('Scan error', 'error');
    }
    setTimeout(() => { isProcessingScan = false; }, 2200);
}

async function resetSingleStudent() {
    const scholarId = document.getElementById('manual-reset-id').value.trim();
    if (!scholarId) return showToast('Enter Scholar ID', 'error');
    try {
        const { res, data } = await api('/reset-one', { method: 'POST', token: staffToken, body: { scholarId } });
        if (res.status === 401) return staffSessionExpired();
        showToast(data.message || 'Done', data.success ? 'success' : 'error');
        if (data.success) document.getElementById('manual-reset-id').value = '';
    } catch (e) { showToast('Reset failed', 'error'); }
}

async function resetAllStudents() {
    if (!confirm('Reset ALL cards? Everyone will be able to take this meal again.')) return;
    try {
        const { res, data } = await api('/reset-all', { method: 'POST', token: staffToken });
        if (res.status === 401) return staffSessionExpired();
        showToast(data.message || 'Done', data.success ? 'success' : 'error');
    } catch (e) { showToast('Reset all failed', 'error'); }
}

function stopScannerAndLogout() {
    if (html5QrcodeScanner) { html5QrcodeScanner.clear().catch(() => {}); html5QrcodeScanner = null; }
    staffToken = null;
    document.getElementById('admin-pass').value = '';
    const box = document.getElementById('scan-result');
    if (box) box.innerHTML = '';
    switchView('view-login');
}
