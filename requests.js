/* ═══════════════════════════════════════════════
   ELCHAT — REQUESTS.JS
   Chat Request (Persetujuan Chat) Module

   Alur lengkap:
   1. User A klik hasil pencarian → Bridge Modal terbuka
   2. Bridge Modal cek status di tabel chat_requests
   3. Klik "Mulai Chat" → INSERT baris pending ke chat_requests
   4. User B melihat badge notifikasi + daftar permintaan masuk
   5. User B klik "Terima" → UPDATE status → buat room DM baru
   6. User B klik "Tolak" → UPDATE status → tidak ada room dibuat
   7. Realtime subscription memperbarui badge & daftar secara langsung

   Skema tabel yang diperlukan (lihat SQL di bawah):
     chat_requests: id, sender_id, receiver_id, status, created_at
═══════════════════════════════════════════════ */

'use strict';

// ── Module State ───────────────────────────────
const RequestsModule = {
  bridgeUser:      null,    // Data profil user yang sedang ditampilkan di Bridge Modal
  pendingCount:    0,       // Jumlah permintaan masuk yang belum ditangani
  realtimeChannel: null,    // Supabase realtime channel untuk chat_requests
};

/* ─────────────────────────────────────────────
   SQL SETUP (jalankan sekali di Supabase SQL Editor)
   ─────────────────────────────────────────────
   CREATE TABLE IF NOT EXISTS chat_requests (
     id          uuid primary key default gen_random_uuid(),
     sender_id   uuid not null references auth.users(id) on delete cascade,
     receiver_id uuid not null references auth.users(id) on delete cascade,
     status      text not null default 'pending'
                 check (status in ('pending','accepted','rejected')),
     created_at  timestamptz not null default now(),
     unique (sender_id, receiver_id)
   );

   -- RLS: hanya sender dan receiver yang bisa membaca barisnya
   ALTER TABLE chat_requests ENABLE ROW LEVEL SECURITY;
   CREATE POLICY "sender or receiver can read"
     ON chat_requests FOR SELECT
     USING (auth.uid() = sender_id OR auth.uid() = receiver_id);
   CREATE POLICY "sender can insert"
     ON chat_requests FOR INSERT WITH CHECK (auth.uid() = sender_id);
   CREATE POLICY "receiver can update status"
     ON chat_requests FOR UPDATE
     USING (auth.uid() = receiver_id)
     WITH CHECK (status IN ('accepted','rejected'));
   ───────────────────────────────────────────── */

// ══════════════════════════════════════════════
// INIT — dipanggil dari initChatPage()
// ══════════════════════════════════════════════

/**
 * Inisialisasi modul permintaan chat.
 * Memuat jumlah permintaan pending dan mulai mendengarkan realtime.
 */
async function initRequestsModule() {
  await refreshPendingCount();
  subscribeToRequestUpdates();
}

// ══════════════════════════════════════════════
// BRIDGE MODAL — Jendela Jembatan Profil
// ══════════════════════════════════════════════

/**
 * Buka Bridge Modal untuk pengguna tertentu.
 * Menampilkan profil lengkap dan memeriksa status permintaan chat
 * yang sudah ada (jika ada) sebelum memutuskan tombol apa yang ditampilkan.
 *
 * @param {object} user - { id, username, full_name, avatar_url, bio }
 */
async function openBridgeModal(user) {
  // Tangani jika user dikirim sebagai string JSON (dari atribut onclick HTML)
  if (typeof user === 'string') {
    try { user = JSON.parse(user); } catch { return; }
  }

  RequestsModule.bridgeUser = user;

  // ── Isi konten modal ──────────────────────
  const displayName = user.full_name || `@${user.username}`;
  const initials    = (user.username || 'U').substring(0, 2).toUpperCase();

  // Avatar
  const avatarEl = document.getElementById('bridge-avatar');
  if (avatarEl) {
    if (user.avatar_url) {
      avatarEl.innerHTML = `<img src="${escapeHtml(user.avatar_url)}" alt="${escapeHtml(displayName)}" />`;
    } else {
      avatarEl.textContent = initials;
      avatarEl.style.background = '';  // reset ke CSS gradient
    }
  }

  // Nama & Username
  const nameEl  = document.getElementById('bridge-name');
  const unameEl = document.getElementById('bridge-uname');
  if (nameEl)  nameEl.textContent  = displayName;
  if (unameEl) unameEl.textContent = `@${user.username}`;

  // Bio
  const bioEl = document.getElementById('bridge-bio');
  if (bioEl) {
    if (user.bio) {
      bioEl.textContent = user.bio;
      bioEl.hidden = false;
    } else {
      bioEl.hidden = true;
    }
  }

  // Reset status dan tombol ke loading state
  setBridgeStatus('loading');

  // ── Tampilkan overlay ─────────────────────
  const overlay = document.getElementById('profile-bridge-overlay');
  if (overlay) {
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('open'));
    document.body.style.overflow = 'hidden';
  }

  // Tutup search bar jika masih terbuka
  if (typeof closeChatSearch === 'function') closeChatSearch();

  // ── Cek status permintaan yang sudah ada ──
  await checkExistingRequest(user.id);
}

/**
 * Tutup Bridge Modal.
 * @param {Event|undefined} event - Jika dipanggil dari klik overlay,
 *                                   hanya tutup jika klik tepat di overlay (bukan sheet).
 */
function closeBridgeModal(event) {
  if (event && event.target !== document.getElementById('profile-bridge-overlay')) return;

  const overlay = document.getElementById('profile-bridge-overlay');
  if (overlay) {
    overlay.classList.remove('open');
    setTimeout(() => {
      overlay.hidden = true;
      document.body.style.overflow = '';
    }, 320);
  }

  RequestsModule.bridgeUser = null;
}

/**
 * Periksa status permintaan chat antara user saat ini dan target user.
 * Kemudian render tombol yang sesuai di Bridge Modal.
 * @param {string} targetUserId
 */
async function checkExistingRequest(targetUserId) {
  const myId = currentProfile?.id;
  if (!myId) return;

  try {
    // Cari permintaan dalam kedua arah:
    // (saya → dia) ATAU (dia → saya)
    const { data, error } = await supabaseClient
      .from('chat_requests')
      .select('id, status, sender_id, receiver_id')
      .or(
        `and(sender_id.eq.${myId},receiver_id.eq.${targetUserId}),` +
        `and(sender_id.eq.${targetUserId},receiver_id.eq.${myId})`
      )
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      // Belum ada permintaan sama sekali
      setBridgeStatus('none');
    } else if (data.status === 'accepted') {
      setBridgeStatus('accepted');
    } else if (data.status === 'pending') {
      if (data.sender_id === myId) {
        // Saya yang sudah mengirim, tunggu konfirmasi
        setBridgeStatus('sent');
      } else {
        // Dia yang mengirim permintaan ke saya
        setBridgeStatus('received', data.id);
      }
    } else if (data.status === 'rejected') {
      setBridgeStatus('rejected_by_me_or_them', data.sender_id === myId ? 'sender' : 'receiver');
    }

  } catch (err) {
    console.error('[ElChat] checkExistingRequest error:', err);
    setBridgeStatus('error');
  }
}

/**
 * Render UI Bridge Modal sesuai status permintaan.
 * @param {string} status - 'loading'|'none'|'sent'|'received'|'accepted'|'rejected_by_me_or_them'|'error'
 * @param {string} [extra] - Data tambahan (misalnya request ID untuk status 'received')
 */
function setBridgeStatus(status, extra) {
  const statusEl  = document.getElementById('bridge-status');
  const btnMain   = document.getElementById('bridge-btn-main');
  const btnLabel  = document.getElementById('bridge-btn-label');
  if (!statusEl || !btnMain || !btnLabel) return;

  // Reset
  statusEl.hidden    = true;
  statusEl.className = 'bridge-status';
  btnMain.disabled   = false;
  btnMain.className  = 'btn btn--primary bridge-btn-main';
  btnMain.onclick    = null;

  switch (status) {

    case 'loading':
      btnMain.disabled  = true;
      btnLabel.textContent = 'Memuat...';
      break;

    case 'none':
      // Belum ada permintaan — tampilkan tombol "Mulai Chat"
      btnLabel.textContent = 'Mulai Chat';
      btnMain.onclick = () => sendChatRequest(RequestsModule.bridgeUser?.id);
      break;

    case 'sent':
      // Permintaan sudah dikirim, menunggu respons
      statusEl.hidden    = false;
      statusEl.classList.add('bridge-status--pending');
      statusEl.innerHTML = '⏳ Permintaan chat dikirim. Menunggu konfirmasi...';
      btnMain.disabled   = true;
      btnLabel.textContent = 'Menunggu...';
      break;

    case 'received':
      // Dia mengirim permintaan ke kita — tampilkan tombol terima/tolak di modal ini juga
      statusEl.hidden = false;
      statusEl.classList.add('bridge-status--pending');
      statusEl.innerHTML = '💬 Pengguna ini ingin mengobrol denganmu.';
      btnLabel.textContent = 'Terima Chat';
      btnMain.className = 'btn btn--primary bridge-btn-main';
      btnMain.onclick = () => acceptChatRequest(extra, RequestsModule.bridgeUser?.id);
      break;

    case 'accepted':
      // Sudah terhubung — tampilkan tombol buka chat
      statusEl.hidden = false;
      statusEl.classList.add('bridge-status--accepted');
      statusEl.innerHTML = '✅ Kamu sudah terhubung dengan pengguna ini.';
      btnLabel.textContent = 'Buka Chat';
      btnMain.onclick = async () => {
        closeBridgeModal();
        // Cari room DM yang ada antara saya dan partner
        const myId     = currentProfile?.id;
        const partner  = RequestsModule.bridgeUser;
        if (!myId || !partner) return;
        try {
          // Cari room_members yang sama-sama mengandung kedua user
          const { data } = await supabaseClient
            .from('room_members')
            .select('room_id')
            .eq('user_id', myId);
          const myRoomIds = (data || []).map(r => r.room_id);

          const { data: shared } = await supabaseClient
            .from('room_members')
            .select('room_id, rooms(id, name, is_group, is_global)')
            .eq('user_id', partner.id)
            .in('room_id', myRoomIds);

          // Cari room DM (bukan group, bukan global)
          const dmRoom = (shared || []).find(r => r.rooms && !r.rooms.is_group && !r.rooms.is_global);
          if (dmRoom) {
            openRoom(dmRoom.room_id, dmRoom.rooms.name, partner.id);
          } else {
            showToast('Room chat tidak ditemukan.', 'error');
          }
        } catch (err) {
          console.error('[ElChat] openRoom from bridge:', err);
          showToast('Gagal membuka chat.', 'error');
        }
      };
      break;

    case 'rejected_by_me_or_them':
      statusEl.hidden = false;
      statusEl.classList.add('bridge-status--rejected');
      statusEl.innerHTML = '✕ Permintaan chat sebelumnya ditolak.';
      // Izinkan mencoba lagi
      btnLabel.textContent = 'Coba Lagi';
      btnMain.onclick = () => sendChatRequest(RequestsModule.bridgeUser?.id, true);
      break;

    case 'error':
      statusEl.hidden = false;
      statusEl.innerHTML = '⚠ Gagal memuat status. Coba lagi nanti.';
      btnMain.disabled  = true;
      btnLabel.textContent = 'Gagal';
      break;
  }
}

// ══════════════════════════════════════════════
// KIRIM PERMINTAAN CHAT
// ══════════════════════════════════════════════

/**
 * Kirim permintaan chat baru ke pengguna lain.
 * Membuat baris baru di tabel chat_requests dengan status 'pending'.
 *
 * @param {string}  receiverId - ID user penerima
 * @param {boolean} isRetry    - Jika true, hapus baris rejected lama dulu sebelum insert
 */
async function sendChatRequest(receiverId, isRetry = false) {
  const senderId = currentProfile?.id;
  if (!senderId || !receiverId) return;

  const btnMain = document.getElementById('bridge-btn-main');
  if (btnMain) btnMain.disabled = true;

  try {
    // Jika percobaan ulang: hapus baris lama dengan status rejected
    if (isRetry) {
      await supabaseClient
        .from('chat_requests')
        .delete()
        .match({ sender_id: senderId, receiver_id: receiverId, status: 'rejected' });
    }

    // INSERT baris baru
    const { error } = await supabaseClient
      .from('chat_requests')
      .insert([{
        sender_id:   senderId,
        receiver_id: receiverId,
        status:      'pending',
      }]);

    if (error) {
      // Kode 23505 = unique constraint violation (permintaan sudah ada)
      if (error.code === '23505') {
        showToast('Permintaan sudah pernah dikirim.', '');
        setBridgeStatus('sent');
      } else {
        throw error;
      }
      return;
    }

    setBridgeStatus('sent');
    showToast('Permintaan chat terkirim! Menunggu konfirmasi.', 'success');

  } catch (err) {
    console.error('[ElChat] sendChatRequest error:', err);
    showToast('Gagal mengirim permintaan. Coba lagi.', 'error');
    if (btnMain) btnMain.disabled = false;
  }
}

// ══════════════════════════════════════════════
// TERIMA / TOLAK PERMINTAAN
// ══════════════════════════════════════════════

/**
 * Terima permintaan chat masuk.
 * Mengubah status menjadi 'accepted', membuat room DM baru,
 * dan menambahkan kedua user sebagai anggota room.
 *
 * @param {string} requestId - ID baris di chat_requests
 * @param {string} senderId  - ID user pengirim permintaan
 */
async function acceptChatRequest(requestId, senderId) {
  const myId = currentProfile?.id;
  if (!myId || !requestId || !senderId) return;

  // Nonaktifkan tombol untuk mencegah double-click
  disableRequestCard(requestId);

  try {
    // ── Langkah 1: Update status permintaan ──────
    const { error: updateErr } = await supabaseClient
      .from('chat_requests')
      .update({ status: 'accepted' })
      .eq('id', requestId);

    if (updateErr) throw updateErr;

    // ── Langkah 2: Ambil data pengirim untuk nama room ──
    const { data: senderProfile } = await supabaseClient
      .from('profiles')
      .select('username, full_name')
      .eq('id', senderId)
      .single();

    const myProfile    = currentProfile;
    const senderName   = senderProfile?.full_name || `@${senderProfile?.username}` || 'User';
    const myName       = myProfile?.full_name     || `@${myProfile?.username}`      || 'User';

    // ── Langkah 3: Buat room DM baru ─────────────
    const { data: newRoom, error: roomErr } = await supabaseClient
      .from('rooms')
      .insert([{
        name:      `${senderName} & ${myName}`,
        is_global: false,
        is_group:  false,
      }])
      .select('id')
      .single();

    if (roomErr) throw roomErr;

    // ── Langkah 4: Tambahkan kedua user ke room_members ──
    const { error: membersErr } = await supabaseClient
      .from('room_members')
      .insert([
        { room_id: newRoom.id, user_id: senderId, unread_count: 0 },
        { room_id: newRoom.id, user_id: myId,     unread_count: 0 },
      ]);

    if (membersErr) throw membersErr;

    // ── Langkah 5: Feedback UI ─────────────────────
    showToast('Permintaan diterima! Room chat dibuat.', 'success');

    // Tutup kedua modal jika terbuka
    closeBridgeModal();
    closeRequestsModal();

    // Reload daftar chat agar room baru muncul
    if (typeof loadChatRooms === 'function') {
      const listEl   = document.getElementById('chat-list');
      const emptyEl  = document.getElementById('chat-empty');
      if (listEl) {
        // Bersihkan list lama sebelum reload
        Array.from(listEl.children).forEach(c => c.remove());
        const skeleton = document.createElement('div');
        skeleton.id = 'chat-skeleton';
        skeleton.className = 'chat-skeleton';
        skeleton.innerHTML = `
          <div class="skeleton-item"><div class="sk-avatar"></div><div class="sk-lines"><div class="sk-line sk-line--name"></div><div class="sk-line sk-line--msg"></div></div></div>
          <div class="skeleton-item"><div class="sk-avatar"></div><div class="sk-lines"><div class="sk-line sk-line--name"></div><div class="sk-line sk-line--msg"></div></div></div>
        `;
        listEl.appendChild(skeleton);
      }
      await loadChatRooms();
    }

    // Refresh badge count
    await refreshPendingCount();

  } catch (err) {
    console.error('[ElChat] acceptChatRequest error:', err);
    showToast('Gagal menerima permintaan. Coba lagi.', 'error');
    enableRequestCard(requestId);
  }
}

/**
 * Tolak permintaan chat masuk.
 * Hanya mengubah status menjadi 'rejected'. Tidak ada room yang dibuat.
 *
 * @param {string} requestId - ID baris di chat_requests
 */
async function rejectChatRequest(requestId) {
  if (!requestId) return;

  disableRequestCard(requestId);

  try {
    const { error } = await supabaseClient
      .from('chat_requests')
      .update({ status: 'rejected' })
      .eq('id', requestId);

    if (error) throw error;

    showToast('Permintaan ditolak.', '');

    // Hapus kartu dari daftar secara langsung (tanpa reload)
    const card = document.getElementById(`req-card-${requestId}`);
    if (card) {
      card.style.transition = 'opacity 0.3s, transform 0.3s';
      card.style.opacity    = '0';
      card.style.transform  = 'translateX(20px)';
      setTimeout(() => card.remove(), 320);
    }

    // Tutup bridge modal jika terbuka untuk user ini
    closeBridgeModal();

    // Refresh badge
    await refreshPendingCount();

    // Tampilkan empty state jika tidak ada permintaan tersisa
    const list = document.getElementById('requests-list');
    if (list && list.querySelectorAll('.request-card').length === 0) {
      renderRequestsEmpty(list);
    }

  } catch (err) {
    console.error('[ElChat] rejectChatRequest error:', err);
    showToast('Gagal menolak permintaan. Coba lagi.', 'error');
    enableRequestCard(requestId);
  }
}

// ══════════════════════════════════════════════
// REQUESTS MODAL — Daftar Permintaan Masuk
// ══════════════════════════════════════════════

/**
 * Buka modal daftar permintaan chat masuk dan muat datanya.
 */
async function openRequestsModal() {
  const overlay = document.getElementById('requests-overlay');
  if (overlay) {
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('open'));
    document.body.style.overflow = 'hidden';
  }

  await loadIncomingRequests();
}

/**
 * Tutup modal daftar permintaan.
 * @param {Event|undefined} event
 */
function closeRequestsModal(event) {
  if (event && event.target !== document.getElementById('requests-overlay')) return;

  const overlay = document.getElementById('requests-overlay');
  if (overlay) {
    overlay.classList.remove('open');
    setTimeout(() => {
      overlay.hidden = true;
      document.body.style.overflow = '';
    }, 320);
  }
}

/**
 * Memuat semua permintaan chat yang masuk (status 'pending') ke user ini.
 * Melakukan JOIN dengan tabel profiles untuk mendapatkan data pengirim.
 */
async function loadIncomingRequests() {
  const listEl   = document.getElementById('requests-list');
  if (!listEl) return;

  const myId = currentProfile?.id;
  if (!myId) return;

  listEl.innerHTML = `<div class="requests-loading">Memuat permintaan...</div>`;

  try {
    const { data, error } = await supabaseClient
      .from('chat_requests')
      .select(`
        id, status, created_at,
        sender:profiles!chat_requests_sender_id_fkey (
          id, username, full_name, avatar_url
        )
      `)
      .eq('receiver_id', myId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) throw error;

    if (!data || data.length === 0) {
      renderRequestsEmpty(listEl);
      return;
    }

    // Update badge di header modal
    const badge = document.getElementById('requests-count-badge');
    if (badge) {
      badge.textContent = data.length;
      badge.hidden = false;
    }

    listEl.innerHTML = data.map(req => renderRequestCard(req)).join('');

  } catch (err) {
    console.error('[ElChat] loadIncomingRequests error:', err);
    listEl.innerHTML = `<div class="requests-empty">Gagal memuat permintaan.<br>Periksa koneksimu dan coba lagi.</div>`;
  }
}

/**
 * Render satu kartu permintaan chat masuk.
 * @param {object} req - Data permintaan dari Supabase
 * @returns {string} HTML string
 */
function renderRequestCard(req) {
  const sender      = req.sender || {};
  const displayName = sender.full_name || `@${sender.username}` || 'Pengguna';
  const initials    = (sender.username || 'U').substring(0, 2).toUpperCase();
  const avatarHtml  = sender.avatar_url
    ? `<img src="${escapeHtml(sender.avatar_url)}" alt="${escapeHtml(displayName)}" />`
    : initials;
  const timeStr = formatChatTime ? formatChatTime(req.created_at) : '';

  return `
    <div class="request-card" id="req-card-${escapeHtml(req.id)}">
      <div class="request-card__avatar"
           onclick="openBridgeModal(${escapeHtml(JSON.stringify({ id: sender.id, username: sender.username, full_name: sender.full_name, avatar_url: sender.avatar_url }))})"
           style="cursor:pointer"
      >${avatarHtml}</div>
      <div class="request-card__info">
        <div class="request-card__name">${escapeHtml(displayName)}</div>
        <div class="request-card__username">@${escapeHtml(sender.username || '')}</div>
        <div class="request-card__time">${timeStr}</div>
      </div>
      <div class="request-card__actions">
        <button class="req-btn req-btn--accept"
                id="req-accept-${escapeHtml(req.id)}"
                onclick="acceptChatRequest('${escapeHtml(req.id)}', '${escapeHtml(sender.id)}')">
          Terima
        </button>
        <button class="req-btn req-btn--reject"
                id="req-reject-${escapeHtml(req.id)}"
                onclick="rejectChatRequest('${escapeHtml(req.id)}')">
          Tolak
        </button>
      </div>
    </div>
  `;
}

/**
 * Render empty state di daftar permintaan.
 * @param {HTMLElement} container
 */
function renderRequestsEmpty(container) {
  const badge = document.getElementById('requests-count-badge');
  if (badge) badge.hidden = true;

  container.innerHTML = `
    <div class="requests-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
      </svg>
      <br>Tidak ada permintaan masuk saat ini.
    </div>
  `;
}

// ══════════════════════════════════════════════
// BADGE COUNTER
// ══════════════════════════════════════════════

/**
 * Hitung jumlah permintaan pending dan perbarui badge notifikasi di header.
 * Tombol bell disembunyikan jika tidak ada permintaan sama sekali.
 */
async function refreshPendingCount() {
  const myId = currentProfile?.id;
  if (!myId) return;

  try {
    const { count, error } = await supabaseClient
      .from('chat_requests')
      .select('id', { count: 'exact', head: true })
      .eq('receiver_id', myId)
      .eq('status', 'pending');

    if (error) throw error;

    RequestsModule.pendingCount = count || 0;
    updateBellBadge(RequestsModule.pendingCount);

  } catch (err) {
    console.warn('[ElChat] refreshPendingCount error:', err);
  }
}

/**
 * Tampilkan atau sembunyikan badge merah pada tombol bell.
 * @param {number} count - Jumlah permintaan pending
 */
function updateBellBadge(count) {
  const btnBell  = document.getElementById('btn-requests');
  const badge    = document.getElementById('bell-badge');

  if (!btnBell || !badge) return;

  if (count > 0) {
    btnBell.hidden     = false;
    badge.hidden       = false;
    badge.textContent  = count > 99 ? '99+' : String(count);
  } else {
    badge.hidden  = true;
    // Sembunyikan tombol bell sepenuhnya jika tidak ada permintaan
    btnBell.hidden = true;
  }
}

// ══════════════════════════════════════════════
// REALTIME SUBSCRIPTION
// ══════════════════════════════════════════════

/**
 * Berlangganan perubahan realtime pada tabel chat_requests
 * agar badge dan daftar permintaan diperbarui secara otomatis.
 */
function subscribeToRequestUpdates() {
  if (RequestsModule.realtimeChannel) {
    supabaseClient.removeChannel(RequestsModule.realtimeChannel);
  }

  const myId = currentProfile?.id;
  if (!myId) return;

  RequestsModule.realtimeChannel = supabaseClient
    .channel(`chat-requests-${myId}`)
    .on('postgres_changes', {
      event:  'INSERT',
      schema: 'public',
      table:  'chat_requests',
      filter: `receiver_id=eq.${myId}`,
    }, async (payload) => {
      // Permintaan baru masuk → perbarui badge
      RequestsModule.pendingCount++;
      updateBellBadge(RequestsModule.pendingCount);

      // Jika modal daftar permintaan sedang terbuka, refresh kontennya
      const overlay = document.getElementById('requests-overlay');
      if (overlay && overlay.classList.contains('open')) {
        await loadIncomingRequests();
      }

      showToast('Ada permintaan chat baru masuk!', 'success');
    })
    .on('postgres_changes', {
      event:  'UPDATE',
      schema: 'public',
      table:  'chat_requests',
      filter: `sender_id=eq.${myId}`,
    }, async (payload) => {
      // Permintaan yang kita kirim diperbarui (diterima/ditolak)
      if (payload.new.status === 'accepted') {
        showToast('Permintaan chatmu diterima! 🎉', 'success');

        // Refresh daftar chat room
        if (typeof loadChatRooms === 'function') {
          await loadChatRooms();
        }

        // Update bridge modal jika masih terbuka untuk user yang sama
        const bridgeUser = RequestsModule.bridgeUser;
        if (bridgeUser && bridgeUser.id === payload.new.receiver_id) {
          setBridgeStatus('accepted');
        }
      } else if (payload.new.status === 'rejected') {
        showToast('Permintaan chatmu tidak diterima.', '');

        const bridgeUser = RequestsModule.bridgeUser;
        if (bridgeUser && bridgeUser.id === payload.new.receiver_id) {
          setBridgeStatus('rejected_by_me_or_them', 'receiver');
        }
      }
    })
    .subscribe();
}

// ══════════════════════════════════════════════
// UI STATE HELPERS
// ══════════════════════════════════════════════

/**
 * Nonaktifkan tombol Terima dan Tolak pada kartu permintaan tertentu
 * untuk mencegah aksi ganda saat sedang diproses.
 * @param {string} requestId
 */
function disableRequestCard(requestId) {
  const acceptBtn = document.getElementById(`req-accept-${requestId}`);
  const rejectBtn = document.getElementById(`req-reject-${requestId}`);
  if (acceptBtn) { acceptBtn.disabled = true; acceptBtn.textContent = '...'; }
  if (rejectBtn)   rejectBtn.disabled = true;
}

/** Aktifkan kembali tombol kartu permintaan setelah error. */
function enableRequestCard(requestId) {
  const acceptBtn = document.getElementById(`req-accept-${requestId}`);
  const rejectBtn = document.getElementById(`req-reject-${requestId}`);
  if (acceptBtn) { acceptBtn.disabled = false; acceptBtn.textContent = 'Terima'; }
  if (rejectBtn)   rejectBtn.disabled = false;
}

// ══════════════════════════════════════════════
// KEYBOARD SHORTCUT — Tutup modal dengan Escape
// ══════════════════════════════════════════════

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;

  // Tutup bridge modal jika terbuka
  const bridgeOverlay = document.getElementById('profile-bridge-overlay');
  if (bridgeOverlay && !bridgeOverlay.hidden) {
    closeBridgeModal();
    return;
  }

  // Tutup requests modal jika terbuka
  const requestsOverlay = document.getElementById('requests-overlay');
  if (requestsOverlay && !requestsOverlay.hidden) {
    closeRequestsModal();
  }
});
