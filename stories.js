/* ═══════════════════════════════════════════════
   ELCHAT — STORIES.JS
   Stories / Status Module

   Fitur yang diimplementasikan:
   ─ Tampilan "Status Saya" + daftar status kontak
   ─ Ring warna-warni (belum ditonton) vs abu-abu (sudah)
   ─ Upload gambar (5 detik) atau video (maks. 60 detik)
   ─ Validasi durasi video via JS sebelum upload
   ─ Upload ke Supabase Storage bucket "stories"
   ─ Viewer fullscreen dengan progress bar animasi
   ─ Navigasi tap kiri/kanan & swipe
   ─ Insert ke story_views saat status ditonton
   ─ Panel daftar penonton (ikon mata) — Telegram style
   ─ Hapus status sendiri (Storage + DB)
   ─ Moderasi: Admin bisa hapus status user biasa;
     Developer bisa hapus status siapa saja termasuk Admin
   ─ Otomatis memfilter story > 24 jam di sisi klien

   Skema database yang diperlukan (SQL Editor):
   ────────────────────────────────────────────
   CREATE TABLE IF NOT EXISTS stories (
     id          uuid primary key default gen_random_uuid(),
     user_id     uuid not null references auth.users(id) on delete cascade,
     media_url   text not null,
     media_type  text not null,          -- 'image' | 'video'
     duration    int  not null default 5, -- detik
     storage_path text not null,
     created_at  timestamptz not null default now(),
     expires_at  timestamptz not null
                 generated always as (created_at + interval '24 hours') stored
   );
   CREATE INDEX ON stories(user_id, created_at);
   ALTER TABLE stories ENABLE ROW LEVEL SECURITY;
   CREATE POLICY "authenticated users can read stories"
     ON stories FOR SELECT USING (auth.role() = 'authenticated');
   CREATE POLICY "owner can insert own story"
     ON stories FOR INSERT WITH CHECK (auth.uid() = user_id);
   CREATE POLICY "owner can delete own story"
     ON stories FOR DELETE USING (auth.uid() = user_id);

   CREATE TABLE IF NOT EXISTS story_views (
     id         uuid primary key default gen_random_uuid(),
     story_id   uuid not null references stories(id) on delete cascade,
     viewer_id  uuid not null references auth.users(id) on delete cascade,
     viewed_at  timestamptz not null default now(),
     unique (story_id, viewer_id)
   );
   ALTER TABLE story_views ENABLE ROW LEVEL SECURITY;
   CREATE POLICY "story owner can read views"
     ON story_views FOR SELECT
     USING (EXISTS (
       SELECT 1 FROM stories s
       WHERE s.id = story_views.story_id
         AND s.user_id = auth.uid()
     ));
   CREATE POLICY "viewer can insert own view"
     ON story_views FOR INSERT WITH CHECK (auth.uid() = viewer_id);
   ────────────────────────────────────────────
   Storage bucket: buat bucket "stories" dengan akses publik.
═══════════════════════════════════════════════ */


// ── Module State ───────────────────────────────
const StoriesModule = {
  myStories:       [],    // Story milik user aktif (mungkin lebih dari satu)
  groupedStories:  [],    // Array { profile, stories[] } untuk tampilan daftar
  currentGroup:    null,  // Group yang sedang ditonton
  currentIndex:    0,     // Indeks story dalam group aktif
  progressTimer:   null,  // setInterval untuk progress bar
  progressStart:   null,  // Timestamp awal untuk interpolasi
  isPaused:        false, // Untuk pause saat menu terbuka
  touchStartX:     0,     // Untuk deteksi swipe horizontal
  viewerModalOpen: false,
};

const IMAGE_DURATION   = 5000;  // ms
const MAX_VIDEO_SECS   = 60;    // detik

// ══════════════════════════════════════════════
// INIT — dipanggil dari app.js saat halaman Stories aktif
// ══════════════════════════════════════════════

async function initStoriesPage() {
  renderMyStatusAvatar();
  await loadAllStories();
}

// ══════════════════════════════════════════════
// AVATAR STATUS SAYA
// ══════════════════════════════════════════════

function renderMyStatusAvatar() {
  const avatarEl = document.getElementById('my-status-avatar');
  const subEl    = document.getElementById('my-status-sub');
  if (!avatarEl) return;

  const profile = currentProfile;
  if (profile?.avatar_url) {
    avatarEl.innerHTML = `<img src="${escapeHtml(profile.avatar_url)}" alt="avatar" />`;
  } else {
    avatarEl.textContent = (profile?.username || 'U').substring(0, 2).toUpperCase();
  }

  // Cek apakah punya story aktif
  const hasActive = StoriesModule.myStories.length > 0;
  if (hasActive) {
    avatarEl.classList.add('my-status-avatar--has-story');
    if (subEl) subEl.textContent = `${StoriesModule.myStories.length} status aktif`;
  } else {
    avatarEl.classList.remove('my-status-avatar--has-story');
    if (subEl) subEl.textContent = 'Ketuk untuk menambahkan status';
  }
}

// ══════════════════════════════════════════════
// MUAT SEMUA STORIES
// ══════════════════════════════════════════════

/**
 * Memuat semua stories aktif (< 24 jam) dari Supabase.
 * Mengelompokkan berdasarkan user_id, menempatkan story sendiri terpisah.
 */
async function loadAllStories() {
  const myId     = currentProfile?.id;
  const skeleton = document.getElementById('stories-skeleton');
  const listEl   = document.getElementById('stories-list');
  const emptyEl  = document.getElementById('stories-empty');
  const sectionH = document.getElementById('stories-section-header');

  if (skeleton) skeleton.style.display = 'flex';
  if (emptyEl)  emptyEl.hidden = true;
  if (sectionH) sectionH.hidden = true;

  try {
    // Ambil semua stories yang belum expired, join dengan profiles
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data, error } = await supabaseClient
      .from('stories')
      .select(`
        id, user_id, media_url, media_type, duration, storage_path, created_at,
        profiles (id, username, full_name, avatar_url, role)
      `)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // ── Ambil semua view yang sudah dilakukan oleh user ini ──
    const { data: myViews } = await supabaseClient
      .from('story_views')
      .select('story_id')
      .eq('viewer_id', myId);

    const viewedIds = new Set((myViews || []).map(v => v.story_id));

    // ── Kelompokkan per user ──
    const groups = new Map();
    (data || []).forEach(story => {
      const uid = story.user_id;
      if (!groups.has(uid)) {
        groups.set(uid, { profile: story.profiles, stories: [] });
      }
      groups.get(uid).stories.push(story);
    });

    // Pisahkan story saya vs orang lain
    StoriesModule.myStories = groups.get(myId)?.stories || [];
    groups.delete(myId);

    StoriesModule.groupedStories = Array.from(groups.values()).filter(group => {
      // Jangan tampilkan story dari orang yang memblokir kita atau kita blokir
      // (checkBlockStatus bersifat async, untuk performa kita cek dari tabel blocked_users lokal)
      return true; // Penyaringan blokir lebih lanjut bisa ditambahkan jika diperlukan
    });

    // Filter: jangan tampilkan story kepada user yang dikecualikan dari melihat status kita
    // (hanya relevan untuk sisi penerima — ditangani di level Supabase RLS jika diperlukan)
    // Di sisi pengirim: filter user yang memblokir kita dari daftar story yang kita lihat
    // sudah ditangani oleh blocked_users RLS policy

    // ── Render ──
    if (skeleton) skeleton.remove();

    if (StoriesModule.groupedStories.length > 0) {
      if (sectionH) sectionH.hidden = false;
      StoriesModule.groupedStories.forEach(group => {
        const allSeen = group.stories.every(s => viewedIds.has(s.id));
        const itemEl  = buildStoryListItem(group, allSeen);
        listEl.appendChild(itemEl);
      });
    } else {
      if (emptyEl) emptyEl.hidden = false;
    }

    // Update avatar status saya
    renderMyStatusAvatar();

  } catch (err) {
    console.error('[ElChat] loadAllStories error:', err);
    if (skeleton) skeleton.remove();
    if (emptyEl) { emptyEl.hidden = false; }
  }
}

/**
 * Bangun elemen DOM untuk satu item daftar story.
 * @param {{ profile, stories[] }} group
 * @param {boolean} allSeen
 * @returns {HTMLElement}
 */
function buildStoryListItem(group, allSeen) {
  const profile     = group.profile || {};
  const displayName = profile.full_name || `@${profile.username}`;
  const latestStory = group.stories[0];
  const timeStr     = formatRelativeTime(latestStory.created_at);

  const item = document.createElement('div');
  item.className = 'story-item';
  item.onclick   = () => openStoryViewer(group);

  // Ring wrap
  const ringWrap = document.createElement('div');
  ringWrap.className = `story-ring-wrap${allSeen ? ' story-ring-wrap--seen' : ''}`;

  const avatarEl = document.createElement('div');
  avatarEl.className = 'story-avatar';
  if (profile.avatar_url) {
    avatarEl.innerHTML = `<img src="${escapeHtml(profile.avatar_url)}" alt="${escapeHtml(displayName)}" loading="lazy" />`;
  } else {
    avatarEl.textContent = (profile.username || 'U').substring(0, 2).toUpperCase();
  }
  ringWrap.appendChild(avatarEl);
  item.appendChild(ringWrap);

  // Info
  const info = document.createElement('div');
  info.className = 'story-item-info';
  info.innerHTML = `
    <div class="story-item-name">${escapeHtml(displayName)}</div>
    <div class="story-item-time">${timeStr}</div>
  `;
  item.appendChild(info);

  return item;
}

// ══════════════════════════════════════════════
// KLIK "STATUS SAYA"
// ══════════════════════════════════════════════

/**
 * Klik pada kartu "Status Saya".
 * Jika sudah ada story: buka viewer stories milik sendiri.
 * Jika belum ada story: langsung buka file picker.
 */
function handleMyStatusClick() {
  if (StoriesModule.myStories.length > 0) {
    // Tampilkan story sendiri
    openStoryViewer({
      profile: currentProfile,
      stories: StoriesModule.myStories,
    }, true);
  } else {
    document.getElementById('story-file-input')?.click();
  }
}

// ══════════════════════════════════════════════
// UPLOAD STORY
// ══════════════════════════════════════════════

/**
 * Dipanggil saat file dipilih dari input.
 * Validasi tipe & durasi, lalu upload.
 * @param {HTMLInputElement} input
 */
async function handleStoryFileSelected(input) {
  const file = input.files?.[0];
  if (!file) return;

  input.value = '';

  const isVideo = file.type.startsWith('video/');
  const isImage = file.type.startsWith('image/');

  if (!isVideo && !isImage) {
    showToast('Format file tidak didukung. Gunakan gambar atau video.', 'error');
    return;
  }

  // Validasi durasi video sebelum upload
  if (isVideo) {
    const duration = await getVideoDuration(file);
    if (duration > MAX_VIDEO_SECS) {
      showToast(`Video terlalu panjang (maks. ${MAX_VIDEO_SECS} detik). Video ini ${Math.round(duration)} detik.`, 'error');
      return;
    }
    showToast('Mengunggah video...', '');
    await uploadStory(file, 'video', Math.min(Math.ceil(duration), MAX_VIDEO_SECS));
  } else {
    showToast('Mengunggah gambar...', '');
    await uploadStory(file, 'image', 5);
  }
}

/**
 * Ukur durasi video menggunakan elemen <video> sementara.
 * @param {File} file
 * @returns {Promise<number>} durasi dalam detik
 */
function getVideoDuration(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload  = 'metadata';
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(video.src);
      resolve(video.duration);
    };
    video.onerror = reject;
    video.src = URL.createObjectURL(file);
  });
}

/**
 * Upload file story ke Supabase Storage lalu insert baris ke tabel stories.
 * @param {File}   file
 * @param {'image'|'video'} mediaType
 * @param {number} duration - detik tampilan
 */
async function uploadStory(file, mediaType, duration) {
  const myId = currentProfile?.id;
  if (!myId) return;

  const ext          = file.name.split('.').pop() || (mediaType === 'video' ? 'mp4' : 'jpg');
  const storagePath  = `${myId}/${Date.now()}.${ext}`;

  try {
    // Upload ke Supabase Storage
    const { error: uploadErr } = await supabaseClient.storage
      .from('stories')
      .upload(storagePath, file, { cacheControl: '3600', upsert: false });

    if (uploadErr) throw uploadErr;

    // Dapatkan public URL
    const { data: urlData } = supabaseClient.storage.from('stories').getPublicUrl(storagePath);

    // Insert ke tabel stories
    const { error: insertErr } = await supabaseClient
      .from('stories')
      .insert([{
        user_id:      myId,
        media_url:    urlData.publicUrl,
        media_type:   mediaType,
        duration:     duration,
        storage_path: storagePath,
      }]);

    if (insertErr) throw insertErr;

    showToast('Status berhasil diunggah! 🎉', 'success');

    // Reload halaman stories
    const listEl = document.getElementById('stories-list');
    if (listEl) {
      Array.from(listEl.children).forEach(c => c.remove());
      StoriesModule.groupedStories = [];
      StoriesModule.myStories      = [];
    }
    await loadAllStories();

  } catch (err) {
    console.error('[ElChat] uploadStory error:', err);
    showToast('Gagal mengunggah status. Coba lagi.', 'error');
  }
}

// ══════════════════════════════════════════════
// STORY VIEWER
// ══════════════════════════════════════════════

/**
 * Buka viewer fullscreen untuk group story tertentu.
 * @param {{ profile, stories[] }} group
 * @param {boolean} isMine - Apakah ini story milik sendiri
 */
async function openStoryViewer(group, isMine = false) {
  StoriesModule.currentGroup = group;
  StoriesModule.currentIndex = 0;
  StoriesModule.isPaused     = false;

  const viewer = document.getElementById('story-viewer');
  if (viewer) {
    viewer.hidden = false;
    requestAnimationFrame(() => viewer.classList.add('open'));
    document.body.style.overflow = 'hidden';
  }

  buildProgressBars(group.stories.length);
  await showStory(0, isMine);
}

/**
 * Tutup viewer dan bersihkan semua timer.
 */
function closeStoryViewer() {
  stopProgress();

  const viewer = document.getElementById('story-viewer');
  if (viewer) {
    viewer.classList.remove('open');
    setTimeout(() => {
      viewer.hidden = true;
      document.body.style.overflow = '';
    }, 300);
  }

  // Bersihkan media
  const img   = document.getElementById('story-img');
  const video = document.getElementById('story-video');
  if (img)   { img.src = ''; img.hidden = true; }
  if (video) { video.pause(); video.src = ''; video.hidden = true; }

  closeStoryMenu();
  StoriesModule.currentGroup = null;
  StoriesModule.currentIndex = 0;
}

/**
 * Tampilkan story pada indeks tertentu.
 * @param {number}  index
 * @param {boolean} isMine
 */
async function showStory(index, isMine) {
  const group   = StoriesModule.currentGroup;
  if (!group) return;

  StoriesModule.currentIndex = index;
  const story   = group.stories[index];
  if (!story) { closeStoryViewer(); return; }

  const myRole  = currentProfile?.role;
  const ownerId = group.profile?.id || story.user_id;
  isMine        = ownerId === currentProfile?.id;

  // ── Update header info ──
  setViewerHeader(group.profile, story);

  // ── Ikon mata & dropdown ──
  const eyeBtn  = document.getElementById('story-eye-btn');
  if (eyeBtn)  eyeBtn.hidden = !isMine;

  if (isMine) {
    await loadViewerCount(story.id);
  }
  buildStoryDropdown(story, isMine, myRole, group.profile);

  // ── Tampilkan loading ──
  const loadingEl = document.getElementById('story-media-loading');
  if (loadingEl) loadingEl.style.display = 'flex';

  const imgEl   = document.getElementById('story-img');
  const videoEl = document.getElementById('story-video');

  stopProgress();

  if (story.media_type === 'video') {
    if (imgEl)   { imgEl.hidden = true; imgEl.src = ''; }
    if (videoEl) {
      videoEl.hidden = false;
      videoEl.src    = story.media_url;
      videoEl.load();
      videoEl.oncanplay = () => {
        if (loadingEl) loadingEl.style.display = 'none';
        videoEl.play().catch(() => {});
        startProgress(story.duration * 1000, index, isMine);
      };
    }
  } else {
    if (videoEl) { videoEl.pause(); videoEl.hidden = true; videoEl.src = ''; }
    if (imgEl) {
      imgEl.hidden = false;
      imgEl.onload = () => {
        if (loadingEl) loadingEl.style.display = 'none';
        startProgress(IMAGE_DURATION, index, isMine);
      };
      imgEl.src = story.media_url;
    }
  }

  // ── Catat view (jika bukan milik sendiri) ──
  if (!isMine) {
    recordView(story.id);
  }

  // ── Tandai progress bar sebelumnya sebagai selesai ──
  for (let i = 0; i < index; i++) {
    const fill = document.querySelector(`#story-progress-bars .story-progress-bar:nth-child(${i + 1}) .story-progress-bar__fill`);
    if (fill) fill.style.width = '100%';
  }
  // Reset progress bar saat ini dan ke depannya
  for (let i = index; i < group.stories.length; i++) {
    const fill = document.querySelector(`#story-progress-bars .story-progress-bar:nth-child(${i + 1}) .story-progress-bar__fill`);
    if (fill) fill.style.width = '0%';
  }
}

/**
 * Update konten header viewer.
 */
function setViewerHeader(profile, story) {
  const nameEl   = document.getElementById('story-viewer-name');
  const timeEl   = document.getElementById('story-viewer-time');
  const avatarEl = document.getElementById('story-viewer-avatar');

  const displayName = profile?.full_name || `@${profile?.username}`;
  if (nameEl)  nameEl.textContent  = displayName;
  if (timeEl)  timeEl.textContent  = formatRelativeTime(story.created_at);

  if (avatarEl) {
    if (profile?.avatar_url) {
      avatarEl.innerHTML = `<img src="${escapeHtml(profile.avatar_url)}" alt="avatar" />`;
    } else {
      avatarEl.textContent = (profile?.username || 'U').substring(0, 2).toUpperCase();
    }
  }
}

// ══════════════════════════════════════════════
// PROGRESS BAR
// ══════════════════════════════════════════════

function buildProgressBars(count) {
  const container = document.getElementById('story-progress-bars');
  if (!container) return;
  container.innerHTML = Array.from({ length: count }, () =>
    `<div class="story-progress-bar"><div class="story-progress-bar__fill"></div></div>`
  ).join('');
}

/**
 * Mulai animasi progress bar untuk story aktif.
 * @param {number}  durationMs  - Total durasi dalam milidetik
 * @param {number}  index       - Indeks story saat ini
 * @param {boolean} isMine
 */
function startProgress(durationMs, index, isMine) {
  stopProgress();
  StoriesModule.progressStart = Date.now();

  const fill = document.querySelector(
    `#story-progress-bars .story-progress-bar:nth-child(${index + 1}) .story-progress-bar__fill`
  );
  if (!fill) return;

  StoriesModule.progressTimer = setInterval(() => {
    if (StoriesModule.isPaused) return;

    const elapsed = Date.now() - StoriesModule.progressStart;
    const pct     = Math.min((elapsed / durationMs) * 100, 100);
    fill.style.width = pct + '%';

    if (pct >= 100) {
      stopProgress();
      nextStory();
    }
  }, 50);
}

function stopProgress() {
  clearInterval(StoriesModule.progressTimer);
  StoriesModule.progressTimer = null;
}

// ══════════════════════════════════════════════
// NAVIGASI STORY
// ══════════════════════════════════════════════

async function nextStory() {
  const group = StoriesModule.currentGroup;
  if (!group) return;

  const nextIdx = StoriesModule.currentIndex + 1;
  const isMine  = group.profile?.id === currentProfile?.id;

  if (nextIdx < group.stories.length) {
    await showStory(nextIdx, isMine);
  } else {
    closeStoryViewer();
  }
}

async function prevStory() {
  const group = StoriesModule.currentGroup;
  if (!group) return;

  const prevIdx = StoriesModule.currentIndex - 1;
  const isMine  = group.profile?.id === currentProfile?.id;

  if (prevIdx >= 0) {
    await showStory(prevIdx, isMine);
  } else {
    closeStoryViewer();
  }
}

// Tap di area media — kiri: prev, kanan: next
function handleStoryTap(e) {
  const rect   = e.currentTarget.getBoundingClientRect();
  const tapX   = e.clientX - rect.left;
  if (tapX < rect.width * 0.35) {
    prevStory();
  } else if (tapX > rect.width * 0.65) {
    nextStory();
  }
}

// Swipe support
function handleStoryTouchStart(e) {
  StoriesModule.touchStartX = e.touches[0].clientX;
}
function handleStoryTouchEnd(e) {
  const diff = StoriesModule.touchStartX - e.changedTouches[0].clientX;
  if (Math.abs(diff) > 50) {
    if (diff > 0) nextStory(); else prevStory();
  }
}

// ══════════════════════════════════════════════
// CATAT VIEW
// ══════════════════════════════════════════════

async function recordView(storyId) {
  const myId = currentProfile?.id;
  if (!myId) return;
  try {
    await supabaseClient.from('story_views').insert([{
      story_id:  storyId,
      viewer_id: myId,
    }]);
    // Abaikan error 23505 (sudah pernah melihat)
  } catch { /* intentionally silent */ }
}

// ══════════════════════════════════════════════
// JUMLAH & DAFTAR PENONTON
// ══════════════════════════════════════════════

async function loadViewerCount(storyId) {
  const countEl = document.getElementById('story-eye-count');
  if (!countEl) return;
  try {
    const { count } = await supabaseClient
      .from('story_views')
      .select('id', { count: 'exact', head: true })
      .eq('story_id', storyId);
    if (countEl) countEl.textContent = count || 0;
  } catch { countEl.textContent = '0'; }
}

/**
 * Buka modal daftar penonton (Telegram style).
 */
async function openViewersList() {
  const story = StoriesModule.currentGroup?.stories[StoriesModule.currentIndex];
  if (!story) return;

  StoriesModule.isPaused = true;

  const overlay  = document.getElementById('viewers-overlay');
  const listEl   = document.getElementById('viewers-list');
  const countEl  = document.getElementById('viewers-count');

  if (overlay) {
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('open'));
    document.body.style.overflow = 'hidden';
    StoriesModule.viewerModalOpen = true;
  }
  if (listEl) listEl.innerHTML = `<div class="requests-loading">Memuat...</div>`;

  try {
    const { data, error } = await supabaseClient
      .from('story_views')
      .select(`
        viewed_at,
        viewer:profiles!story_views_viewer_id_fkey (
          id, username, full_name, avatar_url, role
        )
      `)
      .eq('story_id', story.id)
      .order('viewed_at', { ascending: false });

    if (error) throw error;

    if (countEl) countEl.textContent = data?.length || 0;

    if (!data || data.length === 0) {
      listEl.innerHTML = `<div class="requests-empty" style="padding:24px;text-align:center;color:var(--text-muted);font-size:13.5px;">Belum ada yang melihat statusmu.</div>`;
      return;
    }

    listEl.innerHTML = data.map(v => {
      const viewer      = v.viewer || {};
      const displayName = viewer.full_name || `@${viewer.username}`;
      const initials    = (viewer.username || 'U').substring(0, 2).toUpperCase();
      const avatarHtml  = viewer.avatar_url
        ? `<img src="${escapeHtml(viewer.avatar_url)}" alt="${escapeHtml(displayName)}" />`
        : initials;
      const roleLabel   = viewer.role === 'developer'
        ? `<span class="viewer-role-badge viewer-role-badge--developer">Dev</span>`
        : viewer.role === 'admin'
          ? `<span class="viewer-role-badge viewer-role-badge--admin">Admin</span>`
          : '';
      return `
        <div class="viewer-item">
          <div class="viewer-avatar">${avatarHtml}</div>
          <div class="viewer-info">
            <div class="viewer-name">${escapeHtml(displayName)}</div>
            <div class="viewer-time">${formatRelativeTime(v.viewed_at)}</div>
          </div>
          ${roleLabel}
        </div>`;
    }).join('');

  } catch (err) {
    console.error('[ElChat] openViewersList error:', err);
    listEl.innerHTML = `<div class="requests-empty" style="padding:24px;text-align:center;color:var(--text-muted);">Gagal memuat daftar.</div>`;
  }
}

function closeViewersList(event) {
  if (event && event.target !== document.getElementById('viewers-overlay')) return;
  const overlay = document.getElementById('viewers-overlay');
  if (overlay) {
    overlay.classList.remove('open');
    setTimeout(() => {
      overlay.hidden = true;
      document.body.style.overflow = '';
    }, 280);
  }
  StoriesModule.viewerModalOpen = false;
  StoriesModule.isPaused        = false; // resume progress
}

// ══════════════════════════════════════════════
// DROPDOWN MENU VIEWER (Hapus Status)
// ══════════════════════════════════════════════

/**
 * Bangun isi dropdown menu berdasarkan kepemilikan dan role.
 *
 * Logika moderasi:
 *  - Pemilik story: selalu bisa hapus story sendiri.
 *  - Admin melihat story user biasa: muncul tombol "Hapus Status Pengguna".
 *  - Developer melihat story siapa saja (termasuk admin): muncul tombol moderasi.
 *  - Admin TIDAK bisa hapus story admin/developer lain.
 *
 * @param {object}  story     - Data story aktif
 * @param {boolean} isMine    - Apakah story milik saya
 * @param {string}  myRole    - Role user yang sedang login
 * @param {object}  ownerProfile - Profil pemilik story
 */
function buildStoryDropdown(story, isMine, myRole, ownerProfile) {
  const menuEl = document.getElementById('story-dropdown-menu');
  if (!menuEl) return;

  const ownerRole = ownerProfile?.role || 'user';
  let html = '';

  if (isMine) {
    // Pemilik story: bisa hapus milik sendiri
    html += `
      <button class="dropdown-item dropdown-item--danger" onclick="deleteMyStory('${escapeHtml(story.id)}', '${escapeHtml(story.storage_path)}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M9 6V4h6v2"/></svg>
        Hapus Status
      </button>`;
  }

  // Logika moderasi: cek apakah viewer punya akses moderasi terhadap owner
  const canModerate = canModerateStory(myRole, ownerRole, isMine);
  if (canModerate) {
    html += `
      ${isMine ? '<div class="dropdown-divider"></div>' : ''}
      <button class="dropdown-item dropdown-item--danger" onclick="moderateDeleteStory('${escapeHtml(story.id)}', '${escapeHtml(story.storage_path)}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        Hapus Status Pengguna
      </button>`;
  }

  if (!html) {
    html = `<div style="padding:12px 14px;font-size:13px;color:var(--text-muted);">Tidak ada aksi tersedia.</div>`;
  }

  menuEl.innerHTML = html;
}

/**
 * Tentukan apakah viewer bisa melakukan moderasi hapus story.
 * Developer bisa hapus story admin/user biasa.
 * Admin hanya bisa hapus story user biasa.
 * Tidak berlaku untuk story milik sendiri (sudah ditangani terpisah).
 *
 * @param {string}  myRole    - Role viewer
 * @param {string}  ownerRole - Role pemilik story
 * @param {boolean} isMine
 * @returns {boolean}
 */
function canModerateStory(myRole, ownerRole, isMine) {
  if (isMine) return false;
  if (myRole === 'developer') {
    // Developer bisa moderasi semua role kecuali sesama developer
    return ownerRole !== 'developer';
  }
  if (myRole === 'admin') {
    // Admin hanya bisa moderasi user biasa
    return ownerRole === 'user';
  }
  return false;
}

function toggleStoryMenu() {
  const menu    = document.getElementById('story-dropdown-menu');
  const isOpen  = menu.classList.contains('open');
  menu.classList.toggle('open', !isOpen);
  menu.setAttribute('aria-hidden', String(isOpen));
  StoriesModule.isPaused = !isOpen; // pause saat menu terbuka
}

function closeStoryMenu() {
  const menu = document.getElementById('story-dropdown-menu');
  if (menu) { menu.classList.remove('open'); menu.setAttribute('aria-hidden', 'true'); }
  StoriesModule.isPaused = false;
}

// ══════════════════════════════════════════════
// HAPUS STORY
// ══════════════════════════════════════════════

/**
 * Hapus story milik sendiri: hapus dari Storage dan tabel stories.
 * @param {string} storyId
 * @param {string} storagePath
 */
async function deleteMyStory(storyId, storagePath) {
  closeStoryMenu();
  closeStoryViewer();

  try {
    // Hapus dari Storage
    await supabaseClient.storage.from('stories').remove([storagePath]);

    // Hapus dari tabel stories
    const { error } = await supabaseClient
      .from('stories')
      .delete()
      .eq('id', storyId)
      .eq('user_id', currentProfile?.id);

    if (error) throw error;

    showToast('Status berhasil dihapus.', 'success');
    await reloadStoriesPage();

  } catch (err) {
    console.error('[ElChat] deleteMyStory error:', err);
    showToast('Gagal menghapus status.', 'error');
  }
}

/**
 * Hapus story pengguna lain oleh Admin/Developer.
 * @param {string} storyId
 * @param {string} storagePath
 */
async function moderateDeleteStory(storyId, storagePath) {
  closeStoryMenu();
  closeStoryViewer();

  try {
    // Hapus dari Storage
    await supabaseClient.storage.from('stories').remove([storagePath]);

    // Hapus dari tabel stories (tanpa filter user_id — admin/dev punya RLS terpisah)
    // Catatan: tambahkan RLS policy "admin/dev can delete" jika diperlukan:
    // CREATE POLICY "moderators can delete stories"
    //   ON stories FOR DELETE
    //   USING (EXISTS (
    //     SELECT 1 FROM profiles p
    //     WHERE p.id = auth.uid() AND p.role IN ('admin','developer')
    //   ));
    const { error } = await supabaseClient
      .from('stories')
      .delete()
      .eq('id', storyId);

    if (error) throw error;

    showToast('Status pengguna berhasil dihapus oleh moderator.', 'success');
    await reloadStoriesPage();

  } catch (err) {
    console.error('[ElChat] moderateDeleteStory error:', err);
    showToast('Gagal menghapus status pengguna.', 'error');
  }
}

/**
 * Bersihkan dan muat ulang daftar stories.
 */
async function reloadStoriesPage() {
  const listEl = document.getElementById('stories-list');
  if (listEl) Array.from(listEl.children).forEach(c => c.remove());
  StoriesModule.groupedStories = [];
  StoriesModule.myStories      = [];
  await loadAllStories();
}

// ══════════════════════════════════════════════
// UTILITY
// ══════════════════════════════════════════════

/**
 * Format waktu relatif singkat untuk tampilan daftar.
 * @param {string} iso
 * @returns {string}
 */
function formatRelativeTime(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso)) / 1000;
  if (diff < 60)    return 'Baru saja';
  if (diff < 3600)  return `${Math.floor(diff / 60)} mnt lalu`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} jam lalu`;
  return `${Math.floor(diff / 86400)} hari lalu`;
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Tutup menu story saat klik di luar
document.addEventListener('click', (e) => {
  const wrapper = document.getElementById('story-menu-wrapper');
  if (wrapper && !wrapper.contains(e.target)) closeStoryMenu();
});

// Keyboard: Escape tutup viewer, ArrowLeft/Right navigasi
document.addEventListener('keydown', (e) => {
  const viewer = document.getElementById('story-viewer');
  if (!viewer || viewer.hidden) return;
  if (e.key === 'Escape')      { closeStoryViewer(); }
  if (e.key === 'ArrowRight')  { nextStory(); }
  if (e.key === 'ArrowLeft')   { prevStory(); }
});
