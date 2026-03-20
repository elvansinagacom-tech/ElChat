/* ═══════════════════════════════════════════════
   ELCHAT — ROOM.JS
   Private Chat Room Module

   Fitur yang diimplementasikan:
   ─ Buka / tutup layar room dengan animasi slide
   ─ Header dengan foto profil & status "Mengetik..." via Supabase Presence
   ─ Area pesan realtime (postgres_changes)
   ─ Bubble kiri/kanan, avatar, timestamp, tanda centang
   ─ Long-press untuk seleksi pesan → pin / hapus
   ─ Modal hapus pesan (untuk semua orang / untuk saya saja)
   ─ Logika deleted_by[] — pesan tidak tampil untuk ID yang ada di array
   ─ Pesan disematkan (is_pinned) dengan banner di atas
   ─ Upload media ke Supabase Storage
   ─ Blokir pengguna (insert ke tabel blocked_users)
   ─ Hapus semua chat untuk saya (bulk update deleted_by)

   Skema tambahan yang diperlukan — jalankan di SQL Editor:
   ────────────────────────────────────────────────────────
   -- Tabel messages
   CREATE TABLE IF NOT EXISTS messages (
     id          uuid primary key default gen_random_uuid(),
     room_id     uuid not null references rooms(id) on delete cascade,
     sender_id   uuid not null references auth.users(id) on delete cascade,
     content     text,
     media_url   text,
     media_type  text,          -- 'image' | 'video'
     is_pinned   boolean not null default false,
     deleted_by  uuid[] not null default '{}',
     created_at  timestamptz not null default now()
   );
   CREATE INDEX ON messages(room_id, created_at);
   ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
   CREATE POLICY "room members can read messages"
     ON messages FOR SELECT
     USING (EXISTS (
       SELECT 1 FROM room_members rm
       WHERE rm.room_id = messages.room_id
         AND rm.user_id = auth.uid()
     ));
   CREATE POLICY "room members can insert messages"
     ON messages FOR INSERT
     WITH CHECK (auth.uid() = sender_id AND EXISTS (
       SELECT 1 FROM room_members rm
       WHERE rm.room_id = messages.room_id
         AND rm.user_id = auth.uid()
     ));
   CREATE POLICY "sender can update own messages"
     ON messages FOR UPDATE
     USING (auth.uid() = sender_id);
   CREATE POLICY "members can update deleted_by"
     ON messages FOR UPDATE
     USING (EXISTS (
       SELECT 1 FROM room_members rm
       WHERE rm.room_id = messages.room_id
         AND rm.user_id = auth.uid()
     ));

   -- Tabel blocked_users
   CREATE TABLE IF NOT EXISTS blocked_users (
     blocker_id uuid not null references auth.users(id) on delete cascade,
     blocked_id uuid not null references auth.users(id) on delete cascade,
     created_at timestamptz not null default now(),
     primary key (blocker_id, blocked_id)
   );
   ALTER TABLE blocked_users ENABLE ROW LEVEL SECURITY;
   CREATE POLICY "blocker can manage blocks"
     ON blocked_users FOR ALL USING (auth.uid() = blocker_id);
   ────────────────────────────────────────────────────────
   Aktifkan juga Realtime untuk tabel messages di Supabase Dashboard.
═══════════════════════════════════════════════ */


// ── Module State ───────────────────────────────
const RoomModule = {
  roomId:           null,   // ID room aktif
  roomName:         null,   // Nama room aktif
  partnerId:        null,   // ID lawan bicara (DM)
  partnerProfile:   null,   // Profil lawan bicara
  messages:         [],     // Array pesan yang sudah dimuat
  selectedMsgId:    null,   // ID pesan yang sedang dipilih (long-press)
  pinnedMsgId:      null,   // ID pesan yang disematkan saat ini
  presenceChannel:  null,   // Supabase Presence channel
  realtimeChannel:  null,   // Supabase Realtime postgres_changes channel
  typingTimer:      null,   // Debounce timer untuk event mengetik
  isTyping:         false,  // Apakah user sedang mengetik
  pendingMedia:     null,   // { file, dataUrl, type } siap kirim
  longPressTimer:   null,   // Timer untuk deteksi long-press
  lastDateShown:    null,   // Untuk pemisah tanggal
};

// Durasi (ms) yang dianggap sebagai long-press
const LONG_PRESS_DURATION = 500;

// ══════════════════════════════════════════════
// BUKA / TUTUP ROOM
// ══════════════════════════════════════════════

/**
 * Buka layar ruang chat untuk room dan lawan bicara tertentu.
 * Dipanggil dari requests.js setelah permintaan diterima,
 * atau dari chat.js saat item daftar chat diklik.
 *
 * @param {string} roomId       - ID room di tabel rooms
 * @param {string} roomName     - Nama room untuk header
 * @param {string} partnerId    - ID user lawan bicara
 */
async function openRoom(roomId, roomName, partnerId) {
  // Simpan state
  RoomModule.roomId   = roomId;
  RoomModule.roomName = roomName;
  RoomModule.partnerId = partnerId || null;

  // ── Tampilkan layar room ──
  const screen = document.getElementById('room-screen');
  if (screen) {
    screen.hidden = false;
    requestAnimationFrame(() => screen.classList.add('open'));
  }
  document.body.style.overflow = 'hidden';

  // ── Reset UI ──
  clearMessageSelection();
  document.getElementById('messages-loading').style.display = 'flex';
  const area = document.getElementById('messages-area');
  // Bersihkan pesan lama kecuali skeleton
  Array.from(area.children).forEach(c => {
    if (c.id !== 'messages-loading') c.remove();
  });
  hidePinnedBanner();

  // ── Muat profil lawan bicara ──
  if (partnerId) {
    await loadPartnerProfile(partnerId);

    // Periksa apakah ada blokir aktif antara kedua user
    if (typeof checkBlockStatus === 'function') {
      const { blocked, direction } = await checkBlockStatus(partnerId);
      if (blocked && typeof disableRoomInputForBlock === 'function') {
        disableRoomInputForBlock(direction);
      }
    }
  } else {
    // Fallback: gunakan nama room sebagai judul
    setRoomHeader({ username: roomName, full_name: null, avatar_url: null });
  }

  // ── Muat pesan ──
  await loadMessages();

  // ── Subscribe realtime & presence ──
  subscribeToMessages();
  subscribeToPresence();
}

/**
 * Tutup layar ruang chat dan bersihkan semua subscription.
 */
function closeRoom() {
  const screen = document.getElementById('room-screen');
  if (screen) {
    screen.classList.remove('open');
    setTimeout(() => {
      screen.hidden = true;
      document.body.style.overflow = '';
    }, 320);
  }

  // Unsubscribe channels
  if (RoomModule.realtimeChannel) {
    supabaseClient.removeChannel(RoomModule.realtimeChannel);
    RoomModule.realtimeChannel = null;
  }
  if (RoomModule.presenceChannel) {
    supabaseClient.removeChannel(RoomModule.presenceChannel);
    RoomModule.presenceChannel = null;
  }

  // Reset state
  RoomModule.roomId         = null;
  RoomModule.messages       = [];
  RoomModule.selectedMsgId  = null;
  RoomModule.pendingMedia   = null;
  RoomModule.lastDateShown  = null;
  clearMessageSelection();
}

// ══════════════════════════════════════════════
// HEADER ROOM
// ══════════════════════════════════════════════

/**
 * Muat profil lawan bicara dari Supabase dan render header.
 * @param {string} userId
 */
async function loadPartnerProfile(userId) {
  try {
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('id, username, full_name, avatar_url')
      .eq('id', userId)
      .single();

    if (error) throw error;
    RoomModule.partnerProfile = data;
    setRoomHeader(data);
  } catch (err) {
    console.warn('[ElChat] loadPartnerProfile:', err.message);
    setRoomHeader({ username: RoomModule.roomName, full_name: null, avatar_url: null });
  }
}

/**
 * Render konten header room berdasarkan profil.
 * @param {object} profile
 */
function setRoomHeader(profile) {
  const nameEl   = document.getElementById('room-header-name');
  const avatarEl = document.getElementById('room-header-avatar');
  const statusEl = document.getElementById('room-header-status');

  const displayName = profile.full_name || `@${profile.username}`;
  if (nameEl)  nameEl.textContent = displayName;
  if (statusEl) statusEl.textContent = '';

  if (avatarEl) {
    if (profile.avatar_url) {
      avatarEl.innerHTML = `<img src="${escapeHtml(profile.avatar_url)}" alt="${escapeHtml(displayName)}" />`;
    } else {
      avatarEl.textContent = (profile.username || 'U').substring(0, 2).toUpperCase();
      avatarEl.style.background = '';
    }
  }
}

/**
 * Update status di bawah nama (Online / Mengetik... / terakhir dilihat).
 * @param {'online'|'typing'|'offline'} type
 */
function setPartnerStatus(type) {
  const statusEl = document.getElementById('room-header-status');
  if (!statusEl) return;
  statusEl.className = 'room-header__status';
  if (type === 'typing') {
    statusEl.classList.add('room-header__status--typing');
    statusEl.textContent = 'Mengetik...';
  } else if (type === 'online') {
    statusEl.classList.add('room-header__status--online');
    statusEl.textContent = 'Online';
  } else {
    statusEl.textContent = '';
  }
}

// ══════════════════════════════════════════════
// ROOM DROPDOWN MENU
// ══════════════════════════════════════════════

function toggleRoomMenu() {
  const menu = document.getElementById('room-dropdown-menu');
  const btn  = document.getElementById('btn-room-menu');
  const isOpen = menu.classList.contains('open');
  menu.classList.toggle('open', !isOpen);
  menu.setAttribute('aria-hidden', String(isOpen));
  btn.setAttribute('aria-expanded', String(!isOpen));
}

function closeRoomMenu() {
  const menu = document.getElementById('room-dropdown-menu');
  const btn  = document.getElementById('btn-room-menu');
  if (menu) { menu.classList.remove('open'); menu.setAttribute('aria-hidden', 'true'); }
  if (btn)  btn.setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', (e) => {
  const wrapper = document.getElementById('room-menu-wrapper');
  if (wrapper && !wrapper.contains(e.target)) closeRoomMenu();

  const mediaWrapper = document.getElementById('media-menu-wrapper');
  if (mediaWrapper && !mediaWrapper.contains(e.target)) closeMediaMenu();
});

// ══════════════════════════════════════════════
// MEMUAT PESAN
// ══════════════════════════════════════════════

/**
 * Memuat 50 pesan terbaru dari tabel messages untuk room aktif.
 * Pesan yang ada di deleted_by user saat ini tidak ditampilkan.
 * Pesan yang disematkan ditampilkan di banner atas.
 */
async function loadMessages() {
  const myId = currentProfile?.id;
  if (!RoomModule.roomId || !myId) return;

  try {
    const { data, error } = await supabaseClient
      .from('messages')
      .select('id, sender_id, content, media_url, media_type, is_pinned, deleted_by, created_at')
      .eq('room_id', RoomModule.roomId)
      .order('created_at', { ascending: true })
      .limit(50);

    if (error) throw error;

    // Sembunyikan skeleton
    const loadingEl = document.getElementById('messages-loading');
    if (loadingEl) loadingEl.style.display = 'none';

    RoomModule.messages      = data || [];
    RoomModule.lastDateShown = null;

    const area = document.getElementById('messages-area');
    if (!area) return;

    // Bersihkan pesan lama
    Array.from(area.children).forEach(c => {
      if (c.id !== 'messages-loading') c.remove();
    });

    // Cari pesan pinned
    const pinned = RoomModule.messages.find(m => m.is_pinned);
    if (pinned) showPinnedBanner(pinned);

    // Render semua pesan
    RoomModule.messages.forEach(msg => {
      const el = buildMessageElement(msg, myId);
      if (el) area.appendChild(el);
    });

    scrollToBottom(true);

  } catch (err) {
    console.error('[ElChat] loadMessages error:', err);
    const loadingEl = document.getElementById('messages-loading');
    if (loadingEl) {
      loadingEl.style.display = 'flex';
      loadingEl.innerHTML = `<div style="text-align:center;color:var(--text-muted);font-size:13px;padding:20px;">Gagal memuat pesan.</div>`;
    }
  }
}

// ══════════════════════════════════════════════
// RENDER PESAN
// ══════════════════════════════════════════════

/**
 * Bangun elemen DOM untuk satu pesan.
 * @param {object}  msg   - Data pesan dari Supabase
 * @param {string}  myId  - ID user yang sedang login
 * @returns {HTMLElement|null} - null jika pesan harus disembunyikan
 */
function buildMessageElement(msg, myId) {
  // Jangan tampilkan pesan yang dihapus untuk user ini
  if (Array.isArray(msg.deleted_by) && msg.deleted_by.includes(myId)) return null;

  const isMine   = msg.sender_id === myId;
  const partner  = RoomModule.partnerProfile;

  // ── Pemisah tanggal ──
  const msgDate  = new Date(msg.created_at).toDateString();
  let dateSep    = null;
  if (msgDate !== RoomModule.lastDateShown) {
    RoomModule.lastDateShown = msgDate;
    dateSep = document.createElement('div');
    dateSep.className = 'msg-date-sep';
    dateSep.innerHTML = `<span>${formatDateSep(msg.created_at)}</span>`;
  }

  // ── Row wrapper ──
  const row = document.createElement('div');
  row.className   = `msg-row ${isMine ? 'msg-row--mine' : 'msg-row--theirs'}`;
  row.dataset.id  = msg.id;
  row.dataset.own = isMine ? '1' : '0';

  // Long-press listeners
  attachLongPress(row, msg.id);

  // ── Avatar (hanya untuk theirs) ──
  if (!isMine) {
    const av = document.createElement('div');
    av.className = 'msg-avatar';
    if (partner?.avatar_url) {
      av.innerHTML = `<img src="${escapeHtml(partner.avatar_url)}" alt="avatar" />`;
    } else {
      av.textContent = (partner?.username || 'U').substring(0, 2).toUpperCase();
    }
    row.appendChild(av);
  }

  // ── Bubble wrap ──
  const wrap = document.createElement('div');
  wrap.className = 'msg-bubble-wrap';

  // ── Bubble ──
  const bubble = document.createElement('div');
  bubble.className = `msg-bubble${msg.is_pinned ? ' msg-bubble--pinned' : ''}`;

  // Media
  if (msg.media_url) {
    const media = document.createElement(msg.media_type === 'video' ? 'video' : 'img');
    media.className = 'msg-media';
    media.src = msg.media_url;
    if (msg.media_type === 'video') { media.controls = true; }
    else { media.alt = 'Gambar'; media.loading = 'lazy'; }
    bubble.appendChild(media);
  }

  // Teks
  if (msg.content) {
    const txt = document.createElement('span');
    txt.textContent = msg.content;
    bubble.appendChild(txt);
  }

  wrap.appendChild(bubble);

  // ── Meta (waktu + tanda centang) ──
  const meta = document.createElement('div');
  meta.className = 'msg-meta';

  const time = document.createElement('span');
  time.className   = 'msg-time';
  time.textContent = formatMsgTime(msg.created_at);
  meta.appendChild(time);

  if (isMine) {
    const ticks = buildTicks('sent'); // default sent; diperbarui oleh presence
    ticks.id = `ticks-${msg.id}`;
    meta.appendChild(ticks);
  }

  wrap.appendChild(meta);
  row.appendChild(wrap);

  // Kembalikan fragment dengan pemisah (jika ada) + baris pesan
  if (dateSep) {
    const frag = document.createDocumentFragment();
    frag.appendChild(dateSep);
    frag.appendChild(row);
    return frag;
  }
  return row;
}

/**
 * Bangun elemen tanda centang (single / double).
 * @param {'sent'|'seen'} state
 * @returns {HTMLElement}
 */
function buildTicks(state) {
  const el = document.createElement('span');
  el.className = `msg-ticks ticks--${state}`;
  if (state === 'sent') {
    // Satu centang
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  } else {
    // Dua centang biru
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="17 6 9 17 4 12"/><polyline points="23 6 15 17 13 15"/></svg>`;
  }
  return el;
}

// ══════════════════════════════════════════════
// REALTIME — PESAN BARU
// ══════════════════════════════════════════════

/**
 * Berlangganan perubahan realtime pada tabel messages untuk room ini.
 * INSERT → tampilkan pesan baru
 * UPDATE → perbarui pesan (pin, deleted_by)
 * DELETE → hapus bubble dari DOM
 */
function subscribeToMessages() {
  if (RoomModule.realtimeChannel) {
    supabaseClient.removeChannel(RoomModule.realtimeChannel);
  }

  RoomModule.realtimeChannel = supabaseClient
    .channel(`messages-${RoomModule.roomId}`)
    .on('postgres_changes', {
      event:  'INSERT',
      schema: 'public',
      table:  'messages',
      filter: `room_id=eq.${RoomModule.roomId}`,
    }, (payload) => {
      const myId = currentProfile?.id;
      const msg  = payload.new;

      // Hindari duplikasi jika kita sendiri yang mengirim (sudah dirender sementara)
      const existingRow = document.querySelector(`[data-id="${msg.id}"]`);
      if (existingRow) {
        // Hapus bubble sementara dan ganti dengan yang dari DB
        existingRow.remove();
      }

      RoomModule.messages.push(msg);
      const el = buildMessageElement(msg, myId);
      if (el) {
        const area = document.getElementById('messages-area');
        area.appendChild(el);
        scrollToBottom();
      }
    })
    .on('postgres_changes', {
      event:  'UPDATE',
      schema: 'public',
      table:  'messages',
      filter: `room_id=eq.${RoomModule.roomId}`,
    }, (payload) => {
      handleMessageUpdate(payload.new);
    })
    .on('postgres_changes', {
      event:  'DELETE',
      schema: 'public',
      table:  'messages',
      filter: `room_id=eq.${RoomModule.roomId}`,
    }, (payload) => {
      removeMessageFromDOM(payload.old.id);
    })
    .subscribe();
}

/**
 * Tangani UPDATE pada pesan (pin, deleted_by diperbarui).
 * @param {object} updatedMsg
 */
function handleMessageUpdate(updatedMsg) {
  const myId = currentProfile?.id;

  // Perbarui data di array lokal
  const idx = RoomModule.messages.findIndex(m => m.id === updatedMsg.id);
  if (idx !== -1) RoomModule.messages[idx] = updatedMsg;

  const existingRow = document.querySelector(`[data-id="${updatedMsg.id}"]`);

  // Jika pesan sekarang ada di deleted_by saya → hapus dari DOM
  if (Array.isArray(updatedMsg.deleted_by) && updatedMsg.deleted_by.includes(myId)) {
    if (existingRow) existingRow.remove();
    return;
  }

  // Update status pin
  if (existingRow) {
    const bubble = existingRow.querySelector('.msg-bubble');
    if (bubble) {
      bubble.classList.toggle('msg-bubble--pinned', updatedMsg.is_pinned);
    }
  }

  if (updatedMsg.is_pinned) {
    showPinnedBanner(updatedMsg);
  }
}

/**
 * Hapus baris pesan dari DOM berdasarkan ID.
 * @param {string} msgId
 */
function removeMessageFromDOM(msgId) {
  const row = document.querySelector(`[data-id="${msgId}"]`);
  if (row) {
    row.style.transition = 'opacity 0.25s, transform 0.25s';
    row.style.opacity = '0';
    row.style.transform = 'scale(0.9)';
    setTimeout(() => row.remove(), 250);
  }

  // Jika pesan yang dihapus adalah pinned, sembunyikan banner
  if (RoomModule.pinnedMsgId === msgId) hidePinnedBanner();
}

// ══════════════════════════════════════════════
// PRESENCE — MENGETIK & ONLINE
// ══════════════════════════════════════════════

/**
 * Berlangganan ke Supabase Presence untuk room ini.
 * Digunakan untuk: status online, tanda "Mengetik...", tanda centang biru.
 */
function subscribeToPresence() {
  if (RoomModule.presenceChannel) {
    supabaseClient.removeChannel(RoomModule.presenceChannel);
  }

  const myId    = currentProfile?.id;
  const roomKey = `presence-room-${RoomModule.roomId}`;

  RoomModule.presenceChannel = supabaseClient.channel(roomKey, {
    config: { presence: { key: myId } }
  });

  RoomModule.presenceChannel
    .on('presence', { event: 'sync' }, () => {
      const state   = RoomModule.presenceChannel.presenceState();
      const others  = Object.keys(state).filter(k => k !== myId);

      if (others.length > 0) {
        const otherState = state[others[0]]?.[0] || {};
        if (otherState.typing) {
          setPartnerStatus('typing');
        } else {
          setPartnerStatus('online');
        }

        // Ubah semua tanda centang menjadi dua centang biru (pesan sudah dilihat)
        if (otherState.inRoom) {
          updateAllTicksToSeen();
        }
      } else {
        setPartnerStatus('offline');
      }
    })
    .on('presence', { event: 'leave' }, () => {
      setPartnerStatus('offline');
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await RoomModule.presenceChannel.track({
          userId:  myId,
          inRoom:  true,
          typing:  false,
        });
      }
    });
}

/**
 * Ubah semua tanda centang pesan milik saya menjadi dua centang biru.
 */
function updateAllTicksToSeen() {
  document.querySelectorAll('.msg-ticks').forEach(el => {
    if (el.classList.contains('ticks--sent')) {
      el.className = 'msg-ticks ticks--seen';
      el.innerHTML = buildTicks('seen').innerHTML;
    }
  });
}

// ══════════════════════════════════════════════
// INPUT & KIRIM PESAN
// ══════════════════════════════════════════════

/**
 * Dipanggil setiap kali konten input berubah.
 * Auto-resize textarea, aktifkan tombol kirim, kirim event typing.
 * @param {HTMLTextAreaElement} el
 */
function handleInputChange(el) {
  // Auto-resize
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';

  // Toggle tombol kirim
  const sendBtn = document.getElementById('room-send-btn');
  const hasContent = el.value.trim().length > 0 || RoomModule.pendingMedia !== null;
  if (sendBtn) sendBtn.disabled = !hasContent;

  // Kirim event "sedang mengetik" via Presence
  broadcastTyping(el.value.length > 0);
}

/**
 * Kirim event typing/berhenti via Supabase Presence.
 * Di-debounce: berhenti mengetik terdeteksi setelah 2 detik idle.
 * @param {boolean} isTyping
 */
function broadcastTyping(isTyping) {
  if (!RoomModule.presenceChannel) return;

  clearTimeout(RoomModule.typingTimer);

  if (isTyping && !RoomModule.isTyping) {
    RoomModule.isTyping = true;
    RoomModule.presenceChannel.track({ userId: currentProfile?.id, inRoom: true, typing: true });
  }

  if (isTyping) {
    RoomModule.typingTimer = setTimeout(() => {
      RoomModule.isTyping = false;
      RoomModule.presenceChannel.track({ userId: currentProfile?.id, inRoom: true, typing: false });
    }, 2000);
  } else if (!isTyping && RoomModule.isTyping) {
    RoomModule.isTyping = false;
    RoomModule.presenceChannel.track({ userId: currentProfile?.id, inRoom: true, typing: false });
  }
}

/**
 * Tangani tombol Enter di textarea.
 * Enter tanpa Shift: kirim pesan. Enter+Shift: baris baru.
 * @param {KeyboardEvent} e
 */
function handleInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

/**
 * Kirim pesan teks dan/atau media ke Supabase.
 * Tampilkan bubble sementara terlebih dahulu untuk UX yang responsif.
 */
async function sendMessage() {
  const input   = document.getElementById('room-input');
  const content = input?.value.trim() || '';
  const media   = RoomModule.pendingMedia;

  if (!content && !media) return;
  if (!RoomModule.roomId || !currentProfile?.id) return;

  // Nonaktifkan tombol kirim sementara
  const sendBtn = document.getElementById('room-send-btn');
  if (sendBtn) sendBtn.disabled = true;

  // Bersihkan input
  if (input) { input.value = ''; input.style.height = 'auto'; }
  broadcastTyping(false);

  // Buat ID sementara untuk bubble optimistic
  const tempId = `temp-${Date.now()}`;

  // Render bubble sementara (optimistic UI)
  renderOptimisticMessage(tempId, content, media);
  scrollToBottom();

  let mediaUrl  = null;
  let mediaType = null;

  try {
    // ── Upload media ke Supabase Storage jika ada ──
    if (media) {
      const uploadResult = await uploadMedia(media.file);
      if (uploadResult) {
        mediaUrl  = uploadResult.url;
        mediaType = uploadResult.type;
      }
      clearPendingMedia();
    }

    // ── INSERT pesan ke Supabase ──
    const { data: newMsg, error } = await supabaseClient
      .from('messages')
      .insert([{
        room_id:    RoomModule.roomId,
        sender_id:  currentProfile.id,
        content:    content || null,
        media_url:  mediaUrl,
        media_type: mediaType,
      }])
      .select('id')
      .single();

    if (error) throw error;

    // Hapus bubble sementara (akan diganti oleh realtime INSERT)
    const tempRow = document.querySelector(`[data-id="${tempId}"]`);
    if (tempRow) tempRow.dataset.id = newMsg.id;

    // Perbarui last_message di tabel rooms
    await supabaseClient
      .from('rooms')
      .update({
        last_message:    content || (mediaType === 'image' ? '📷 Foto' : '🎬 Video'),
        last_message_at: new Date().toISOString(),
      })
      .eq('id', RoomModule.roomId);

  } catch (err) {
    console.error('[ElChat] sendMessage error:', err);
    showToast('Gagal mengirim pesan.', 'error');
    // Hapus bubble sementara jika gagal
    const tempRow = document.querySelector(`[data-id="${tempId}"]`);
    if (tempRow) {
      tempRow.style.opacity = '0.4';
      tempRow.title = 'Gagal terkirim';
    }
  } finally {
    if (sendBtn && (input?.value.trim() || RoomModule.pendingMedia)) {
      sendBtn.disabled = false;
    }
  }
}

/**
 * Render bubble pesan sementara (optimistic) sebelum konfirmasi dari DB.
 * @param {string} tempId   - ID sementara
 * @param {string} content  - Teks pesan
 * @param {object|null} media - Objek media lokal
 */
function renderOptimisticMessage(tempId, content, media) {
  const myId = currentProfile?.id;
  const area = document.getElementById('messages-area');
  if (!area) return;

  const row  = document.createElement('div');
  row.className   = 'msg-row msg-row--mine';
  row.dataset.id  = tempId;
  row.dataset.own = '1';

  const wrap   = document.createElement('div');
  wrap.className = 'msg-bubble-wrap';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if (media?.dataUrl) {
    const img = document.createElement('img');
    img.className = 'msg-media';
    img.src = media.dataUrl;
    bubble.appendChild(img);
  }

  if (content) {
    const txt = document.createElement('span');
    txt.textContent = content;
    bubble.appendChild(txt);
  }

  wrap.appendChild(bubble);

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  const time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = formatMsgTime(new Date().toISOString());
  meta.appendChild(time);
  const ticks = buildTicks('sent');
  meta.appendChild(ticks);
  wrap.appendChild(meta);
  row.appendChild(wrap);

  attachLongPress(row, tempId);
  area.appendChild(row);
}

// ══════════════════════════════════════════════
// LONG PRESS — SELEKSI PESAN
// ══════════════════════════════════════════════

/**
 * Pasang event listener long-press pada baris pesan.
 * Bekerja baik di mobile (touch) maupun desktop (mousedown).
 * @param {HTMLElement} row   - Elemen baris pesan
 * @param {string}      msgId - ID pesan
 */
function attachLongPress(row, msgId) {
  const start = () => {
    RoomModule.longPressTimer = setTimeout(() => {
      triggerMessageSelection(row, msgId);
    }, LONG_PRESS_DURATION);
  };
  const cancel = () => clearTimeout(RoomModule.longPressTimer);

  row.addEventListener('touchstart',  start,  { passive: true });
  row.addEventListener('touchend',    cancel, { passive: true });
  row.addEventListener('touchmove',   cancel, { passive: true });
  row.addEventListener('mousedown',   start);
  row.addEventListener('mouseup',     cancel);
  row.addEventListener('mouseleave',  cancel);
  // Cegah context menu bawaan browser di mobile
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); start(); });
}

/**
 * Aktifkan mode seleksi untuk pesan tertentu.
 * Ganti header normal dengan header seleksi.
 * @param {HTMLElement} row
 * @param {string}      msgId
 */
function triggerMessageSelection(row, msgId) {
  // Hapus seleksi sebelumnya
  document.querySelectorAll('.msg-row.selected').forEach(r => r.classList.remove('selected'));

  RoomModule.selectedMsgId = msgId;
  row.classList.add('selected');

  // Tampilkan header seleksi
  document.getElementById('room-header').hidden      = true;
  document.getElementById('room-select-header').hidden = false;

  // Tampilkan/sembunyikan tombol pin berdasarkan apakah pesan sudah di-pin
  const msg       = RoomModule.messages.find(m => m.id === msgId);
  const pinBtn    = document.getElementById('btn-pin-msg');
  if (pinBtn && msg) {
    pinBtn.title = msg.is_pinned ? 'Lepas Sematan' : 'Sematkan';
  }

  // Perbarui label jumlah seleksi
  const countEl = document.getElementById('select-header-count');
  if (countEl) countEl.textContent = '1 dipilih';

  // Feedback getaran (mobile)
  if (navigator.vibrate) navigator.vibrate(40);
}

/** Batalkan semua seleksi pesan dan kembali ke header normal. */
function clearMessageSelection() {
  RoomModule.selectedMsgId = null;
  document.querySelectorAll('.msg-row.selected').forEach(r => r.classList.remove('selected'));

  const normalHeader = document.getElementById('room-header');
  const selectHeader = document.getElementById('room-select-header');
  if (normalHeader) normalHeader.hidden = false;
  if (selectHeader) selectHeader.hidden = true;
}

// ══════════════════════════════════════════════
// SEMATKAN PESAN (PIN)
// ══════════════════════════════════════════════

/**
 * Sematkan atau lepas sematan pesan yang dipilih.
 */
async function pinSelectedMessage() {
  const msgId = RoomModule.selectedMsgId;
  if (!msgId || msgId.startsWith('temp-')) return;

  const msg    = RoomModule.messages.find(m => m.id === msgId);
  if (!msg) return;

  const newPinState = !msg.is_pinned;

  clearMessageSelection();

  try {
    // Lepas pin dari semua pesan lain di room ini terlebih dahulu
    if (newPinState) {
      await supabaseClient
        .from('messages')
        .update({ is_pinned: false })
        .eq('room_id', RoomModule.roomId)
        .eq('is_pinned', true)
        .neq('id', msgId);
    }

    // Update pin untuk pesan yang dipilih
    const { error } = await supabaseClient
      .from('messages')
      .update({ is_pinned: newPinState })
      .eq('id', msgId);

    if (error) throw error;

    // Update state lokal
    RoomModule.messages.forEach(m => {
      if (m.id !== msgId) m.is_pinned = false;
    });
    msg.is_pinned = newPinState;

    if (newPinState) {
      showPinnedBanner(msg);
      showToast('Pesan disematkan.', 'success');
    } else {
      hidePinnedBanner();
      showToast('Sematan dilepas.', '');
    }

  } catch (err) {
    console.error('[ElChat] pinSelectedMessage error:', err);
    showToast('Gagal menyematkan pesan.', 'error');
  }
}

/**
 * Tampilkan banner pesan disematkan di atas area chat.
 * @param {object} msg - Data pesan
 */
function showPinnedBanner(msg) {
  const banner  = document.getElementById('pinned-banner');
  const preview = document.getElementById('pinned-preview');
  if (!banner || !preview) return;

  RoomModule.pinnedMsgId = msg.id;
  preview.textContent    = msg.content || (msg.media_url ? '📷 Foto' : '—');
  banner.hidden          = false;
}

function hidePinnedBanner() {
  const banner = document.getElementById('pinned-banner');
  if (banner)  banner.hidden = true;
  RoomModule.pinnedMsgId = null;
}

/** Klik banner pin → scroll ke pesan yang disematkan */
function dismissPinnedBanner() {
  const msgId = RoomModule.pinnedMsgId;
  if (msgId) {
    const row = document.querySelector(`[data-id="${msgId}"]`);
    if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// ══════════════════════════════════════════════
// HAPUS PESAN — Modal Opsi
// ══════════════════════════════════════════════

/**
 * Buka modal opsi hapus pesan.
 * Menampilkan opsi "untuk semua orang" hanya jika pesan adalah milik saya.
 */
function openDeleteModal() {
  const msgId = RoomModule.selectedMsgId;
  if (!msgId || msgId.startsWith('temp-')) return;

  const msg   = RoomModule.messages.find(m => m.id === msgId);
  const isMine = msg?.sender_id === currentProfile?.id;

  clearMessageSelection();

  const actionsEl = document.getElementById('delete-modal-actions');
  if (!actionsEl) return;

  let html = '';

  // Hanya pemilik pesan yang bisa menghapus untuk semua orang
  if (isMine) {
    html += `
      <button class="delete-option-btn delete-option-btn--danger" onclick="deleteForEveryone('${escapeHtml(msgId)}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
        Hapus untuk Semua Orang
      </button>`;
  }

  html += `
    <button class="delete-option-btn" onclick="deleteForMe('${escapeHtml(msgId)}')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 7l-10 10M7 7l10 10"/></svg>
      Hapus untuk Saya Saja
    </button>`;

  actionsEl.innerHTML = html;

  const overlay = document.getElementById('delete-msg-overlay');
  if (overlay) {
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('open'));
    document.body.style.overflow = 'hidden';
  }
}

function closeDeleteModal(event) {
  if (event && event.target !== document.getElementById('delete-msg-overlay')) return;
  const overlay = document.getElementById('delete-msg-overlay');
  if (overlay) {
    overlay.classList.remove('open');
    setTimeout(() => { overlay.hidden = true; document.body.style.overflow = ''; }, 280);
  }
}

/**
 * Hapus pesan secara fisik dari database.
 * Hanya dapat dilakukan oleh pengirim pesan.
 * @param {string} msgId
 */
async function deleteForEveryone(msgId) {
  closeDeleteModal();
  try {
    const { error } = await supabaseClient
      .from('messages')
      .delete()
      .eq('id', msgId)
      .eq('sender_id', currentProfile?.id);  // RLS double-check

    if (error) throw error;
    removeMessageFromDOM(msgId);
    showToast('Pesan dihapus untuk semua orang.', '');
  } catch (err) {
    console.error('[ElChat] deleteForEveryone error:', err);
    showToast('Gagal menghapus pesan.', 'error');
  }
}

/**
 * Tambahkan ID saya ke array deleted_by pesan.
 * Pesan tetap ada di DB dan terlihat oleh pengguna lain.
 * @param {string} msgId
 */
async function deleteForMe(msgId) {
  closeDeleteModal();
  const myId = currentProfile?.id;
  if (!myId) return;

  try {
    // Gunakan fungsi array_append Postgres via rpc, atau ambil dulu lalu update
    const msg = RoomModule.messages.find(m => m.id === msgId);
    if (!msg) throw new Error('Pesan tidak ditemukan di state lokal.');

    const currentDeletedBy = Array.isArray(msg.deleted_by) ? msg.deleted_by : [];
    if (currentDeletedBy.includes(myId)) return; // sudah dihapus sebelumnya

    const newDeletedBy = [...currentDeletedBy, myId];

    const { error } = await supabaseClient
      .from('messages')
      .update({ deleted_by: newDeletedBy })
      .eq('id', msgId);

    if (error) throw error;

    // Update state lokal dan hapus dari DOM
    msg.deleted_by = newDeletedBy;
    removeMessageFromDOM(msgId);
    showToast('Pesan dihapus untuk kamu.', '');
  } catch (err) {
    console.error('[ElChat] deleteForMe error:', err);
    showToast('Gagal menghapus pesan.', 'error');
  }
}

// ══════════════════════════════════════════════
// HAPUS SEMUA CHAT UNTUK SAYA
// ══════════════════════════════════════════════

function confirmDeleteAllForMe() {
  closeRoomMenu();
  const overlay = document.getElementById('deleteall-overlay');
  if (overlay) {
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('open'));
    document.body.style.overflow = 'hidden';
  }
}

function closeDeleteAllModal(event) {
  if (event && event.target !== document.getElementById('deleteall-overlay')) return;
  const overlay = document.getElementById('deleteall-overlay');
  if (overlay) {
    overlay.classList.remove('open');
    setTimeout(() => { overlay.hidden = true; document.body.style.overflow = ''; }, 280);
  }
}

/**
 * Tambahkan ID saya ke deleted_by pada SEMUA pesan di room ini
 * yang belum mengandung ID saya.
 */
async function executeDeleteAllForMe() {
  closeDeleteAllModal();
  const myId = currentProfile?.id;
  if (!myId || !RoomModule.roomId) return;

  try {
    // Ambil ID semua pesan yang belum di-delete oleh saya
    const { data: msgs, error: fetchErr } = await supabaseClient
      .from('messages')
      .select('id, deleted_by')
      .eq('room_id', RoomModule.roomId)
      .not('deleted_by', 'cs', `{${myId}}`);  // cs = contains

    if (fetchErr) throw fetchErr;
    if (!msgs || msgs.length === 0) {
      showToast('Tidak ada pesan untuk dihapus.', '');
      return;
    }

    // Update setiap pesan (batch dalam satu transaksi via multiple updates)
    const updates = msgs.map(m => {
      const newDeletedBy = [...(m.deleted_by || []), myId];
      return supabaseClient
        .from('messages')
        .update({ deleted_by: newDeletedBy })
        .eq('id', m.id);
    });

    await Promise.all(updates);

    // Bersihkan semua bubble dari DOM
    const area = document.getElementById('messages-area');
    if (area) {
      Array.from(area.children).forEach(c => {
        if (c.id !== 'messages-loading' && !c.classList.contains('msg-date-sep')) {
          c.remove();
        }
      });
      // Tampilkan info kosong
      area.insertAdjacentHTML('beforeend', `
        <div style="text-align:center;padding:40px 20px;color:var(--text-muted);font-size:13.5px;">
          Kamu telah menghapus semua pesan di percakapan ini.
        </div>`);
    }

    hidePinnedBanner();
    showToast('Semua chat berhasil dihapus untuk kamu.', 'success');

  } catch (err) {
    console.error('[ElChat] executeDeleteAllForMe error:', err);
    showToast('Gagal menghapus semua pesan.', 'error');
  }
}

// ══════════════════════════════════════════════
// BLOKIR PENGGUNA
// ══════════════════════════════════════════════

function confirmBlockUser() {
  closeRoomMenu();
  const partner  = RoomModule.partnerProfile;
  const titleEl  = document.getElementById('block-modal-title');
  const subEl    = document.getElementById('block-modal-sub');
  if (titleEl) titleEl.textContent = `Blokir @${partner?.username || 'pengguna ini'}?`;
  if (subEl) subEl.textContent = 'Pengguna yang diblokir tidak bisa mengirim pesan kepadamu.';

  const overlay = document.getElementById('block-overlay');
  if (overlay) {
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('open'));
    document.body.style.overflow = 'hidden';
  }
}

function closeBlockModal(event) {
  if (event && event.target !== document.getElementById('block-overlay')) return;
  const overlay = document.getElementById('block-overlay');
  if (overlay) {
    overlay.classList.remove('open');
    setTimeout(() => { overlay.hidden = true; document.body.style.overflow = ''; }, 280);
  }
}

async function executeBlockUser() {
  closeBlockModal();
  const myId      = currentProfile?.id;
  const partnerId = RoomModule.partnerId;
  if (!myId || !partnerId) return;

  try {
    const { error } = await supabaseClient
      .from('blocked_users')
      .insert([{ blocker_id: myId, blocked_id: partnerId }]);

    if (error && error.code !== '23505') throw error; // 23505 = sudah diblokir

    showToast(`@${RoomModule.partnerProfile?.username || 'Pengguna'} telah diblokir.`, 'success');
    closeRoom();
  } catch (err) {
    console.error('[ElChat] executeBlockUser error:', err);
    showToast('Gagal memblokir pengguna.', 'error');
  }
}

// ══════════════════════════════════════════════
// UPLOAD MEDIA
// ══════════════════════════════════════════════

function toggleMediaMenu() {
  const menu = document.getElementById('media-dropdown-menu');
  const isOpen = menu.classList.contains('open');
  menu.classList.toggle('open', !isOpen);
  menu.setAttribute('aria-hidden', String(isOpen));
}

function closeMediaMenu() {
  const menu = document.getElementById('media-dropdown-menu');
  if (menu) { menu.classList.remove('open'); menu.setAttribute('aria-hidden', 'true'); }
}

function openCamera()  { closeMediaMenu(); document.getElementById('camera-input')?.click(); }
function openGallery() { closeMediaMenu(); document.getElementById('gallery-input')?.click(); }

/**
 * Tangani pemilihan file media dari input tersembunyi.
 * Tampilkan preview di atas input area sebelum dikirim.
 * @param {HTMLInputElement} input
 */
function handleMediaUpload(input) {
  const file = input.files?.[0];
  if (!file) return;

  const isVideo  = file.type.startsWith('video/');
  const type     = isVideo ? 'video' : 'image';
  const reader   = new FileReader();

  reader.onload = (e) => {
    RoomModule.pendingMedia = { file, dataUrl: e.target.result, type };
    showMediaPreview(e.target.result, type);

    // Aktifkan tombol kirim
    const sendBtn = document.getElementById('room-send-btn');
    if (sendBtn) sendBtn.disabled = false;
  };
  reader.readAsDataURL(file);

  // Reset input agar file yang sama bisa dipilih ulang
  input.value = '';
}

/**
 * Tampilkan preview media di atas input area.
 * @param {string} dataUrl
 * @param {'image'|'video'} type
 */
function showMediaPreview(dataUrl, type) {
  // Hapus preview lama jika ada
  document.getElementById('media-preview-row')?.remove();

  const inputArea = document.getElementById('room-input-area');
  if (!inputArea) return;

  const preview = document.createElement('div');
  preview.id        = 'media-preview-row';
  preview.className = 'media-preview';
  preview.innerHTML = `
    ${type === 'video'
      ? `<video src="${dataUrl}" style="width:56px;height:56px;border-radius:10px;object-fit:cover;"></video>`
      : `<img src="${dataUrl}" alt="preview" />`
    }
    <button class="media-preview__remove" onclick="clearPendingMedia()" aria-label="Hapus media">✕</button>
  `;
  inputArea.insertAdjacentElement('beforebegin', preview);
}

function clearPendingMedia() {
  RoomModule.pendingMedia = null;
  document.getElementById('media-preview-row')?.remove();
  const input  = document.getElementById('room-input');
  const sendBtn = document.getElementById('room-send-btn');
  if (sendBtn) sendBtn.disabled = !(input?.value.trim());
}

/**
 * Upload file ke Supabase Storage bucket 'chat-media'.
 * @param {File} file
 * @returns {{ url: string, type: string }|null}
 */
async function uploadMedia(file) {
  const myId    = currentProfile?.id;
  const ext     = file.name.split('.').pop() || 'bin';
  const path    = `${myId}/${RoomModule.roomId}/${Date.now()}.${ext}`;

  const { error } = await supabaseClient.storage
    .from('chat-media')
    .upload(path, file, { cacheControl: '3600', upsert: false });

  if (error) {
    console.error('[ElChat] uploadMedia error:', error);
    return null;
  }

  const { data } = supabaseClient.storage.from('chat-media').getPublicUrl(path);
  const type     = file.type.startsWith('video/') ? 'video' : 'image';

  return { url: data.publicUrl, type };
}

// ══════════════════════════════════════════════
// UTILITY
// ══════════════════════════════════════════════

/** Scroll ke bagian paling bawah area pesan */
function scrollToBottom(instant = false) {
  const area = document.getElementById('messages-area');
  if (!area) return;
  if (instant) { area.scrollTop = area.scrollHeight; return; }
  requestAnimationFrame(() => { area.scrollTop = area.scrollHeight; });
}

/**
 * Format waktu kirim pesan: HH:MM
 * @param {string} iso
 * @returns {string}
 */
function formatMsgTime(iso) {
  return new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Format pemisah tanggal di antara pesan.
 * @param {string} iso
 * @returns {string}
 */
function formatDateSep(iso) {
  const d    = new Date(iso);
  const now  = new Date();
  if (d.toDateString() === now.toDateString()) return 'Hari Ini';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Kemarin';
  return d.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Escape HTML untuk mencegah XSS. (Mirror dari chat.js agar room.js bisa berdiri sendiri)
 * @param {any} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

// ══════════════════════════════════════════════
// KEYBOARD SHORTCUT — Escape untuk keluar room
// ══════════════════════════════════════════════

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const screen = document.getElementById('room-screen');
  if (screen && !screen.hidden) {
    // Jika ada seleksi aktif, batalkan seleksi dulu
    if (RoomModule.selectedMsgId) { clearMessageSelection(); return; }
    // Jika modal hapus terbuka, tutup modal dulu
    const deleteOverlay = document.getElementById('delete-msg-overlay');
    if (deleteOverlay && !deleteOverlay.hidden) { closeDeleteModal(); return; }
    closeRoom();
  }
});
