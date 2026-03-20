/* ═══════════════════════════════════════════════
   ELCHAT — APP.JS
   Main Application Logic
   Handles: Role-based Navigation, Page Routing,
            UI Initialization, Session Management
═══════════════════════════════════════════════ */

'use strict';

// ── Konstanta Navigasi ─────────────────────────
/**
 * Definisi item navigasi beserta aturan akses per role.
 * visible: ['user','admin','developer'] berarti semua role dapat melihat item ini.
 * Urutan menentukan posisi tampil di bottom nav.
 */
const NAV_ITEMS = [
  {
    id:      'chat',
    label:   'Chat',
    page:    'page-chat',
    visible: ['user', 'admin', 'developer'],
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
             <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
           </svg>`,
  },
  {
    id:      'calls',
    label:   'Panggilan',
    page:    'page-calls',
    visible: ['user', 'admin', 'developer'],
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
             <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81 19.79 19.79 0 01.07 1.18a2 2 0 012-2.18h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.91 6.83a16 16 0 006.29 6.29l1.12-1.12a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7a2 2 0 011.72 2z"/>
           </svg>`,
  },
  {
    id:      'stories',
    label:   'Cerita',
    page:    'page-stories',
    visible: ['user', 'admin', 'developer'],
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
             <circle cx="12" cy="12" r="10"/>
             <circle cx="12" cy="12" r="4"/>
             <line x1="4.93" y1="4.93" x2="9.17" y2="9.17"/>
             <line x1="14.83" y1="14.83" x2="19.07" y2="19.07"/>
             <line x1="14.83" y1="9.17" x2="19.07" y2="4.93"/>
             <line x1="4.93" y1="19.07" x2="9.17" y2="14.83"/>
           </svg>`,
  },
  {
    id:      'admin',
    label:   'Admin',
    page:    'page-admin',
    visible: ['admin', 'developer'],   // User biasa tidak dapat melihat ini
    cssClass: 'nav-item--admin',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
             <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
           </svg>`,
  },
  {
    id:      'developer',
    label:   'Dev',
    page:    'page-developer',
    visible: ['developer'],            // Hanya developer
    cssClass: 'nav-item--dev',
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
             <polyline points="16 18 22 12 16 6"/>
             <polyline points="8 6 2 12 8 18"/>
           </svg>`,
  }
];

// ── State Aplikasi ─────────────────────────────
let activeNavId  = 'chat';   // Halaman yang sedang aktif
let currentProfile = null;   // Profil user yang sedang login

// ══════════════════════════════════════════════
// INIT — Entry Point dari auth.js
// ══════════════════════════════════════════════

/**
 * Dipanggil oleh auth.js setelah login berhasil.
 * Mengatur seluruh UI aplikasi utama berdasarkan data profil.
 * @param {object} profile - Data profil dari tabel Supabase 'profiles'
 */
function initApp(profile) {
  currentProfile = profile;

  // 1. Sembunyikan auth screen, tampilkan app screen
  const authScreen = document.getElementById('auth-screen');
  const appScreen  = document.getElementById('app-screen');
  if (authScreen) authScreen.classList.remove('active');
  if (appScreen)  { appScreen.hidden = false; requestAnimationFrame(() => appScreen.classList.add('active')); }

  // 2. Render avatar / inisial pengguna
  renderUserAvatar(profile);

  // 3. Bangun bottom navigation sesuai role
  buildNavigation(profile.role);

  // 4. Navigasi ke halaman Chat sebagai default
  navigateTo('chat');
  // initChatPage() dipanggil otomatis di dalam navigateTo saat pageId === 'chat'

  // 5. Khusus developer: tampilkan status koneksi database
  if (profile.role === 'developer') {
    checkDatabaseStatus();
  }

  // 6. Inisialisasi modul profil (muat privasi status dari cache)
  if (typeof initProfileModule === 'function') initProfileModule();
}

// ══════════════════════════════════════════════
// AVATAR
// ══════════════════════════════════════════════

/**
 * Render avatar di header. Gunakan foto jika tersedia,
 * atau inisial username sebagai fallback.
 * @param {object} profile
 */
function renderUserAvatar(profile) {
  const avatarEl = document.getElementById('user-avatar');
  if (!avatarEl) return;

  if (profile.avatar_url) {
    avatarEl.style.backgroundImage = `url(${profile.avatar_url})`;
    avatarEl.style.backgroundSize  = 'cover';
    avatarEl.style.backgroundPosition = 'center';
  } else {
    // Tampilkan inisial dari username
    const initials = (profile.username || profile.email || 'U')
      .replace('@', '')
      .substring(0, 2)
      .toUpperCase();
    avatarEl.textContent = initials;
  }

  avatarEl.title = `@${profile.username || 'profil saya'}`;
}

// ══════════════════════════════════════════════
// NAVIGATION BUILDER
// ══════════════════════════════════════════════

/**
 * Membangun bottom navigation secara dinamis berdasarkan role.
 * 
 * Hierarki akses:
 *  - 'user'      → hanya melihat: Chat, Panggilan, Cerita
 *  - 'admin'     → melihat semua menu user + Menu Admin
 *  - 'developer' → melihat semua menu admin + Dev Console
 *    (Developer mewarisi akses Admin, bukan sebaliknya)
 *
 * @param {string} role - Role user: 'user' | 'admin' | 'developer'
 */
function buildNavigation(role) {
  const nav = document.getElementById('bottom-nav');
  if (!nav) return;

  // Filter item navigasi berdasarkan role
  const visibleItems = NAV_ITEMS.filter(item => item.visible.includes(role));

  nav.innerHTML = visibleItems.map(item => `
    <button
      class="nav-item ${item.cssClass || ''}"
      id="nav-${item.id}"
      data-page="${item.id}"
      aria-label="${item.label}"
      onclick="navigateTo('${item.id}')"
    >
      ${item.icon}
      <span class="nav-label">${item.label}</span>
    </button>
  `).join('');
}

// ══════════════════════════════════════════════
// PAGE ROUTING
// ══════════════════════════════════════════════

/**
 * Navigasi ke halaman tertentu.
 * Mengelola state aktif pada tombol nav dan konten halaman.
 * @param {string} pageId - ID navigasi (misalnya 'chat', 'admin')
 */
function navigateTo(pageId) {
  // Cari definisi nav item yang sesuai
  const navItem = NAV_ITEMS.find(i => i.id === pageId);
  if (!navItem) return;

  // Verifikasi akses: pastikan user memiliki hak untuk halaman ini
  if (currentProfile && !navItem.visible.includes(currentProfile.role)) {
    showToast('Akses ditolak.', 'error');
    return;
  }

  activeNavId = pageId;

  // ── Update tombol navigasi ──
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === pageId);
  });

  // ── Update konten halaman ──
  document.querySelectorAll('.page').forEach(page => {
    page.classList.toggle('active', page.id === navItem.page);
  });

  // ── Update judul header ──
  const titleEl = document.getElementById('page-title');
  if (titleEl) titleEl.textContent = navItem.label;

  // ── Header & inisialisasi khusus per halaman ──
  if (pageId === 'chat') {
    if (typeof initChatPage    === 'function') initChatPage();
  } else if (pageId === 'stories') {
    if (typeof initStoriesPage === 'function') initStoriesPage();
  } else {
    // Kembalikan ke header default dan tutup elemen chat yang masih terbuka
    if (typeof switchToDefaultHeader === 'function') switchToDefaultHeader();
  }
}

// ══════════════════════════════════════════════
// DEVELOPER TOOLS
// ══════════════════════════════════════════════

/**
 * Tampilkan status koneksi database di Dev Console.
 * Khusus untuk user dengan role 'developer'.
 */
async function checkDatabaseStatus() {
  const statusEl = document.getElementById('db-status');
  if (!statusEl) return;

  try {
    // Coba query sederhana ke Supabase untuk verifikasi koneksi
    const { error } = await supabaseClient.from('profiles').select('id').limit(1);
    statusEl.textContent = error ? `❌ Error: ${error.message}` : '✅ Connected';
    statusEl.style.color = error ? 'var(--accent-red)' : 'var(--accent-green)';
  } catch {
    statusEl.textContent = '❌ Offline';
    statusEl.style.color = 'var(--accent-red)';
  }
}

// ══════════════════════════════════════════════
// UTILITY
// ══════════════════════════════════════════════

/**
 * Tampilkan toast notification (reexport untuk digunakan di file lain)
 * Fungsi utama ada di auth.js namun diduplikasi di sini untuk kemudahan
 */
function showToast(message, type = '') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className   = `toast${type ? ` toast--${type}` : ''} show`;
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3000);
}

// ══════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ══════════════════════════════════════════════

document.addEventListener('keydown', (e) => {
  // Enter pada input auth juga bisa trigger aksi
  if (e.key === 'Enter') {
    const authScreen = document.getElementById('auth-screen');
    if (!authScreen?.classList.contains('active')) return;

    const activePanel = document.querySelector('.auth-panel.active');
    if (!activePanel) return;

    if (activePanel.id === 'panel-login') {
      handleLogin();
    } else if (activePanel.id === 'panel-register') {
      handleRegister();
    }
  }
});
