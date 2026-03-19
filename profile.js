/* ═══════════════════════════════════════════════
   ELCHAT — PROFILE.JS
   Final Module: Profil, Pengaturan, Blokir, Privasi Status

   Cakupan:
   ─ Layar Profil: view + edit (nama, username, bio, tentang, foto)
   ─ Layar Pengaturan: navigasi ke sub-fitur
   ─ Manajemen Blokir: daftar + tombol Buka Blokir
   ─ Integrasi blokir ke Room (nonaktifkan input, sembunyikan story)
   ─ Privasi Status: daftar kontak + simpan ke localStorage + tabel story_privacy
   ─ Hook ke goToProfile() dan goToSettings() di chat.js

   SQL tambahan (jalankan jika belum ada):
   ─────────────────────────────────────────
   -- Tabel story_privacy (siapa yang tidak boleh melihat status)
   CREATE TABLE IF NOT EXISTS story_privacy (
     owner_id   uuid not null references auth.users(id) on delete cascade,
     blocked_id uuid not null references auth.users(id) on delete cascade,
     primary key (owner_id, blocked_id)
   );
   ALTER TABLE story_privacy ENABLE ROW LEVEL SECURITY;
   CREATE POLICY "owner manages own privacy"
     ON story_privacy FOR ALL USING (auth.uid() = owner_id);

   -- Kolom tambahan di profiles (jika belum ada)
   ALTER TABLE profiles ADD COLUMN IF NOT EXISTS full_name  text;
   ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bio        text;
   ALTER TABLE profiles ADD COLUMN IF NOT EXISTS about      text;
   ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_url text;
   ─────────────────────────────────────────
   Storage bucket "avatars" diperlukan untuk upload foto profil.
═══════════════════════════════════════════════ */

'use strict';

// ── Module State ───────────────────────────────
const ProfileModule = {
  editMode:       false,
  viewingUserId:  null,   // null = melihat profil sendiri
  allContacts:    [],     // Daftar kontak untuk privasi status
  privacyBlocked: new Set(), // ID yang dikecualikan dari melihat status
  privacyLoaded:  false,
};

// localStorage key untuk privasi status
const PRIVACY_KEY = 'elchat_story_privacy';

// ══════════════════════════════════════════════
// LAYAR PROFIL — Buka / Tutup
// ══════════════════════════════════════════════

/**
 * Buka layar profil.
 * @param {string|null} userId - null = profil sendiri, diisi = profil orang lain
 */
async function openProfileScreen(userId = null) {
  ProfileModule.viewingUserId = userId;
  ProfileModule.editMode      = false;

  const screen = document.getElementById('profile-screen');
  if (!screen) return;

  // Atur judul dan tombol edit
  const titleEl  = document.getElementById('profile-screen-title');
  const editBtn  = document.getElementById('btn-edit-profile');
  const isMine   = !userId || userId === currentProfile?.id;

  if (titleEl) titleEl.textContent = isMine ? 'Profil Saya' : 'Profil Pengguna';
  if (editBtn) editBtn.hidden = !isMine;

  // Sembunyikan mode edit, tampilkan view mode
  showProfileViewMode();

  screen.hidden = false;
  requestAnimationFrame(() => screen.classList.add('open'));
  document.body.style.overflow = 'hidden';

  // Muat data profil
  await loadProfileData(userId || currentProfile?.id);
}

function closeProfileScreen() {
  const screen = document.getElementById('profile-screen');
  if (screen) {
    screen.classList.remove('open');
    setTimeout(() => { screen.hidden = true; document.body.style.overflow = ''; }, 320);
  }
  ProfileModule.editMode = false;
}

// ══════════════════════════════════════════════
// MUAT DATA PROFIL
// ══════════════════════════════════════════════

async function loadProfileData(userId) {
  try {
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('id, username, full_name, bio, about, avatar_url, email, role')
      .eq('id', userId)
      .single();

    if (error) throw error;

    renderProfileView(data);

    // Pre-isi form edit jika ini profil sendiri
    if (!ProfileModule.viewingUserId || ProfileModule.viewingUserId === currentProfile?.id) {
      prefillEditForm(data);
    }
  } catch (err) {
    console.error('[ElChat] loadProfileData error:', err);
    showToast('Gagal memuat profil.', 'error');
  }
}

/**
 * Render tampilan view profil (bukan edit).
 * @param {object} profile
 */
function renderProfileView(profile) {
  const avatarEl = document.getElementById('pv-avatar');
  const uploadEl = document.getElementById('pv-avatar-upload');
  const isMine   = !ProfileModule.viewingUserId || ProfileModule.viewingUserId === currentProfile?.id;

  // Avatar
  if (avatarEl) {
    if (profile.avatar_url) {
      avatarEl.innerHTML = `<img src="${escapeHtml(profile.avatar_url)}" alt="avatar" />`;
    } else {
      avatarEl.textContent = (profile.username || 'U').substring(0, 2).toUpperCase();
      avatarEl.style.background = '';
    }
  }
  if (uploadEl) uploadEl.hidden = !isMine;

  // Fields
  setText('pv-fullname', profile.full_name || '—');
  setText('pv-username', profile.username ? `@${profile.username}` : '—');
  setText('pv-bio',      profile.bio || 'Belum ada bio.');
  setText('pv-about',    profile.about || '—');
  setText('pv-email',    profile.email || currentProfile?.email || '—');
}

function prefillEditForm(profile) {
  setValue('edit-fullname', profile.full_name || '');
  setValue('edit-username', profile.username  || '');
  setValue('edit-bio',      profile.bio       || '');
  setValue('edit-about',    profile.about     || '');
}

// ══════════════════════════════════════════════
// MODE EDIT
// ══════════════════════════════════════════════

/**
 * Toggle antara mode view dan mode edit.
 * @param {boolean|undefined} force - paksa mode tertentu
 */
function toggleEditMode(force) {
  ProfileModule.editMode = typeof force === 'boolean' ? force : !ProfileModule.editMode;
  if (ProfileModule.editMode) {
    showProfileEditMode();
  } else {
    showProfileViewMode();
  }
}

function showProfileViewMode() {
  document.getElementById('profile-fields-view').hidden = false;
  document.getElementById('profile-fields-edit').hidden = true;
  const uploadEl = document.getElementById('pv-avatar-upload');
  if (uploadEl) uploadEl.hidden = true;
}

function showProfileEditMode() {
  document.getElementById('profile-fields-view').hidden = true;
  document.getElementById('profile-fields-edit').hidden = false;
  const uploadEl = document.getElementById('pv-avatar-upload');
  if (uploadEl) uploadEl.hidden = false;
  showError('edit-profile-error', '');
  showError('edit-username-error', '');
}

/**
 * Simpan perubahan profil ke Supabase.
 */
async function saveProfile() {
  const fullName = document.getElementById('edit-fullname')?.value.trim() || '';
  const username = document.getElementById('edit-username')?.value.trim().toLowerCase() || '';
  const bio      = document.getElementById('edit-bio')?.value.trim() || '';
  const about    = document.getElementById('edit-about')?.value.trim() || '';

  showError('edit-profile-error', '');

  // Validasi username format
  if (username) {
    const { valid, message } = validateUsername(username);
    if (!valid) { showError('edit-username-error', message); return; }
  }

  // Cek apakah username sudah dipakai user lain
  if (username && username !== currentProfile?.username) {
    const { data: existing } = await supabaseClient
      .from('profiles')
      .select('id')
      .eq('username', username)
      .neq('id', currentProfile?.id)
      .maybeSingle();

    if (existing) {
      showError('edit-username-error', 'Username sudah digunakan orang lain.');
      return;
    }
  }

  setButtonLoading('btn-save-profile', true);

  try {
    const updates = { full_name: fullName || null, username, bio: bio || null, about: about || null };

    const { error } = await supabaseClient
      .from('profiles')
      .update(updates)
      .eq('id', currentProfile?.id);

    if (error) throw error;

    // Perbarui currentProfile lokal
    Object.assign(currentProfile, updates);
    sessionStorage.setItem('elchat_user', JSON.stringify(currentProfile));

    // Re-render avatar di header utama
    if (typeof renderUserAvatar === 'function') renderUserAvatar(currentProfile);

    showToast('Profil berhasil diperbarui!', 'success');
    toggleEditMode(false);
    await loadProfileData(currentProfile?.id);

  } catch (err) {
    console.error('[ElChat] saveProfile error:', err);
    showError('edit-profile-error', 'Gagal menyimpan. Coba lagi.');
  } finally {
    setButtonLoading('btn-save-profile', false);
  }
}

// ══════════════════════════════════════════════
// UPLOAD FOTO PROFIL
// ══════════════════════════════════════════════

/**
 * Upload foto profil baru ke bucket "avatars",
 * perbarui avatar_url di tabel profiles.
 * @param {HTMLInputElement} input
 */
async function handleAvatarUpload(input) {
  const file = input.files?.[0];
  if (!file) return;
  input.value = '';

  if (!file.type.startsWith('image/')) {
    showToast('Hanya file gambar yang diizinkan.', 'error');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showToast('Ukuran foto maksimal 5MB.', 'error');
    return;
  }

  showToast('Mengunggah foto profil...', '');

  try {
    const ext  = file.name.split('.').pop() || 'jpg';
    const path = `${currentProfile?.id}/avatar.${ext}`;

    // Hapus foto lama dan upload yang baru
    await supabaseClient.storage.from('avatars').remove([path]);
    const { error: uploadErr } = await supabaseClient.storage
      .from('avatars')
      .upload(path, file, { cacheControl: '3600', upsert: true });

    if (uploadErr) throw uploadErr;

    const { data: urlData } = supabaseClient.storage.from('avatars').getPublicUrl(path);
    // Tambahkan cache-bust agar browser tidak menggunakan gambar lama
    const avatarUrl = `${urlData.publicUrl}?t=${Date.now()}`;

    const { error: updateErr } = await supabaseClient
      .from('profiles')
      .update({ avatar_url: avatarUrl })
      .eq('id', currentProfile?.id);

    if (updateErr) throw updateErr;

    currentProfile.avatar_url = avatarUrl;
    sessionStorage.setItem('elchat_user', JSON.stringify(currentProfile));
    if (typeof renderUserAvatar === 'function') renderUserAvatar(currentProfile);

    showToast('Foto profil berhasil diperbarui!', 'success');
    await loadProfileData(currentProfile?.id);

  } catch (err) {
    console.error('[ElChat] handleAvatarUpload error:', err);
    showToast('Gagal mengunggah foto.', 'error');
  }
}

// ══════════════════════════════════════════════
// LAYAR PENGATURAN
// ══════════════════════════════════════════════

function openSettingsScreen() {
  const screen = document.getElementById('settings-screen');
  if (!screen) return;
  loadBlockedCount();
  screen.hidden = false;
  requestAnimationFrame(() => screen.classList.add('open'));
  document.body.style.overflow = 'hidden';
}

function closeSettingsScreen() {
  const screen = document.getElementById('settings-screen');
  if (screen) {
    screen.classList.remove('open');
    setTimeout(() => { screen.hidden = true; document.body.style.overflow = ''; }, 320);
  }
  closeBlockedUsersPanel();
}

// ══════════════════════════════════════════════
// MANAJEMEN BLOKIR
// ══════════════════════════════════════════════

/**
 * Muat jumlah pengguna yang diblokir dan tampilkan di label Pengaturan.
 */
async function loadBlockedCount() {
  const labelEl = document.getElementById('blocked-count-label');
  if (!labelEl) return;
  try {
    const { count } = await supabaseClient
      .from('blocked_users')
      .select('blocked_id', { count: 'exact', head: true })
      .eq('blocker_id', currentProfile?.id);
    labelEl.textContent = count > 0 ? `${count} pengguna diblokir` : 'Tidak ada';
  } catch { /* silent */ }
}

/**
 * Buka panel daftar pengguna yang diblokir.
 * Muat data dari Supabase dengan join ke profiles.
 */
async function openBlockedUsersPanel() {
  const panel  = document.getElementById('blocked-users-panel');
  const listEl = document.getElementById('blocked-users-list');
  if (!panel || !listEl) return;

  panel.hidden = false;
  listEl.innerHTML = `<div class="requests-loading" style="padding:18px;">Memuat...</div>`;

  try {
    const { data, error } = await supabaseClient
      .from('blocked_users')
      .select(`
        blocked_id,
        profile:profiles!blocked_users_blocked_id_fkey (
          id, username, full_name, avatar_url
        )
      `)
      .eq('blocker_id', currentProfile?.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    if (!data || data.length === 0) {
      listEl.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13.5px;">Kamu belum memblokir siapapun.</div>`;
      return;
    }

    listEl.innerHTML = data.map(item => {
      const p           = item.profile || {};
      const displayName = p.full_name || `@${p.username}`;
      const initials    = (p.username || 'U').substring(0, 2).toUpperCase();
      const avatarHtml  = p.avatar_url
        ? `<img src="${escapeHtml(p.avatar_url)}" alt="avatar" />`
        : initials;
      return `
        <div class="blocked-user-item" id="blocked-item-${escapeHtml(p.id)}">
          <div class="blocked-user-avatar">${avatarHtml}</div>
          <div class="blocked-user-info">
            <div class="blocked-user-name">${escapeHtml(displayName)}</div>
            <div class="blocked-user-uname">@${escapeHtml(p.username || '')}</div>
          </div>
          <button class="unblock-btn" onclick="unblockUser('${escapeHtml(p.id)}')">Buka Blokir</button>
        </div>`;
    }).join('');

  } catch (err) {
    console.error('[ElChat] openBlockedUsersPanel error:', err);
    listEl.innerHTML = `<div style="padding:18px;text-align:center;color:var(--text-muted);">Gagal memuat daftar.</div>`;
  }
}

function closeBlockedUsersPanel() {
  const panel = document.getElementById('blocked-users-panel');
  if (panel) panel.hidden = true;
}

/**
 * Hapus blokir terhadap pengguna tertentu.
 * @param {string} blockedUserId
 */
async function unblockUser(blockedUserId) {
  try {
    const { error } = await supabaseClient
      .from('blocked_users')
      .delete()
      .match({ blocker_id: currentProfile?.id, blocked_id: blockedUserId });

    if (error) throw error;

    // Hapus item dari DOM secara langsung
    document.getElementById(`blocked-item-${blockedUserId}`)?.remove();

    // Periksa jika daftar kosong sekarang
    const listEl = document.getElementById('blocked-users-list');
    if (listEl && listEl.querySelectorAll('.blocked-user-item').length === 0) {
      listEl.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13.5px;">Kamu belum memblokir siapapun.</div>`;
    }

    loadBlockedCount();
    showToast('Blokir berhasil dibuka.', 'success');

  } catch (err) {
    console.error('[ElChat] unblockUser error:', err);
    showToast('Gagal membuka blokir.', 'error');
  }
}

// ══════════════════════════════════════════════
// INTEGRASI BLOKIR KE ROOM
// ══════════════════════════════════════════════

/**
 * Periksa apakah ada blokir aktif antara dua user.
 * Dipanggil oleh room.js saat membuka room DM.
 * @param {string} otherUserId
 * @returns {Promise<{ blocked: boolean, direction: 'iblocked'|'theyblockedme'|null }>}
 */
async function checkBlockStatus(otherUserId) {
  const myId = currentProfile?.id;
  if (!myId || !otherUserId) return { blocked: false, direction: null };

  try {
    const { data } = await supabaseClient
      .from('blocked_users')
      .select('blocker_id, blocked_id')
      .or(
        `and(blocker_id.eq.${myId},blocked_id.eq.${otherUserId}),` +
        `and(blocker_id.eq.${otherUserId},blocked_id.eq.${myId})`
      )
      .limit(1)
      .maybeSingle();

    if (!data) return { blocked: false, direction: null };

    const direction = data.blocker_id === myId ? 'iblocked' : 'theyblockedme';
    return { blocked: true, direction };

  } catch {
    return { blocked: false, direction: null };
  }
}

/**
 * Nonaktifkan area input di ruang chat karena ada blokir aktif.
 * @param {'iblocked'|'theyblockedme'} direction
 */
function disableRoomInputForBlock(direction) {
  const inputArea = document.getElementById('room-input-area');
  const input     = document.getElementById('room-input');
  const sendBtn   = document.getElementById('room-send-btn');
  const mediaBtn  = document.getElementById('btn-media');

  const message = direction === 'iblocked'
    ? 'Kamu memblokir pengguna ini. Buka blokir untuk mengirim pesan.'
    : 'Kamu tidak bisa mengirim pesan ke pengguna ini.';

  if (inputArea) {
    inputArea.classList.add('room-input-area--blocked');
    inputArea.innerHTML = `<div class="blocked-notice">🚫 ${message}</div>`;
  }
}

// ══════════════════════════════════════════════
// PRIVASI STATUS
// ══════════════════════════════════════════════

/**
 * Buka modal privasi status.
 * Muat semua kontak (dari room_members) dan tandai yang dikecualikan.
 */
async function openStoryPrivacyModal() {
  const overlay = document.getElementById('story-privacy-overlay');
  if (overlay) {
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('open'));
    document.body.style.overflow = 'hidden';
  }

  // Muat daftar kontak jika belum
  if (!ProfileModule.privacyLoaded) {
    await loadPrivacyContacts();
  }
}

function closeStoryPrivacyModal(event) {
  if (event && event.target !== document.getElementById('story-privacy-overlay')) return;
  const overlay = document.getElementById('story-privacy-overlay');
  if (overlay) {
    overlay.classList.remove('open');
    setTimeout(() => { overlay.hidden = true; document.body.style.overflow = ''; }, 280);
  }
}

/**
 * Muat semua kontak yang sudah memiliki room DM dengan user aktif.
 * Tandai yang sudah ada di daftar privasi (dikecualikan dari melihat status).
 */
async function loadPrivacyContacts() {
  const listEl = document.getElementById('privacy-contacts-list');
  if (!listEl) return;

  listEl.innerHTML = `<div class="requests-loading" style="padding:16px;">Memuat kontak...</div>`;

  try {
    const myId = currentProfile?.id;

    // Ambil semua room_members di room DM yang dimiliki user ini
    const { data: memberData, error: memberErr } = await supabaseClient
      .from('room_members')
      .select('room_id')
      .eq('user_id', myId);

    if (memberErr) throw memberErr;

    const roomIds = (memberData || []).map(r => r.room_id);

    if (roomIds.length === 0) {
      listEl.innerHTML = `<div class="requests-empty" style="padding:20px;text-align:center;color:var(--text-muted);">Belum ada kontak.</div>`;
      ProfileModule.privacyLoaded = true;
      return;
    }

    // Ambil semua user lain di room-room tersebut
    const { data: others, error: othersErr } = await supabaseClient
      .from('room_members')
      .select(`
        user_id,
        profiles (id, username, full_name, avatar_url)
      `)
      .in('room_id', roomIds)
      .neq('user_id', myId);

    if (othersErr) throw othersErr;

    // Deduplicate berdasarkan user_id
    const seen    = new Set();
    const contacts = [];
    (others || []).forEach(row => {
      if (!seen.has(row.user_id) && row.profiles) {
        seen.add(row.user_id);
        contacts.push(row.profiles);
      }
    });

    ProfileModule.allContacts = contacts;

    // Muat daftar yang sudah dikecualikan dari Supabase
    await loadStoredPrivacyList();

    renderPrivacyContacts(contacts);
    ProfileModule.privacyLoaded = true;

  } catch (err) {
    console.error('[ElChat] loadPrivacyContacts error:', err);
    listEl.innerHTML = `<div class="requests-empty" style="padding:16px;text-align:center;color:var(--text-muted);">Gagal memuat kontak.</div>`;
  }
}

/**
 * Muat daftar ID yang dikecualikan dari tabel story_privacy (dan localStorage sebagai cache).
 */
async function loadStoredPrivacyList() {
  ProfileModule.privacyBlocked.clear();

  // Coba muat dari localStorage terlebih dahulu (cepat)
  try {
    const cached = localStorage.getItem(PRIVACY_KEY);
    if (cached) {
      JSON.parse(cached).forEach(id => ProfileModule.privacyBlocked.add(id));
    }
  } catch { /* ignore */ }

  // Sinkronisasi dengan Supabase
  try {
    const { data } = await supabaseClient
      .from('story_privacy')
      .select('blocked_id')
      .eq('owner_id', currentProfile?.id);

    if (data) {
      ProfileModule.privacyBlocked.clear();
      data.forEach(row => ProfileModule.privacyBlocked.add(row.blocked_id));
      // Perbarui cache lokal
      localStorage.setItem(PRIVACY_KEY, JSON.stringify([...ProfileModule.privacyBlocked]));
    }
  } catch { /* gunakan data lokal jika gagal */ }
}

/**
 * Render daftar kontak dengan checkbox status dikecualikan.
 * @param {object[]} contacts
 */
function renderPrivacyContacts(contacts) {
  const listEl = document.getElementById('privacy-contacts-list');
  if (!listEl) return;

  if (contacts.length === 0) {
    listEl.innerHTML = `<div class="requests-empty" style="padding:20px;text-align:center;color:var(--text-muted);">Belum ada kontak ditemukan.</div>`;
    return;
  }

  listEl.innerHTML = contacts.map(c => {
    const displayName = c.full_name || `@${c.username}`;
    const initials    = (c.username || 'U').substring(0, 2).toUpperCase();
    const avatarHtml  = c.avatar_url
      ? `<img src="${escapeHtml(c.avatar_url)}" alt="avatar" />`
      : initials;
    const isBlocked   = ProfileModule.privacyBlocked.has(c.id);

    return `
      <div class="privacy-contact-item${isBlocked ? ' checked' : ''}"
           id="pci-${escapeHtml(c.id)}"
           onclick="togglePrivacyContact('${escapeHtml(c.id)}')">
        <div class="privacy-contact-avatar">${avatarHtml}</div>
        <div class="privacy-contact-info">
          <div class="privacy-contact-name">${escapeHtml(displayName)}</div>
          <div class="privacy-contact-uname">@${escapeHtml(c.username || '')}</div>
        </div>
        <div class="privacy-checkbox" id="pcb-${escapeHtml(c.id)}"></div>
      </div>`;
  }).join('');
}

/**
 * Toggle status dikecualikan untuk satu kontak.
 * @param {string} contactId
 */
function togglePrivacyContact(contactId) {
  const itemEl = document.getElementById(`pci-${contactId}`);
  if (!itemEl) return;

  if (ProfileModule.privacyBlocked.has(contactId)) {
    ProfileModule.privacyBlocked.delete(contactId);
    itemEl.classList.remove('checked');
  } else {
    ProfileModule.privacyBlocked.add(contactId);
    itemEl.classList.add('checked');
  }
}

/**
 * Filter kontak berdasarkan input pencarian.
 * @param {string} query
 */
function filterPrivacyContacts(query) {
  const term = query.trim().toLowerCase();
  const filtered = term
    ? ProfileModule.allContacts.filter(c =>
        (c.username || '').toLowerCase().includes(term) ||
        (c.full_name || '').toLowerCase().includes(term))
    : ProfileModule.allContacts;
  renderPrivacyContacts(filtered);
}

/**
 * Simpan pengaturan privasi status.
 * Sinkronisasi ke tabel story_privacy di Supabase dan cache localStorage.
 */
async function saveStoryPrivacy() {
  const myId    = currentProfile?.id;
  const blocked = [...ProfileModule.privacyBlocked];

  // Simpan ke localStorage segera (optimistic)
  localStorage.setItem(PRIVACY_KEY, JSON.stringify(blocked));

  try {
    // Hapus semua baris lama milik user ini
    await supabaseClient
      .from('story_privacy')
      .delete()
      .eq('owner_id', myId);

    // Insert baris baru jika ada yang dikecualikan
    if (blocked.length > 0) {
      const rows = blocked.map(blockedId => ({ owner_id: myId, blocked_id: blockedId }));
      const { error } = await supabaseClient.from('story_privacy').insert(rows);
      if (error) throw error;
    }

    closeStoryPrivacyModal();
    showToast('Privasi status berhasil disimpan.', 'success');

  } catch (err) {
    console.error('[ElChat] saveStoryPrivacy error:', err);
    showToast('Gagal menyimpan. Perubahan disimpan secara lokal.', '');
    closeStoryPrivacyModal();
  }
}

/**
 * Periksa apakah sebuah userId dikecualikan dari melihat status kita.
 * Dipanggil oleh stories.js saat merender daftar story.
 * @param {string} userId
 * @returns {boolean}
 */
function isUserBlockedFromStories(userId) {
  return ProfileModule.privacyBlocked.has(userId);
}

// ══════════════════════════════════════════════
// OVERRIDE goToProfile & goToSettings dari chat.js
// ══════════════════════════════════════════════

// Override fungsi placeholder di chat.js dengan implementasi nyata
function goToProfile() {
  if (typeof closeChatMenu === 'function') closeChatMenu();
  openProfileScreen();
}

function goToSettings() {
  if (typeof closeChatMenu === 'function') closeChatMenu();
  openSettingsScreen();
}

// ══════════════════════════════════════════════
// INIT — dipanggil oleh app.js setelah login
// ══════════════════════════════════════════════

/**
 * Inisialisasi modul profil saat aplikasi pertama kali dimuat.
 * Muat privasi status dari cache lokal/Supabase.
 */
async function initProfileModule() {
  await loadStoredPrivacyList();
}

// ══════════════════════════════════════════════
// UTILITY
// ══════════════════════════════════════════════

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function setValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Keyboard: Escape untuk menutup layar yang sedang aktif
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;

  const profileScreen   = document.getElementById('profile-screen');
  const settingsScreen  = document.getElementById('settings-screen');
  const privacyOverlay  = document.getElementById('story-privacy-overlay');

  if (privacyOverlay && !privacyOverlay.hidden) { closeStoryPrivacyModal(); return; }
  if (settingsScreen  && !settingsScreen.hidden)  { closeSettingsScreen();  return; }
  if (profileScreen   && !profileScreen.hidden)   { closeProfileScreen();   return; }
});
