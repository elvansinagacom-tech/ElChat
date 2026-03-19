/* ═══════════════════════════════════════════════
   ELCHAT — CHAT.JS
   Chat Page Module
   Handles: Room List Loading, Global Room pinning,
            User Search, Dropdown Menu, Header Switching,
            Filter Pills, FAB, Realtime updates
═══════════════════════════════════════════════ */

'use strict';

// ── Module State ───────────────────────────────
const ChatModule = {
  rooms:          [],         // Semua room yang dimuat
  filteredRooms:  [],         // Setelah filter pills diterapkan
  activeFilter:   'all',      // Filter aktif saat ini
  searchOpen:     false,      // Apakah search bar sedang terbuka
  menuOpen:       false,      // Apakah dropdown menu terbuka
  searchTimer:    null,       // Debounce timer pencarian
  realtimeChannel: null,      // Supabase realtime channel
};

// Gradient palette untuk avatar room (bergilir berdasarkan index)
const AVATAR_GRADIENTS = [
  'room-avatar--gradient-1',
  'room-avatar--gradient-2',
  'room-avatar--gradient-3',
  'room-avatar--gradient-4',
  'room-avatar--gradient-5',
];

// ══════════════════════════════════════════════
// INIT — dipanggil dari app.js saat halaman Chat aktif
// ══════════════════════════════════════════════

/**
 * Inisialisasi Chat Page.
 * Memuat daftar room, menyiapkan header khusus chat,
 * dan subscribe ke realtime updates.
 */
async function initChatPage() {
  switchToChatHeader();
  await loadChatRooms();
  subscribeToChatUpdates();
  // Inisialisasi modul permintaan chat (badge + realtime)
  if (typeof initRequestsModule === 'function') initRequestsModule();
}

// ══════════════════════════════════════════════
// HEADER MANAGEMENT
// ══════════════════════════════════════════════

/**
 * Tampilkan header versi Chat (Logo ElChat + Search + Dropdown).
 * Sembunyikan header versi default (judul halaman).
 */
function switchToChatHeader() {
  const defaultHeader = document.getElementById('header-default');
  const chatHeader    = document.getElementById('header-chat');
  if (defaultHeader) defaultHeader.hidden = true;
  if (chatHeader)    chatHeader.hidden    = false;
}

/**
 * Tampilkan header versi default untuk halaman selain Chat.
 */
function switchToDefaultHeader() {
  const defaultHeader = document.getElementById('header-default');
  const chatHeader    = document.getElementById('header-chat');
  if (defaultHeader) defaultHeader.hidden = false;
  if (chatHeader)    chatHeader.hidden    = true;

  // Tutup search dan dropdown jika masih terbuka
  closeChatSearch();
  closeChatMenu();
}

// ══════════════════════════════════════════════
// DROPDOWN MENU
// ══════════════════════════════════════════════

/**
 * Toggle dropdown menu titik tiga.
 * Klik di luar akan menutupnya (lihat event listener di bawah).
 */
function toggleChatMenu() {
  const menu    = document.getElementById('chat-dropdown-menu');
  const btn     = document.getElementById('btn-chat-menu');
  ChatModule.menuOpen = !ChatModule.menuOpen;

  if (menu) {
    menu.classList.toggle('open', ChatModule.menuOpen);
    menu.setAttribute('aria-hidden', String(!ChatModule.menuOpen));
  }
  if (btn) btn.setAttribute('aria-expanded', String(ChatModule.menuOpen));
}

function closeChatMenu() {
  const menu = document.getElementById('chat-dropdown-menu');
  const btn  = document.getElementById('btn-chat-menu');
  ChatModule.menuOpen = false;
  if (menu) { menu.classList.remove('open'); menu.setAttribute('aria-hidden', 'true'); }
  if (btn)  btn.setAttribute('aria-expanded', 'false');
}

/** Navigasi ke halaman Profil (placeholder — akan diimplementasi di Prompt berikutnya) */
function goToProfile() {
  closeChatMenu();
  showToast('Halaman profil akan segera hadir.', '');
}

/** Navigasi ke halaman Pengaturan (placeholder) */
function goToSettings() {
  closeChatMenu();
  showToast('Halaman pengaturan akan segera hadir.', '');
}

// Tutup dropdown saat klik di luar
document.addEventListener('click', (e) => {
  if (!ChatModule.menuOpen) return;
  const wrapper = document.getElementById('chat-dropdown-wrapper');
  if (wrapper && !wrapper.contains(e.target)) closeChatMenu();
});

// ══════════════════════════════════════════════
// SEARCH BAR
// ══════════════════════════════════════════════

/**
 * Toggle visibilitas search bar.
 * Saat dibuka, auto-focus input dan reset hasil sebelumnya.
 */
function toggleChatSearch() {
  const bar   = document.getElementById('chat-search-bar');
  const input = document.getElementById('user-search-input');
  ChatModule.searchOpen = !ChatModule.searchOpen;

  if (bar) {
    bar.classList.toggle('open', ChatModule.searchOpen);
    bar.setAttribute('aria-hidden', String(!ChatModule.searchOpen));
  }

  if (ChatModule.searchOpen) {
    closeChatMenu();
    setTimeout(() => input?.focus(), 200);
  } else {
    closeChatSearch();
  }
}

function closeChatSearch() {
  const bar   = document.getElementById('chat-search-bar');
  const input = document.getElementById('user-search-input');
  const results = document.getElementById('search-results');

  ChatModule.searchOpen = false;
  if (bar)   { bar.classList.remove('open'); bar.setAttribute('aria-hidden', 'true'); }
  if (input)   input.value = '';
  if (results) results.innerHTML = '';
}

/**
 * Pencarian pengguna berdasarkan username atau display name.
 * Query ke tabel 'profiles' Supabase, di-debounce 450ms.
 * @param {string} query - Teks yang diketik user (dengan atau tanpa '@')
 */
function handleUserSearch(query) {
  const resultsEl = document.getElementById('search-results');
  if (!resultsEl) return;

  const term = query.trim().replace(/^@/, '');

  if (!term) {
    resultsEl.innerHTML = '';
    return;
  }

  // Tampilkan loading
  resultsEl.innerHTML = `<div class="search-loading">Mencari...</div>`;

  clearTimeout(ChatModule.searchTimer);
  ChatModule.searchTimer = setTimeout(async () => {
    await performUserSearch(term, resultsEl);
  }, 450);
}

/**
 * Eksekusi query pencarian ke Supabase.
 * Mencari kolom 'username' DAN 'full_name' (jika ada).
 * @param {string} term - Kata kunci pencarian
 * @param {HTMLElement} container - Elemen untuk menampilkan hasil
 */
async function performUserSearch(term, container) {
  try {
    // Query: username mengandung term ATAU full_name mengandung term
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('id, username, full_name, avatar_url')
      .or(`username.ilike.%${term}%,full_name.ilike.%${term}%`)
      .neq('id', currentProfile?.id ?? '')   // Kecualikan diri sendiri
      .limit(15);

    if (error) throw error;

    if (!data || data.length === 0) {
      container.innerHTML = `<div class="search-no-result">Tidak ada pengguna ditemukan untuk "<strong>@${term}</strong>"</div>`;
      return;
    }

    container.innerHTML = data.map(user => renderSearchResultItem(user)).join('');

  } catch (err) {
    console.error('[ElChat] Search error:', err);
    container.innerHTML = `<div class="search-no-result">Gagal mencari. Periksa koneksimu.</div>`;
  }
}

/**
 * Render HTML satu item hasil pencarian pengguna.
 * Klik akan membuka Bridge Modal, bukan langsung ke chat.
 * @param {object} user - Data profil dari Supabase
 * @returns {string} HTML string
 */
function renderSearchResultItem(user) {
  const displayName = user.full_name || `@${user.username}`;
  const initials    = (user.username || 'U').substring(0, 2).toUpperCase();
  const avatarHtml  = user.avatar_url
    ? `<img src="${escapeHtml(user.avatar_url)}" alt="${escapeHtml(displayName)}" loading="lazy" />`
    : initials;

  // Encode data pengguna sebagai JSON aman untuk atribut data-*
  const safeData = escapeHtml(JSON.stringify({
    id: user.id, username: user.username,
    full_name: user.full_name || null,
    avatar_url: user.avatar_url || null,
    bio: user.bio || null,
  }));

  return `
    <div class="search-result-item" onclick="openBridgeModal(${safeData})">
      <div class="search-result-item__avatar">${avatarHtml}</div>
      <div class="search-result-item__info">
        <div class="search-result-item__name">${escapeHtml(displayName)}</div>
        <div class="search-result-item__username">@${escapeHtml(user.username)}</div>
      </div>
      <button class="search-result-item__action" onclick="event.stopPropagation(); openBridgeModal(${safeData})">
        Lihat
      </button>
    </div>
  `;
}

// ══════════════════════════════════════════════
// CHAT ROOM LOADING
// ══════════════════════════════════════════════

/**
 * Memuat daftar room chat dari Supabase.
 * Terdiri dari dua bagian:
 *   1. Grup Global (is_global = true) — selalu tampil di atas untuk semua user
 *   2. Room yang diikuti user (room_members JOIN rooms)
 *
 * Skema database yang diperlukan:
 *   - rooms:       id, name, description, avatar_url, is_global, last_message, last_message_at
 *   - room_members: room_id, user_id, unread_count, joined_at
 */
async function loadChatRooms() {
  const skeleton = document.getElementById('chat-skeleton');
  const listEl   = document.getElementById('chat-list');
  const emptyEl  = document.getElementById('chat-empty');

  // Tampilkan skeleton
  if (skeleton) skeleton.style.display = 'block';
  if (emptyEl)  emptyEl.hidden = true;

  try {
    const userId = currentProfile?.id;
    if (!userId) throw new Error('User belum login.');

    // ── Query 1: Grup Global ──────────────────────
    const { data: globalRooms, error: globalErr } = await supabaseClient
      .from('rooms')
      .select('id, name, description, avatar_url, last_message, last_message_at')
      .eq('is_global', true)
      .order('name');

    if (globalErr) throw globalErr;

    // ── Query 2: Room yang diikuti user ────────────
    const { data: memberRooms, error: memberErr } = await supabaseClient
      .from('room_members')
      .select(`
        unread_count,
        joined_at,
        rooms (
          id, name, description, avatar_url,
          last_message, last_message_at, is_global
        )
      `)
      .eq('user_id', userId)
      .order('rooms(last_message_at)', { ascending: false, nullsFirst: false });

    if (memberErr) throw memberErr;

    // Gabungkan dan hilangkan duplikat (Grup Global mungkin juga ada di room_members)
    const globalIds    = new Set((globalRooms || []).map(r => r.id));
    const personalRooms = (memberRooms || [])
      .filter(m => m.rooms && !globalIds.has(m.rooms.id))
      .map(m => ({ ...m.rooms, unread_count: m.unread_count || 0 }));

    // Tandai global rooms
    const globalRoomsTagged = (globalRooms || []).map(r => ({ ...r, is_global: true, unread_count: 0 }));

    ChatModule.rooms = [...globalRoomsTagged, ...personalRooms];
    ChatModule.filteredRooms = [...ChatModule.rooms];

    // Render
    renderChatList(ChatModule.rooms, skeleton, listEl, emptyEl);

  } catch (err) {
    console.error('[ElChat] Load rooms error:', err);
    if (skeleton) skeleton.style.display = 'none';

    // Fallback: tampilkan mockup data jika Supabase belum dikonfigurasi
    renderFallbackRooms(listEl, skeleton, emptyEl);
  }
}

/**
 * Render daftar chat room ke DOM.
 * @param {Array}       rooms    - Array data room
 * @param {HTMLElement} skeleton - Skeleton loader element
 * @param {HTMLElement} listEl   - Container list
 * @param {HTMLElement} emptyEl  - Empty state element
 */
function renderChatList(rooms, skeleton, listEl, emptyEl) {
  if (skeleton) skeleton.style.display = 'none';

  if (!rooms || rooms.length === 0) {
    if (emptyEl) emptyEl.hidden = false;
    return;
  }

  // Pisahkan global dari personal untuk section header
  const globals   = rooms.filter(r => r.is_global);
  const personals = rooms.filter(r => !r.is_global);

  let html = '';

  if (globals.length > 0) {
    html += `<div class="chat-section-header">Global</div>`;
    html += globals.map((r, i) => renderRoomItem(r, i, true)).join('');
  }

  if (personals.length > 0) {
    html += `<div class="chat-section-header">Percakapan</div>`;
    html += personals.map((r, i) => renderRoomItem(r, i, false)).join('');
  }

  // Hapus skeleton lama dan isi dengan konten baru
  // (skeleton sudah di-hide, tinggal append HTML)
  if (skeleton) skeleton.remove();
  if (listEl)   listEl.insertAdjacentHTML('beforeend', html);
}

/**
 * Render satu item room chat sebagai HTML string.
 * @param {object}  room     - Data room
 * @param {number}  index    - Indeks untuk memilih gradient avatar
 * @param {boolean} isGlobal - Apakah ini Grup Global
 * @returns {string}
 */
function renderRoomItem(room, index, isGlobal) {
  const gradientClass = isGlobal ? 'room-avatar--global' : AVATAR_GRADIENTS[index % AVATAR_GRADIENTS.length];
  const initials      = (room.name || 'R').substring(0, 2).toUpperCase();
  const lastMsg       = room.last_message || 'Belum ada pesan';
  const lastMsgClass  = room.last_message ? '' : 'room-info__last-msg--italic';
  const timeStr       = formatChatTime(room.last_message_at);
  const unread        = room.unread_count || 0;

  const avatarContent = room.avatar_url
    ? `<img src="${escapeHtml(room.avatar_url)}" alt="${escapeHtml(room.name)}" loading="lazy" />`
    : initials;

  const unreadHtml = unread > 0
    ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>`
    : '';

  const globalBadge = isGlobal
    ? `<span class="global-badge">Global</span>`
    : unreadHtml;

  return `
    <div class="chat-room-item ${isGlobal ? 'chat-room-item--global' : ''}"
         onclick="openRoom('${escapeHtml(room.id)}', '${escapeHtml(room.name)}')"
         role="button"
         tabindex="0"
         aria-label="Buka ${escapeHtml(room.name)}"
         onkeydown="if(event.key==='Enter') openRoom('${escapeHtml(room.id)}', '${escapeHtml(room.name)}')"
    >
      <div class="room-avatar ${gradientClass}">${avatarContent}</div>
      <div class="room-info">
        <div class="room-info__top">
          <span class="room-info__name">${escapeHtml(room.name)}</span>
          <span class="room-info__time">${timeStr}</span>
        </div>
        <div class="room-info__bottom">
          <span class="room-info__last-msg ${lastMsgClass}">${escapeHtml(lastMsg)}</span>
          ${globalBadge}
        </div>
      </div>
    </div>
  `;
}

/**
 * Tampilkan data mockup jika koneksi Supabase belum terkonfigurasi.
 * Berguna selama pengembangan lokal.
 */
function renderFallbackRooms(listEl, skeleton, emptyEl) {
  const mockRooms = [
    { id: 'global-1',  name: 'Grup Global',    last_message: 'Halo semua! Selamat datang di ElChat 🎉',   last_message_at: new Date(Date.now() - 5 * 60000).toISOString(),   is_global: true,  unread_count: 3  },
    { id: 'room-2',    name: 'Tim Produk',      last_message: 'Meeting besok jam 10 ya, jangan lupa!',     last_message_at: new Date(Date.now() - 28 * 60000).toISOString(),  is_global: false, unread_count: 12 },
    { id: 'room-3',    name: 'Rizky Pratama',   last_message: 'Oke siap, nanti aku kabarin.',              last_message_at: new Date(Date.now() - 2 * 3600000).toISOString(),  is_global: false, unread_count: 0  },
    { id: 'room-4',    name: 'Desain UI/UX',    last_message: 'File Figma-nya sudah aku share ya.',        last_message_at: new Date(Date.now() - 5 * 3600000).toISOString(),  is_global: false, unread_count: 5  },
    { id: 'room-5',    name: 'Nadia Kusuma',    last_message: null,                                        last_message_at: new Date(Date.now() - 1 * 86400000).toISOString(), is_global: false, unread_count: 0  },
    { id: 'room-6',    name: 'Backend Squad',   last_message: 'Deploy sudah berhasil! 🚀',                last_message_at: new Date(Date.now() - 2 * 86400000).toISOString(), is_global: false, unread_count: 1  },
  ];

  ChatModule.rooms = mockRooms;
  ChatModule.filteredRooms = mockRooms;
  renderChatList(mockRooms, skeleton, listEl, emptyEl);

  // Tampilkan info bahwa ini adalah data demo
  const listContainer = document.getElementById('chat-list');
  if (listContainer) {
    const notice = document.createElement('div');
    notice.style.cssText = 'text-align:center;padding:10px 16px;font-size:12px;color:var(--accent-amber);opacity:0.8;';
    notice.textContent   = '⚠ Mode Demo — Konfigurasi Supabase untuk data nyata';
    listContainer.appendChild(notice);
  }
}

// ══════════════════════════════════════════════
// FILTER PILLS
// ══════════════════════════════════════════════

/**
 * Terapkan filter pada daftar chat.
 * @param {'all'|'group'|'dm'|'unread'} filter
 */
function setChatFilter(filter) {
  ChatModule.activeFilter = filter;

  // Update tampilan tombol filter
  document.querySelectorAll('.filter-pill').forEach(pill => {
    pill.classList.toggle('active', pill.dataset.filter === filter);
  });

  // Terapkan filter
  switch (filter) {
    case 'all':
      ChatModule.filteredRooms = [...ChatModule.rooms];
      break;
    case 'group':
      ChatModule.filteredRooms = ChatModule.rooms.filter(r => r.is_global || r.is_group);
      break;
    case 'dm':
      ChatModule.filteredRooms = ChatModule.rooms.filter(r => !r.is_global && !r.is_group);
      break;
    case 'unread':
      ChatModule.filteredRooms = ChatModule.rooms.filter(r => (r.unread_count || 0) > 0);
      break;
  }

  // Re-render list
  reRenderChatList();
}

/**
 * Re-render list dengan filteredRooms.
 * Digunakan setelah filter atau refresh.
 */
function reRenderChatList() {
  const listEl   = document.getElementById('chat-list');
  const emptyEl  = document.getElementById('chat-empty');
  if (!listEl) return;

  // Bersihkan konten lama (kecuali skeleton)
  Array.from(listEl.children).forEach(child => {
    if (!child.classList.contains('chat-skeleton')) child.remove();
  });

  if (ChatModule.filteredRooms.length === 0) {
    if (emptyEl) emptyEl.hidden = false;
    return;
  }

  if (emptyEl) emptyEl.hidden = true;

  const globals   = ChatModule.filteredRooms.filter(r => r.is_global);
  const personals = ChatModule.filteredRooms.filter(r => !r.is_global);
  let html = '';

  if (globals.length)   {
    html += `<div class="chat-section-header">Global</div>`;
    html += globals.map((r, i) => renderRoomItem(r, i, true)).join('');
  }
  if (personals.length) {
    html += `<div class="chat-section-header">Percakapan</div>`;
    html += personals.map((r, i) => renderRoomItem(r, i, false)).join('');
  }

  listEl.insertAdjacentHTML('beforeend', html);
}

// ══════════════════════════════════════════════
// ROOM & DM ACTIONS
// ══════════════════════════════════════════════

/**
 * Buka layar ruang chat.
 * Mendelegasikan ke fungsi openRoom() di room.js.
 * @param {string} roomId
 * @param {string} roomName
 * @param {string|null} partnerId - ID lawan bicara untuk DM
 */
function openRoom(roomId, roomName, partnerId = null) {
  if (typeof window.openRoom !== 'undefined' && window.openRoom !== openRoom) {
    window.openRoom(roomId, roomName, partnerId);
    return;
  }
  // room.js belum dimuat atau ini adalah panggilan dari room.js sendiri
  closeChatSearch();
  showToast(`Membuka ${roomName}…`, '');
}

/**
 * Dipanggil saat user mengklik hasil pencarian.
 * Membuka Bridge Modal — BUKAN langsung ke chat.
 * Logika chat request dikelola oleh requests.js.
 * @param {string} targetUserId
 * @param {string} targetUsername
 */
function openDirectMessage(targetUserId, targetUsername) {
  // Fungsi ini dipertahankan sebagai alias backward-compat.
  // Logika sebenarnya ada di openBridgeModal() di requests.js.
  openBridgeModal({ id: targetUserId, username: targetUsername });
}

/**
 * Tombol FAB — mulai chat baru (placeholder)
 */
function startNewChat() {
  showToast('Fitur chat baru akan hadir segera.', '');
}

// ══════════════════════════════════════════════
// REALTIME SUBSCRIPTION
// ══════════════════════════════════════════════

/**
 * Berlangganan perubahan realtime pada tabel 'rooms'
 * agar unread count dan last_message diperbarui otomatis.
 */
function subscribeToChatUpdates() {
  // Bersihkan channel lama jika ada
  if (ChatModule.realtimeChannel) {
    supabaseClient.removeChannel(ChatModule.realtimeChannel);
  }

  ChatModule.realtimeChannel = supabaseClient
    .channel('chat-rooms-updates')
    .on('postgres_changes', {
      event:  'UPDATE',
      schema: 'public',
      table:  'rooms',
    }, (payload) => {
      const updated = payload.new;
      // Perbarui data room di state lokal
      const idx = ChatModule.rooms.findIndex(r => r.id === updated.id);
      if (idx !== -1) {
        ChatModule.rooms[idx] = { ...ChatModule.rooms[idx], ...updated };
        reRenderChatList();
      }
    })
    .subscribe();
}

// ══════════════════════════════════════════════
// UTILITY
// ══════════════════════════════════════════════

/**
 * Format timestamp menjadi string yang mudah dibaca.
 * Logika: "Baru saja" < 1 mnt → "5 mnt" < 1 jam → "14:30" hari ini → "Sen" kemarin → "12/3"
 * @param {string|null} isoString - Timestamp ISO 8601
 * @returns {string}
 */
function formatChatTime(isoString) {
  if (!isoString) return '';

  const date = new Date(isoString);
  const now  = new Date();
  const diff  = (now - date) / 1000; // Selisih dalam detik

  if (diff < 60)               return 'Baru saja';
  if (diff < 3600)             return `${Math.floor(diff / 60)} mnt`;

  const isToday     = date.toDateString() === now.toDateString();
  if (isToday)       return date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Kemarin';

  const diffDays = Math.floor(diff / 86400);
  if (diffDays < 7) {
    return date.toLocaleDateString('id-ID', { weekday: 'short' });
  }

  return date.toLocaleDateString('id-ID', { day: 'numeric', month: 'numeric' });
}

/**
 * Escape HTML untuk mencegah XSS saat menyuntikkan konten dinamis ke DOM.
 * @param {any} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
