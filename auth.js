/* ═══════════════════════════════════════════════
   ELCHAT — AUTH.JS
   Supabase Authentication Module
═══════════════════════════════════════════════ */

// ── Supabase Configuration ─────────────────────
const SUPABASE_URL  = 'https://sxdegbjhumiurcrfcanh.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN4ZGVnYmpodW1pdXJjcmZjYW5oIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5MTY1OTQsImV4cCI6MjA4OTQ5MjU5NH0.491zxrUqtwlKPFN2mXo5apduQ0lNptwrc8dXBlILTEQ';

const { createClient } = supabase;
const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON);

let usernameCheckTimer = null;
let currentUser        = null;

// ══════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════

function setButtonLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  const text   = btn.querySelector('.btn__text');
  const loader = btn.querySelector('.btn__loader');
  btn.disabled = loading;
  if (text)   text.hidden  = loading;
  if (loader) loader.hidden = !loading;
}

function showError(elementId, message) {
  const el = document.getElementById(elementId);
  if (el) el.textContent = message;
}

function showToast(message, type = '') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className   = 'toast' + (type ? ' toast--' + type : '') + ' show';
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3000);
}

function togglePassword(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const isHidden = input.type === 'password';
  input.type = isHidden ? 'text' : 'password';
  btn.setAttribute('aria-label', isHidden ? 'Sembunyikan sandi' : 'Tampilkan sandi');
}

function switchTab(tab) {
  const indicator     = document.getElementById('tab-indicator');
  const loginPanel    = document.getElementById('panel-login');
  const registerPanel = document.getElementById('panel-register');
  const tabLogin      = document.getElementById('tab-login');
  const tabRegister   = document.getElementById('tab-register');

  if (tab === 'login') {
    loginPanel.classList.add('active');
    registerPanel.classList.remove('active');
    tabLogin.classList.add('active');
    tabRegister.classList.remove('active');
    tabLogin.setAttribute('aria-selected', 'true');
    tabRegister.setAttribute('aria-selected', 'false');
    if (indicator) indicator.classList.remove('right');
  } else {
    registerPanel.classList.add('active');
    loginPanel.classList.remove('active');
    tabRegister.classList.add('active');
    tabLogin.classList.remove('active');
    tabRegister.setAttribute('aria-selected', 'true');
    tabLogin.setAttribute('aria-selected', 'false');
    if (indicator) indicator.classList.add('right');
  }

  showError('login-error', '');
  showError('register-error', '');
  showError('username-error', '');
}

// ══════════════════════════════════════════════
// VALIDASI
// ══════════════════════════════════════════════

function validatePassword(password) {
  const minLength = password.length >= 7;
  const hasNumber = /\d/.test(password);
  const hasSymbol = /[!@#$%^&*()\-_=+\[\]{};:'",.<>?\/\\|`~]/.test(password);
  const hasUpper  = /[A-Z]/.test(password);

  if (!minLength) return { valid: false, message: 'Kata sandi minimal 7 karakter.', strength: 0 };
  if (!hasNumber && !hasSymbol) return { valid: false, message: 'Harus mengandung angka atau simbol khusus.', strength: 1 };

  let score = 1;
  if (hasNumber && hasSymbol) score++;
  if (hasUpper) score++;
  if (password.length >= 12) score++;
  return { valid: true, message: '', strength: score };
}

function validatePasswordStrength(password) {
  const container = document.getElementById('pw-strength');
  const fill      = document.getElementById('pw-strength-fill');
  const label     = document.getElementById('pw-strength-label');
  if (!container || !fill || !label) return;
  if (!password) { container.hidden = true; return; }

  container.hidden = false;
  const { strength } = validatePassword(password);
  const levels = [
    { pct: '15%',  color: '#ef5350', text: 'Sangat Lemah', css: 'var(--accent-red)'   },
    { pct: '35%',  color: '#FF9800', text: 'Lemah',        css: '#FF9800'              },
    { pct: '60%',  color: '#FFCA28', text: 'Sedang',       css: 'var(--accent-amber)'  },
    { pct: '85%',  color: '#66BB6A', text: 'Kuat',         css: 'var(--accent-green)'  },
    { pct: '100%', color: '#26C6DA', text: 'Sangat Kuat',  css: 'var(--accent-blue)'   },
  ];
  const level = levels[Math.min(strength, levels.length - 1)];
  fill.style.width           = level.pct;
  fill.style.backgroundColor = level.color;
  label.textContent          = level.text;
  label.style.color          = level.css;
}

function validateUsername(username) {
  if (!username || username.length < 3) {
    return { valid: false, message: 'Username minimal 3 karakter.' };
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
    return { valid: false, message: 'Hanya huruf, angka, titik, underscore, atau strip yang diizinkan.' };
  }
  return { valid: true, message: '' };
}

// ══════════════════════════════════════════════
// USERNAME CHECK
// ══════════════════════════════════════════════

function checkUsernameAvailability(rawValue) {
  const username = rawValue.trim().toLowerCase();
  const statusEl = document.getElementById('username-status');
  const inputEl  = document.getElementById('reg-username');

  showError('username-error', '');
  if (statusEl) statusEl.textContent = '';
  if (inputEl)  inputEl.classList.remove('error');
  if (!username) return;

  const { valid, message } = validateUsername(username);
  if (!valid) {
    showError('username-error', message);
    if (inputEl) inputEl.classList.add('error');
    return;
  }

  if (statusEl) statusEl.textContent = '🔄';
  clearTimeout(usernameCheckTimer);
  usernameCheckTimer = setTimeout(async () => {
    try {
      const { data, error } = await supabaseClient
        .from('profiles').select('username').eq('username', username).maybeSingle();
      if (error) throw error;
      if (data) {
        showError('username-error', 'Username sudah digunakan. Coba yang lain.');
        if (statusEl) statusEl.textContent = '❌';
        if (inputEl)  inputEl.classList.add('error');
      } else {
        showError('username-error', '');
        if (statusEl) statusEl.textContent = '✅';
        if (inputEl)  inputEl.classList.remove('error');
      }
    } catch (err) {
      console.warn('[ElChat] Username check error:', err.message);
      if (statusEl) statusEl.textContent = '';
    }
  }, 600);
}

// ══════════════════════════════════════════════
// AUTH HANDLERS
// ══════════════════════════════════════════════

async function handleRegister() {
  const email    = document.getElementById('reg-email')?.value.trim();
  const username = document.getElementById('reg-username')?.value.trim().toLowerCase();
  const password = document.getElementById('reg-password')?.value;
  const confirm  = document.getElementById('reg-confirm')?.value;

  showError('register-error', '');

  if (!email || !username || !password || !confirm) {
    showError('register-error', 'Semua kolom wajib diisi.');
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showError('register-error', 'Format email tidak valid.');
    return;
  }
  const usernameCheck = validateUsername(username);
  if (!usernameCheck.valid) { showError('register-error', usernameCheck.message); return; }

  const pwCheck = validatePassword(password);
  if (!pwCheck.valid) { showError('register-error', pwCheck.message); return; }

  if (password !== confirm) {
    showError('register-error', 'Konfirmasi kata sandi tidak cocok.');
    return;
  }

  setButtonLoading('btn-register', true);

  try {
    const { data: existing } = await supabaseClient
      .from('profiles').select('username').eq('username', username).maybeSingle();
    if (existing) {
      showError('register-error', 'Username sudah digunakan.');
      return;
    }

    const { data: authData, error: authError } = await supabaseClient.auth.signUp({
      email, password, options: { data: { username } }
    });
    if (authError) throw authError;

    const userId = authData.user?.id;
    if (!userId) throw new Error('User ID tidak ditemukan.');

    const { error: profileError } = await supabaseClient
      .from('profiles')
      .insert([{ id: userId, username, email, role: 'user', avatar_url: null }]);
    if (profileError) throw profileError;

    showToast('Akun berhasil dibuat! Silakan login.', 'success');
    switchTab('login');
    const loginEmail = document.getElementById('login-email');
    if (loginEmail) loginEmail.value = email;

  } catch (err) {
    console.error('[ElChat] Register error:', err);
    showError('register-error', mapAuthError(err.message));
  } finally {
    setButtonLoading('btn-register', false);
  }
}

async function handleLogin() {
    // 1. ALERT HARUS DI SINI (Baris paling atas setelah kurung kurawal):
    alert("Tombol Masuk berhasil memanggil fungsi JS!");
    
    // 2. Baru ambil elemennya di bawah sini:
    const email = document.getElementById('login-email')?.value.trim();
    // ...
  const password = document.getElementById('login-password')?.value;

  showError('login-error', '');
  if (!email || !password) {
    showError('login-error', 'Email dan kata sandi wajib diisi.');
    return;
  }

  setButtonLoading('btn-login', true);
  try {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    currentUser = data.user;
    await onAuthSuccess(data.user);
  } catch (err) {
    console.error('[ElChat] Login error:', err);
    showError('login-error', mapAuthError(err.message));
  } finally {
    setButtonLoading('btn-login', false);
  }
}

async function handleGoogleLogin() {
  setButtonLoading('btn-google', true);
  try {
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + window.location.pathname }
    });
    if (error) throw error;
  } catch (err) {
    console.error('[ElChat] Google login error:', err);
    showToast(mapAuthError(err.message), 'error');
    setButtonLoading('btn-google', false);
  }
}

async function handleLogout() {
  try {
    await supabaseClient.auth.signOut();
    currentUser = null;
    showAuthScreen();
    showToast('Berhasil keluar.', 'success');
  } catch (err) {
    showToast('Gagal keluar. Coba lagi.', 'error');
  }
}

// ══════════════════════════════════════════════
// SESSION
// ══════════════════════════════════════════════

async function onAuthSuccess(user) {
  try {
    const { data: profile, error } = await supabaseClient
      .from('profiles').select('*').eq('id', user.id).single();

    if (error && error.code !== 'PGRST116') throw error;

    if (!profile) {
      const username = user.user_metadata?.full_name?.replace(/\s+/g, '').toLowerCase()
                       || ('user_' + user.id.substring(0, 6));
      await supabaseClient.from('profiles').insert([{
        id: user.id, username, email: user.email, role: 'user',
        avatar_url: user.user_metadata?.avatar_url || null
      }]);
      user.profile = { role: 'user', username };
    } else {
      user.profile = profile;
    }

    sessionStorage.setItem('elchat_user', JSON.stringify({
      id:       user.id,
      email:    user.email,
      role:     user.profile.role,
      username: user.profile.username,
      avatar:   user.profile.avatar_url || user.user_metadata?.avatar_url || null
    }));

    if (typeof initApp === 'function') initApp(user.profile);

  } catch (err) {
    console.error('[ElChat] onAuthSuccess error:', err);
    showToast('Gagal memuat profil: ' + err.message, 'error');
  }
}

function showAuthScreen() {
  const authScreen = document.getElementById('auth-screen');
  const appScreen  = document.getElementById('app-screen');
  if (authScreen) authScreen.classList.add('active');
  if (appScreen)  { appScreen.hidden = true; appScreen.classList.remove('active'); }
  sessionStorage.removeItem('elchat_user');
}

function mapAuthError(message) {
  if (!message) return 'Terjadi kesalahan. Coba lagi.';
  const m = message.toLowerCase();
  if (m.includes('invalid login credentials') || m.includes('invalid email or password'))
    return 'Email atau kata sandi tidak sesuai.';
  if (m.includes('email not confirmed'))
    return 'Email belum diverifikasi. Cek kotak masuk atau spam-mu.';
  if (m.includes('user already registered') || m.includes('already been registered'))
    return 'Email ini sudah terdaftar. Silakan login.';
  if (m.includes('password should be at least'))
    return 'Kata sandi terlalu pendek (minimal 7 karakter).';
  if (m.includes('rate limit'))
    return 'Terlalu banyak percobaan. Tunggu beberapa menit.';
  if (m.includes('network') || m.includes('fetch'))
    return 'Gagal terhubung. Periksa koneksi internetmu.';
  return message;
}

// ══════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════

(async function initAuth() {
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session?.user) {
      currentUser = session.user;
      await onAuthSuccess(session.user);
    } else {
      showAuthScreen();
    }
  } catch (err) {
    console.error('[ElChat] Init auth error:', err);
    showAuthScreen();
  }

  supabaseClient.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session?.user) {
      currentUser = session.user;
      await onAuthSuccess(session.user);
    } else if (event === 'SIGNED_OUT') {
      currentUser = null;
      showAuthScreen();
    }
  });
})();
