/* ═══════════════════════════════════════════════
   ELCHAT — AUTH.JS
   Supabase Authentication Module
   Handles: Email/Password Sign-up & Login, Google OAuth,
            Username uniqueness check, Password validation
═══════════════════════════════════════════════ */

// ── Supabase Configuration ─────────────────────
// ⚠️  GANTI dengan URL dan Anon Key Supabase proyekmu
const SUPABASE_URL  = 'https://sxdegbjhumiurcrfcanh.supabase.co';
const SUPABASE_ANON = 'sb_publishable_GOBXegDYbp0Q02ds14BpUQ_heHwrd4o';

// Inisialisasi Supabase client (tersedia via CDN)
const { createClient } = supabase;
const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON);

// ── State Management ───────────────────────────
let usernameCheckTimer = null;   // Debounce timer untuk pengecekan username
let currentUser       = null;   // Data session user yang aktif

// ══════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════

/**
 * Tampilkan/sembunyikan loading state pada tombol
 * @param {string} btnId - ID elemen tombol
 * @param {boolean} loading - Status loading
 */
function setButtonLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  const text   = btn.querySelector('.btn__text');
  const loader = btn.querySelector('.btn__loader');
  btn.disabled = loading;
  if (text)   text.hidden  = loading;
  if (loader) loader.hidden = !loading;
}

/**
 * Tampilkan pesan error pada elemen tertentu
 * @param {string} elementId - ID elemen error
 * @param {string} message   - Pesan yang ditampilkan (kosong = hapus error)
 */
function showError(elementId, message) {
  const el = document.getElementById(elementId);
  if (el) el.textContent = message;
}

/**
 * Tampilkan notifikasi toast sementara
 * @param {string} message - Pesan toast
 * @param {'success'|'error'|''} type - Tipe visual
 */
function showToast(message, type = '') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className   = `toast${type ? ` toast--${type}` : ''} show`;
  setTimeout(() => { toast.className = 'toast'; }, 3000);
}

/**
 * Toggle visibility password input
 */
function togglePassword(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const isHidden = input.type === 'password';
  input.type = isHidden ? 'text' : 'password';
  btn.setAttribute('aria-label', isHidden ? 'Sembunyikan sandi' : 'Tampilkan sandi');
}

/**
 * Alih tampilan antara tab Login dan Register
 * @param {'login'|'register'} tab
 */
function switchTab(tab) {
  const indicator = document.getElementById('tab-indicator');
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
    indicator.classList.remove('right');
  } else {
    registerPanel.classList.add('active');
    loginPanel.classList.remove('active');
    tabRegister.classList.add('active');
    tabLogin.classList.remove('active');
    tabRegister.setAttribute('aria-selected', 'true');
    tabLogin.setAttribute('aria-selected', 'false');
    indicator.classList.add('right');
  }

  // Bersihkan semua pesan error
  showError('login-error', '');
  showError('register-error', '');
  showError('username-error', '');
}

// ══════════════════════════════════════════════
// VALIDASI
// ══════════════════════════════════════════════

/**
 * Validasi kekuatan password:
 * - Minimal 7 karakter
 * - Harus mengandung angka ATAU simbol khusus
 * @param {string} password
 * @returns {{ valid: boolean, message: string, strength: number }}
 */
function validatePassword(password) {
  const minLength  = password.length >= 7;
  const hasNumber  = /\d/.test(password);
  const hasSymbol  = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(password);
  const hasUpper   = /[A-Z]/.test(password);

  if (!minLength) return { valid: false, message: 'Kata sandi minimal 7 karakter.', strength: 0 };
  if (!hasNumber && !hasSymbol) return { valid: false, message: 'Harus mengandung angka atau simbol khusus.', strength: 1 };

  // Hitung skor kekuatan
  let score = 1;
  if (hasNumber && hasSymbol) score++;
  if (hasUpper) score++;
  if (password.length >= 12) score++;

  return { valid: true, message: '', strength: score };
}

/**
 * Tampilkan visual indikator kekuatan password secara real-time
 * @param {string} password
 */
function validatePasswordStrength(password) {
  const container = document.getElementById('pw-strength');
  const fill      = document.getElementById('pw-strength-fill');
  const label     = document.getElementById('pw-strength-label');
  if (!container || !fill || !label) return;

  if (!password) {
    container.hidden = true;
    return;
  }

  container.hidden = false;
  const { strength } = validatePassword(password);

  const levels = [
    { pct: '15%',  color: '#ef5350', text: 'Sangat Lemah', css: 'var(--accent-red)' },
    { pct: '35%',  color: '#FF9800', text: 'Lemah',        css: '#FF9800' },
    { pct: '60%',  color: '#FFCA28', text: 'Sedang',       css: 'var(--accent-amber)' },
    { pct: '85%',  color: '#66BB6A', text: 'Kuat',         css: 'var(--accent-green)' },
    { pct: '100%', color: '#26C6DA', text: 'Sangat Kuat',  css: 'var(--accent-blue)' },
  ];

  const level = levels[Math.min(strength, levels.length - 1)];
  fill.style.width           = level.pct;
  fill.style.backgroundColor = level.color;
  label.textContent          = level.text;
  label.style.color          = level.css;
}

/**
 * Validasi format username:
 * - Minimal 3 karakter
 * - Hanya boleh huruf, angka, titik, underscore, atau strip
 * @param {string} username
 * @returns {{ valid: boolean, message: string }}
 */
function validateUsername(username) {
  if (!username || username.length < 3) {
    return { valid: false, message: 'Username minimal 3 karakter.' };
  }
  const pattern = /^[a-zA-Z0-9._-]+$/;
  if (!pattern.test(username)) {
    return { valid: false, message: 'Hanya huruf, angka, titik (.), underscore (_), atau strip (-) yang diizinkan.' };
  }
  return { valid: true, message: '' };
}

// ══════════════════════════════════════════════
// USERNAME AVAILABILITY CHECK (Realtime)
// ══════════════════════════════════════════════

/**
 * Pengecekan ketersediaan username secara realtime ke Supabase.
 * Debounced 600ms untuk menghindari terlalu banyak query.
 * @param {string} rawValue - Nilai input mentah (tanpa '@')
 */
function checkUsernameAvailability(rawValue) {
  const username    = rawValue.trim().toLowerCase();
  const statusEl    = document.getElementById('username-status');
  const errorEl     = document.getElementById('username-error');
  const inputEl     = document.getElementById('reg-username');

  // Reset
  showError('username-error', '');
  if (statusEl) statusEl.textContent = '';
  if (inputEl)  inputEl.classList.remove('error');

  if (!username) return;

  // Validasi format lokal terlebih dahulu
  const { valid, message } = validateUsername(username);
  if (!valid) {
    showError('username-error', message);
    if (inputEl) inputEl.classList.add('error');
    return;
  }

  // Tampilkan indikator "sedang mengecek"
  if (statusEl) statusEl.textContent = '🔄';

  // Debounce: tunggu 600ms setelah user berhenti mengetik
  clearTimeout(usernameCheckTimer);
  usernameCheckTimer = setTimeout(async () => {
    try {
      const { data, error } = await supabaseClient
        .from('profiles')
        .select('username')
        .eq('username', username)
        .maybeSingle();

      if (error) throw error;

      if (data) {
        // Username sudah digunakan
        showError('username-error', 'Username sudah digunakan. Coba yang lain.');
        if (statusEl) statusEl.textContent = '❌';
        if (inputEl)  inputEl.classList.add('error');
      } else {
        // Username tersedia
        showError('username-error', '');
        if (statusEl) statusEl.textContent = '✅';
        if (inputEl)  inputEl.classList.remove('error');
      }
    } catch (err) {
      console.warn('[ElChat] Gagal mengecek username:', err.message);
      if (statusEl) statusEl.textContent = '';
    }
  }, 600);
}

// ══════════════════════════════════════════════
// AUTH HANDLERS
// ══════════════════════════════════════════════

/**
 * Daftar akun baru dengan Email, Password, dan Username.
 * Setelah berhasil, profil user dibuat di tabel 'profiles'.
 */
async function handleRegister() {
  const email    = document.getElementById('reg-email')?.value.trim();
  const username = document.getElementById('reg-username')?.value.trim().toLowerCase();
  const password = document.getElementById('reg-password')?.value;
  const confirm  = document.getElementById('reg-confirm')?.value;

  // Bersihkan error sebelumnya
  showError('register-error', '');

  // Validasi dasar
  if (!email || !username || !password || !confirm) {
    showError('register-error', 'Semua kolom wajib diisi.');
    return;
  }

  // Validasi format email sederhana
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showError('register-error', 'Format email tidak valid.');
    return;
  }

  // Validasi username
  const usernameCheck = validateUsername(username);
  if (!usernameCheck.valid) {
    showError('register-error', usernameCheck.message);
    return;
  }

  // Validasi password
  const pwCheck = validatePassword(password);
  if (!pwCheck.valid) {
    showError('register-error', pwCheck.message);
    return;
  }

  // Validasi konfirmasi password
  if (password !== confirm) {
    showError('register-error', 'Konfirmasi kata sandi tidak cocok.');
    return;
  }

  setButtonLoading('btn-register', true);

  try {
    // 1. Periksa ulang ketersediaan username sebelum mendaftar
    const { data: existing } = await supabaseClient
      .from('profiles')
      .select('username')
      .eq('username', username)
      .maybeSingle();

    if (existing) {
      showError('register-error', 'Username sudah digunakan. Silakan pilih username lain.');
      setButtonLoading('btn-register', false);
      return;
    }

    // 2. Daftarkan user ke Supabase Auth
    const { data: authData, error: authError } = await supabaseClient.auth.signUp({
      email,
      password,
      options: {
        data: { username }   // Disimpan di user_metadata sebagai cadangan
      }
    });

    if (authError) throw authError;

    const userId = authData.user?.id;
    if (!userId) throw new Error('User ID tidak ditemukan setelah pendaftaran.');

    // 3. Buat profil di tabel 'profiles'
    //    Tabel harus memiliki kolom: id (FK ke auth.users), username, role, created_at
    const { error: profileError } = await supabaseClient
      .from('profiles')
      .insert([{
        id:       userId,
        username: username,
        email:    email,
        role:     'user',      // Default role
        avatar_url: null
      }]);

    if (profileError) throw profileError;

    showToast('Akun berhasil dibuat! Silakan cek email untuk verifikasi.', 'success');
    switchTab('login');

    // Isi otomatis email di form login
    const loginEmail = document.getElementById('login-email');
    if (loginEmail) loginEmail.value = email;

  } catch (err) {
    console.error('[ElChat] Register error:', err);
    const msg = mapAuthError(err.message);
    showError('register-error', msg);
  } finally {
    setButtonLoading('btn-register', false);
  }
}

/**
 * Login menggunakan Email dan Password.
 */
async function handleLogin() {
  const email    = document.getElementById('login-email')?.value.trim();
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

/**
 * Login menggunakan akun Google (OAuth — redirect flow).
 */
async function handleGoogleLogin() {
  setButtonLoading('btn-google', true);

  try {
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + window.location.pathname
      }
    });
    if (error) throw error;
    // Supabase akan redirect ke Google. Tidak perlu action lanjutan di sini.

  } catch (err) {
    console.error('[ElChat] Google login error:', err);
    showToast(mapAuthError(err.message), 'error');
    setButtonLoading('btn-google', false);
  }
}

/**
 * Logout pengguna — hapus session Supabase dan tampilkan layar auth kembali.
 */
async function handleLogout() {
  try {
    await supabaseClient.auth.signOut();
    currentUser = null;
    showAuthScreen();
    showToast('Berhasil keluar.', 'success');
  } catch (err) {
    console.error('[ElChat] Logout error:', err);
    showToast('Gagal keluar. Coba lagi.', 'error');
  }
}

// ══════════════════════════════════════════════
// SESSION & NAVIGATION
// ══════════════════════════════════════════════

/**
 * Dipanggil setelah login berhasil.
 * Mengambil data profil (termasuk role) dari Supabase dan
 * menginisialisasi tampilan aplikasi utama.
 * @param {object} user - User object dari Supabase Auth
 */
async function onAuthSuccess(user) {
  try {
    // Ambil profil lengkap termasuk role dari tabel 'profiles'
    const { data: profile, error } = await supabaseClient
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    // Jika profil belum ada (misalnya login Google pertama kali), buat profil default
    if (!profile) {
      const username = user.user_metadata?.full_name?.replace(/\s+/g, '').toLowerCase()
                       || `user_${user.id.substring(0, 6)}`;

      await supabaseClient.from('profiles').insert([{
        id:        user.id,
        username:  username,
        email:     user.email,
        role:      'user',
        avatar_url: user.user_metadata?.avatar_url || null
      }]);

      user.profile = { role: 'user', username };
    } else {
      user.profile = profile;
    }

    // Simpan ke session storage agar bisa diakses di app.js
    sessionStorage.setItem('elchat_user', JSON.stringify({
      id:       user.id,
      email:    user.email,
      role:     user.profile.role,
      username: user.profile.username,
      avatar:   user.profile.avatar_url || user.user_metadata?.avatar_url || null
    }));

    // Panggil fungsi dari app.js untuk mengatur tampilan sesuai role
    if (typeof initApp === 'function') {
      initApp(user.profile);
    }

  } catch (err) {
    console.error('[ElChat] Gagal memuat profil:', err);
    showToast('Gagal memuat profil. Mencoba lagi...', 'error');
  }
}

/**
 * Tampilkan layar auth dan sembunyikan layar app
 */
function showAuthScreen() {
  const authScreen = document.getElementById('auth-screen');
  const appScreen  = document.getElementById('app-screen');
  if (authScreen) { authScreen.classList.add('active'); }
  if (appScreen)  { appScreen.hidden = true; appScreen.classList.remove('active'); }
  sessionStorage.removeItem('elchat_user');
}

// ══════════════════════════════════════════════
// ERROR MESSAGE MAPPING
// ══════════════════════════════════════════════

/**
 * Terjemahkan pesan error Supabase ke Bahasa Indonesia yang ramah
 * @param {string} message - Pesan error asli dari Supabase
 * @returns {string}
 */
function mapAuthError(message) {
  if (!message) return 'Terjadi kesalahan. Coba lagi.';
  const m = message.toLowerCase();

  if (m.includes('invalid login credentials') || m.includes('invalid email or password')) {
    return 'Email atau kata sandi tidak sesuai.';
  }
  if (m.includes('email not confirmed')) {
    return 'Email belum diverifikasi. Cek kotak masuk atau spam-mu.';
  }
  if (m.includes('user already registered') || m.includes('already been registered')) {
    return 'Email ini sudah terdaftar. Silakan login.';
  }
  if (m.includes('password should be at least')) {
    return 'Kata sandi terlalu pendek (minimal 7 karakter).';
  }
  if (m.includes('rate limit')) {
    return 'Terlalu banyak percobaan. Tunggu beberapa menit.';
  }
  if (m.includes('network') || m.includes('fetch')) {
    return 'Gagal terhubung. Periksa koneksi internetmu.';
  }

  return message;
}

// ══════════════════════════════════════════════
// INIT — Periksa session saat halaman dimuat
// ══════════════════════════════════════════════

(async function initAuth() {
  try {
    // Supabase v2: getSession() memeriksa session aktif dari cookie/localStorage
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

  // Listener untuk perubahan state auth (OAuth redirect, session expire, dll.)
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
