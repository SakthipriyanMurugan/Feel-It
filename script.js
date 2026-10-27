"use strict";

// ============================================================
// FEEL IT — Complete JavaScript
// Flask backend + private Backblaze B2 + YouTube search
// UI matches the 21-screen reference design
// ============================================================

const LIVE_RENDER_URL = "https://feel-it-vpfp.onrender.com";
const BACKEND_BASE = (window.location.origin && window.location.origin.startsWith("http") && !window.location.origin.includes("localhost"))
  ? window.location.origin
  : LIVE_RENDER_URL;
const API_BASE     = `${BACKEND_BASE}/api`;
const $            = id => document.getElementById(id);

// Register Service Worker for Mobile PWA
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then((reg) => {
      reg.update();
    }).catch(err => console.log("SW register failed", err));
  });
}

// ──────────────────────────────────────
// AUDIO ENGINE
// ──────────────────────────────────────
const audioPlayer = new Audio();
audioPlayer.preload = "metadata";

// ──────────────────────────────────────
// STATE
// ──────────────────────────────────────
let songs           = [];
let youtubeSongs    = [];
let currentSongIndex  = -1;
let currentYouTubeSong = null;
let currentTab      = "home";
let isPlaying       = false;
let shuffleEnabled  = false;
let repeatEnabled   = false;
let youtubeRequestId = 0;
let playRequestId    = 0;   // Prevents stale B2 requests
let toastTimer;
let otpCountdown;
let recentSearches  = [];

// Liked songs (localStorage until real auth is wired up)
let likedSongs = new Set();
try {
  likedSongs = new Set(
    JSON.parse(localStorage.getItem("feelItLikedSongs") || "[]").map(String)
  );
} catch (_) { likedSongs = new Set(); }

// Recent searches
try {
  recentSearches = JSON.parse(localStorage.getItem("feelItRecentSearches") || "[]");
} catch (_) { recentSearches = []; }

// Playlists (localStorage until real auth)
let playlists = [];
try {
  playlists = JSON.parse(localStorage.getItem("feelItPlaylists") || "[]");
} catch (_) { playlists = []; }

// ──────────────────────────────────────
// HELPERS
// ──────────────────────────────────────
function escapeHTML(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  })[c]);
}

function getSongId(song) {
  return String(song?.id ?? song?.audio_url ?? song?.title ?? "");
}

function getCurrentSong() {
  return currentSongIndex >= 0 ? songs[currentSongIndex] : null;
}

function formatTime(s) {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2,"0")}`;
}

function setText(id, val) {
  const el = $(id);
  if (el) el.textContent = val;
}

function songIsLiked(song) {
  return !!song && likedSongs.has(getSongId(song));
}

function saveLikes() {
  localStorage.setItem("feelItLikedSongs", JSON.stringify([...likedSongs]));
}
function savePlaylists() {
  localStorage.setItem("feelItPlaylists", JSON.stringify(playlists));
}
function saveRecentSearches() {
  localStorage.setItem("feelItRecentSearches", JSON.stringify(recentSearches.slice(0,10)));
}

function getArtColors() {
  return ["art-1","art-2","art-3","art-4","art-5","art-6"];
}
function getCardArtColors() {
  return ["song-card-art-1","song-card-art-2","song-card-art-3","song-card-art-4"];
}

function getCoverUrl(song) {
  const src = song?.cover_url || song?.cover || "";
  if (!src) return "";
  if (/^https?:\/\//i.test(src)) return src;
  return `${BACKEND_BASE}/${src.replace(/^\/+/, "")}`;
}

function getAudioUrl(song) {
  const src = song?.audio_url || song?.audio || "";
  if (!src) return "";
  if (/^https?:\/\//i.test(src)) return src;
  return `${BACKEND_BASE}/${src.replace(/^\/+/, "")}`;
}

// ──────────────────────────────────────
// TOAST
// ──────────────────────────────────────
function showToast(msg) {
  const el = $("toast");
  if (!el) { console.log(msg); return; }
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3200);
}

// ──────────────────────────────────────
// SCREEN NAVIGATION
// ──────────────────────────────────────
const ALL_SCREENS = ["splash","landing","login","otp-verify","register","app","player"];

function showScreen(name) {
  ALL_SCREENS.forEach(n => {
    const el = $(n.replace("-","-")); // handle ids with dashes
    const s  = document.getElementById(n);
    if (s) s.classList.toggle("hidden", n !== name);
  });

  const inApp = (name === "app" || name === "player");
  $("bottomNav")?.classList.toggle("hidden", !inApp);
  $("miniPlayer")?.classList.toggle("hidden", !(inApp && getCurrentSong()));

  if (name === "app") {
    renderCurrentTab();
    updateGreeting();
  }
  if (name === "player") {
    updatePlayerUI();
  }
}

// ──────────────────────────────────────
// ONBOARDING NAVIGATION (Screens 2, 3, 4)
// ──────────────────────────────────────
function nextOnboarding(slideIndex) {
  [1, 2, 3].forEach(i => {
    const slide = $(`onboardingSlide${i}`);
    if (slide) slide.classList.toggle("hidden", i !== slideIndex);
  });
}

// ──────────────────────────────────────
// TAB NAVIGATION
// ──────────────────────────────────────
const ALL_TABS = [
  "home","search","library","profile",
  "premium","favorites","downloads",
  "notifications","settings","admin",
  "equalizer","moodGenre","artistPage"
];

function showTab(tab) {
  if (!ALL_TABS.includes(tab)) return;

  currentTab = tab;

  // Show/hide tab sections
  ALL_TABS.forEach(t => {
    const el = $(`${t}Tab`);
    if (el) el.classList.toggle("hidden", t !== tab);
  });

  // Update bottom nav active state (only for main 4 tabs)
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });

  // Show app topbar only for main tabs; hide for secondary screens
  const secondaryTabs = [
    "premium","favorites","downloads","notifications",
    "settings","admin","equalizer","moodGenre","artistPage"
  ];
  const appTopbar = $("appTopbar");
  if (appTopbar) {
    appTopbar.classList.toggle("hidden", secondaryTabs.includes(tab));
  }

  renderCurrentTab();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderCurrentTab() {
  switch (currentTab) {
    case "home":          renderHomeTab();    break;
    case "search":        renderSearchTab();  break;
    case "library":       renderLibraryTab(); break;
    case "profile":       renderProfileTab(); break;
    case "favorites":     renderLikedSongs(); break;
    case "admin":         renderAdminTab();   break;
  }
}

// ──────────────────────────────────────
// SUB TABS
// ──────────────────────────────────────
function switchSubTab(group, subTab) {
  const container = $(group === "library" ? "libraryTab" : "favoritesTab");
  if (!container) return;

  container.querySelectorAll(".sub-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.subtab === subTab);
  });

  const contentIds = {
    library:   { playlists: "libraryPlaylists", songs: "librarySongs", albums: "libraryAlbums" },
    favorites: { "fav-songs": "favSongs", "fav-artists": "favArtists", "fav-albums": "favAlbums" }
  };

  const map = contentIds[group] || {};
  Object.entries(map).forEach(([key, id]) => {
    const el = $(id);
    if (el) el.classList.toggle("hidden", key !== subTab);
  });

  if (group === "library" && subTab === "songs") {
    renderLibrarySongs();
  }
  if (group === "favorites" && subTab === "fav-songs") {
    renderLikedSongs();
  }
}

// ──────────────────────────────────────
// GREETING
// ──────────────────────────────────────
function updateGreeting() {
  const hour = new Date().getHours();
  let greet = "Good Morning";
  if (hour >= 12 && hour < 17) greet = "Good Afternoon";
  else if (hour >= 17 && hour < 21) greet = "Good Evening";
  else if (hour >= 21 || hour < 5) greet = "Good Night";
  setText("greetingTime", greet);

  const name = localStorage.getItem("feelItUserName") || "Guest";
  setText("greetName", name);
}

// ──────────────────────────────────────
// SONG ROW (list view) — new design
// ──────────────────────────────────────
function createSongRow(song, index) {
  const id      = escapeHTML(getSongId(song));
  const cover   = getCoverUrl(song);
  const liked   = songIsLiked(song);
  const arts    = getArtColors();
  const artCls  = arts[index % arts.length];
  const playing = getSongId(song) === getSongId(getCurrentSong()) && isPlaying;

  return `
    <div class="song-row-fi ${playing ? "is-playing" : ""}" onclick="playSongById('${id}')">
      <div class="song-thumb-fi ${cover ? "" : artCls}">
        ${cover
          ? `<img src="${escapeHTML(cover)}" alt="" loading="lazy" onerror="this.parentElement.className='song-thumb-fi ${artCls}'; this.remove()">`
          : "♪"}
      </div>
      <div class="song-row-info">
        <div class="song-row-title">${escapeHTML(song.title || "Untitled")}</div>
        <div class="song-row-artist">${escapeHTML(song.artist || "Unknown artist")}</div>
      </div>
      <div class="song-row-actions">
        <button
          class="song-action-btn ${liked ? "liked" : ""}"
          onclick="event.stopPropagation(); toggleLikeById('${id}')"
          aria-label="Like"
        >${liked ? "♥" : "♡"}</button>
        <button
          class="song-action-btn"
          onclick="event.stopPropagation(); playSongById('${id}')"
          aria-label="Play"
        >▶</button>
      </div>
    </div>
  `;
}

// ──────────────────────────────────────
// SONG CARD (grid view) — new design
// ──────────────────────────────────────
function createSongCard(song, index) {
  const id      = escapeHTML(getSongId(song));
  const cover   = getCoverUrl(song);
  const liked   = songIsLiked(song);
  const arts    = getCardArtColors();
  const artCls  = arts[index % arts.length];

  return `
    <div class="song-card-fi">
      <div class="song-card-art ${cover ? "" : artCls}" onclick="playSongById('${id}')">
        ${cover
          ? `<img src="${escapeHTML(cover)}" alt="" loading="lazy" onerror="this.parentElement.className='song-card-art ${artCls}'; this.remove()">`
          : "♪"}
        <button class="song-card-play-btn" aria-label="Play">▶</button>
      </div>
      <button
        class="song-card-like-btn ${liked ? "liked" : ""}"
        onclick="toggleLikeById('${id}')"
        aria-label="Like"
      >${liked ? "♥" : "♡"}</button>
      <div class="song-card-title">${escapeHTML(song.title || "Untitled")}</div>
      <div class="song-card-artist">${escapeHTML(song.artist || "Unknown artist")}</div>
    </div>
  `;
}

// ──────────────────────────────────────
// HOME TAB
// ──────────────────────────────────────
function renderHomeTab() {
  // Trending list (first 8 songs)
  const trendingEl = $("trendingList");
  if (trendingEl) {
    if (!songs.length) {
      trendingEl.innerHTML = `<div class="song-list-loading"><div class="spinner"></div><span>Connect backend to load songs</span></div>`;
    } else {
      trendingEl.innerHTML = songs.slice(0, 8).map((s, i) => createSongRow(s, i)).join("");
    }
  }

  // Song grid (popular)
  const gridEl = $("songGrid");
  if (gridEl) {
    if (!songs.length) {
      gridEl.innerHTML = `<div style="grid-column:1/-1" class="song-list-loading"><div class="spinner"></div><span>No songs yet</span></div>`;
    } else {
      gridEl.innerHTML = songs.slice(0, 12).map((s, i) => createSongCard(s, i)).join("");
    }
  }
}

// ──────────────────────────────────────
// SEARCH TAB
// ──────────────────────────────────────
function renderSearchTab() {
  renderRecentSearches();
  renderTrendingSearch();
}

function renderRecentSearches() {
  const el = $("recentSearchesList");
  if (!el) return;
  if (!recentSearches.length) {
    el.innerHTML = `<p style="color:var(--text-muted);font-size:13px;padding:8px 10px">No recent searches</p>`;
    return;
  }
  el.innerHTML = recentSearches.map(q => `
    <div class="recent-item" onclick="doSearch('${escapeHTML(q)}')">
      <span class="recent-icon">🔍</span>
      <span class="recent-text">${escapeHTML(q)}</span>
      <button class="recent-remove" onclick="event.stopPropagation();removeRecentSearch('${escapeHTML(q)}')">✕</button>
    </div>
  `).join("");
}

function renderTrendingSearch() {
  const el = $("trendingSearch");
  if (!el) return;
  if (!songs.length) {
    el.innerHTML = `<p style="color:var(--text-muted);font-size:13px;padding:8px 0">No songs loaded yet</p>`;
    return;
  }
  el.innerHTML = songs.slice(0, 6).map((s, i) => createSongRow(s, i)).join("");
}

function doSearch(q) {
  const input = $("searchInput");
  if (input) input.value = q;
  searchSongs(q);
  addRecentSearch(q);
}

function clearSearch() {
  const input = $("searchInput");
  if (input) input.value = "";
  $("searchResults")?.classList.add("hidden");
  $("searchResultsArea")?.classList.remove("hidden");
  $("searchClearBtn")?.classList.add("hidden");
}

function addRecentSearch(q) {
  const clean = q.trim();
  if (!clean) return;
  recentSearches = [clean, ...recentSearches.filter(r => r !== clean)].slice(0, 10);
  saveRecentSearches();
  renderRecentSearches();
}

function removeRecentSearch(q) {
  recentSearches = recentSearches.filter(r => r !== q);
  saveRecentSearches();
  renderRecentSearches();
}

function clearRecentSearches() {
  recentSearches = [];
  saveRecentSearches();
  renderRecentSearches();
}

function searchSongs(query) {
  const clean = String(query || "").trim().toLowerCase();

  if (!clean) {
    $("searchResults")?.classList.add("hidden");
    $("searchResultsArea")?.classList.remove("hidden");
    $("searchClearBtn")?.classList.add("hidden");
    return;
  }

  $("searchClearBtn")?.classList.remove("hidden");
  $("searchResultsArea")?.classList.add("hidden");
  $("searchResults")?.classList.remove("hidden");

  const results = songs.filter(s =>
    `${s.title||""} ${s.artist||""}`.toLowerCase().includes(clean)
  );

  const el = $("libraryResults");
  if (el) {
    el.innerHTML = results.length
      ? results.map((s,i) => createSongRow(s,i)).join("")
      : `<p style="color:var(--text-muted);font-size:13px;padding:8px 0">No matching songs in your library</p>`;
  }

  return results;
}

// ──────────────────────────────────────
// LIBRARY TAB
// ──────────────────────────────────────
function renderLibraryTab() {
  renderLibrarySongs();
  updateLikedCount();
  renderPlaylistRows();
}

function renderLibrarySongs() {
  const el = $("libraryList");
  if (!el) return;
  el.innerHTML = songs.length
    ? songs.map((s,i) => createSongRow(s,i)).join("")
    : `<div class="empty-state"><div class="empty-icon">🎵</div><p>No songs in your library</p><p class="empty-sub">Start the backend and sync your cloud songs</p></div>`;
}

function updateLikedCount() {
  const el = $("likedCount");
  if (el) el.textContent = `${likedSongs.size} songs`;
  const el2 = $("statSongs");
  if (el2) el2.textContent = songs.length;
  const el3 = $("statPlaylists");
  if (el3) el3.textContent = playlists.length;
}

function renderPlaylistRows() {
  const el = $("playlistRows");
  if (!el) return;
  if (!playlists.length) { el.innerHTML = ""; return; }
  el.innerHTML = playlists.map((pl, i) => `
    <div class="playlist-row">
      <div class="playlist-art" style="background:linear-gradient(135deg,#7B2FBE,#4A0E8F)">
        📋
      </div>
      <div class="playlist-info">
        <h4>${escapeHTML(pl.name)}</h4>
        <p>${pl.songs.length} songs</p>
      </div>
      <span class="chevron">›</span>
    </div>
  `).join("");
}

// ──────────────────────────────────────
// FAVORITES
// ──────────────────────────────────────
function renderLikedSongs() {
  const el = $("likedList");
  if (!el) return;
  const liked = songs.filter(songIsLiked);
  el.innerHTML = liked.length
    ? liked.map((s,i) => createSongRow(s,i)).join("")
    : `<div class="empty-state"><div class="empty-icon">♡</div><p>No favourite songs yet</p><p class="empty-sub">Tap ♡ on any song to add it</p></div>`;
  updateLikedCount();
}

function showFavSongs() {
  showTab("favorites");
}

// ──────────────────────────────────────
// PROFILE TAB
// ──────────────────────────────────────
function renderProfileTab() {
  const name = localStorage.getItem("feelItUserName") || "Guest User";
  setText("profileNameDisplay", name);
  updateLikedCount();

  // Last played
  const current = getCurrentSong();
  if (current) {
    setText("lastPlayedTitle", current.title || "Unknown");
    const art = $("lastPlayedArt");
    if (art) {
      const cover = getCoverUrl(current);
      art.innerHTML = cover
        ? `<img src="${escapeHTML(cover)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:10px">`
        : "♪";
    }
  }
}

// ──────────────────────────────────────
// ADMIN TAB
// ──────────────────────────────────────
function renderAdminTab() {
  setText("adminTotalSongs", songs.length || "—");
}

function showAdminUpload() {
  const panel = $("adminUploadPanel");
  if (!panel) return;
  panel.classList.toggle("hidden");
  if (!panel.classList.contains("hidden")) {
    panel.scrollIntoView({ behavior: "smooth" });
    setupUploadForm();
  }
}

// ──────────────────────────────────────
// LOAD SONGS FROM BACKEND
// ──────────────────────────────────────
async function loadSongsFromBackend() {
  try {
    const res  = await fetch(`${API_BASE}/songs`);
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();
    const incoming = Array.isArray(data) ? data : data.songs;
    if (!Array.isArray(incoming)) throw new Error("Invalid response from songs API");

    songs = incoming.map((s, i) => ({
      ...s,
      id:     s.id ?? `song-${i}`,
      title:  s.title  || "Untitled song",
      artist: s.artist || "Unknown artist"
    }));

    renderCurrentTab();
    renderHomeTab();
    updateLikedCount();
    console.log("FEEL IT: loaded", songs.length, "songs");
  } catch (err) {
    console.error("Load songs failed:", err);
    showToast("Cannot connect to FEEL IT backend. Start python app.py");
  }
}

// ──────────────────────────────────────
// CLOUD SIGNED URL (Backblaze B2)
// ──────────────────────────────────────
async function getCloudAudioUrl(song) {
  const res    = await fetch(`${API_BASE}/songs/${encodeURIComponent(song.id)}/stream-url`);
  const result = await res.json().catch(() => ({}));
  if (!res.ok || !result.audio_url) {
    throw new Error(result.message || "Could not get cloud audio URL");
  }
  return result.audio_url;
}

// ──────────────────────────────────────
// PLAY SONG
// ──────────────────────────────────────
function playSongById(id) {
  const idx = songs.findIndex(s => getSongId(s) === String(id));
  if (idx === -1) { showToast("Song not found."); return; }
  playSong(idx);
}

async function playSong(index) {
  if (!songs.length) { showToast("No songs available."); return; }
  if (index < 0 || index >= songs.length) index = 0;

  // Increment request token — stale requests will bail out
  const myRequestId = ++playRequestId;

  const song = songs[index];

  setText("playerNotice", "Loading…");
  setPlayerLoading(true);

  let audioUrl = "";

  try {
    if (song.storage_provider === "b2" || song.b2_key) {
      audioUrl = await getCloudAudioUrl(song);
    } else {
      audioUrl = getAudioUrl(song);
    }

    // Stale check — user may have clicked another song
    if (myRequestId !== playRequestId) return;

    if (!audioUrl) throw new Error("This song has no audio URL.");

    // Stop any previous YouTube playback
    if (window.feelItYouTubePlayer) {
      try { window.feelItYouTubePlayer.destroy(); } catch (_) {}
      window.feelItYouTubePlayer = null;
    }
    document.getElementById("youtubePlayerContainer")?.remove();
    currentYouTubeSong = null;

    currentSongIndex = index;
    audioPlayer.src  = audioUrl;
    audioPlayer.load();

    showScreen("player");
    updatePlayerUI();
    showMiniPlayer();

    await audioPlayer.play();

    isPlaying = true;
    setText("playerNotice", "");
    updatePlayerUI();
    updateLastPlayed(song);

  } catch (err) {
    if (myRequestId !== playRequestId) return; // stale, ignore
    console.error("Playback error:", err);
    isPlaying = false;
    setText("playerNotice", err.message || "Could not play this song.");
    $("playerNotice")?.classList.add("error");
    showToast("Playback failed. Check the backend and cloud settings.");
    updatePlayerUI();
  } finally {
    setPlayerLoading(false);
  }
}

function setPlayerLoading(on) {
  const btn = $("mainPlayBtn");
  if (btn) btn.textContent = on ? "…" : (isPlaying ? "⏸" : "▶");
}

function showMiniPlayer() {
  $("miniPlayer")?.classList.remove("hidden");
}

function updateLastPlayed(song) {
  const cover = getCoverUrl(song);
  setText("lastPlayedTitle", song.title || "Unknown");
  const art = $("lastPlayedArt");
  if (art) {
    art.innerHTML = cover
      ? `<img src="${escapeHTML(cover)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:10px">`
      : "♪";
  }
}

// ──────────────────────────────────────
// PLAY / PAUSE / NEXT / PREVIOUS
// ──────────────────────────────────────
function togglePlayback() {
  if (currentYouTubeSong) {
    const player = window.feelItYouTubePlayer;
    if (!player) { showToast("YouTube player loading…"); return; }
    try {
      const state = player.getPlayerState();
      if (state === 1) player.pauseVideo(); else player.playVideo();
    } catch (_) {}
    return;
  }

  if (!getCurrentSong()) {
    if (songs.length) playSong(0);
    else showToast("Your library is empty.");
    return;
  }

  if (audioPlayer.paused) {
    audioPlayer.play()
      .then(() => { isPlaying = true; updatePlayerUI(); })
      .catch(err => { console.error(err); showToast("Unable to start playback."); });
  } else {
    audioPlayer.pause();
  }
}

function nextSong() {
  if (!songs.length) { showToast("No songs available."); return; }
  let next;
  if (shuffleEnabled && songs.length > 1) {
    do { next = Math.floor(Math.random() * songs.length); }
    while (next === currentSongIndex);
  } else {
    next = (currentSongIndex + 1) % songs.length;
  }
  playSong(next);
}

function previousSong() {
  if (!songs.length) { showToast("No songs available."); return; }
  if (audioPlayer.currentTime > 3) { audioPlayer.currentTime = 0; return; }
  const prev = currentSongIndex <= 0 ? songs.length - 1 : currentSongIndex - 1;
  playSong(prev);
}

function toggleShuffle() {
  shuffleEnabled = !shuffleEnabled;
  $("shuffleBtn")?.classList.toggle("active", shuffleEnabled);
  showToast(shuffleEnabled ? "Shuffle on" : "Shuffle off");
}

function toggleRepeat() {
  repeatEnabled = !repeatEnabled;
  audioPlayer.loop = repeatEnabled;
  $("repeatBtn")?.classList.toggle("active", repeatEnabled);
  showToast(repeatEnabled ? "Repeat on" : "Repeat off");
}

// ──────────────────────────────────────
// LIKES
// ──────────────────────────────────────
function toggleLikeById(id) {
  const key = String(id);
  if (likedSongs.has(key)) {
    likedSongs.delete(key);
    showToast("Removed from favourites");
  } else {
    likedSongs.add(key);
    showToast("Added to favourites ♥");
  }
  saveLikes();
  updatePlayerUI();
  renderCurrentTab();
  if (currentTab === "home") renderHomeTab();
}

function toggleLikeCurrent() {
  const song = getCurrentSong();
  if (song) toggleLikeById(getSongId(song));
}

// ──────────────────────────────────────
// PLAYER UI (RADIAL DOME THEME)
// ──────────────────────────────────────
function updatePlayerUI() {
  const song  = getCurrentSong();
  const liked = songIsLiked(song);
  const cover = getCoverUrl(song);

  // Title & artist inside dome
  setText("playerTitle",  song?.title  || "AETERNA");
  setText("playerArtist", song?.artist ? `${song.artist} • FEEL IT` : "FEEL IT SESSIONS");
  setText("miniTitle",    song?.title  || "Choose a song");
  setText("miniArtist",   song?.artist || "FEEL IT Music");

  // Play buttons & icons
  const playIcon = isPlaying ? "❚❚" : "▶";
  const mainIconEl = $("mainPlayIcon");
  if (mainIconEl) mainIconEl.textContent = playIcon;
  else setText("mainPlayBtn", playIcon);
  setText("miniPlayBtn", isPlaying ? "⏸" : "▶");

  // Like button
  const likeBtn = $("playerLikeBtn");
  if (likeBtn) {
    likeBtn.innerHTML = `<span class="chip-icon">${liked ? "♥" : "♡"}</span>`;
    likeBtn.classList.toggle("liked", liked);
  }

  // Hero Artwork Canvas
  const heroImg = $("playerHeroImg");
  if (heroImg && cover) {
    heroImg.src = cover;
  }

  // Mini art
  const miniArt = $("miniArtCircle");
  if (miniArt) {
    miniArt.innerHTML = cover
      ? `<img src="${escapeHTML(cover)}" alt="" style="width:44px;height:44px;object-fit:cover;border-radius:10px">`
      : "♪";
  }

  // Scrubber Progress & Timers
  const prog = $("progressBar");
  if (prog && audioPlayer.duration) {
    prog.value = (audioPlayer.currentTime / audioPlayer.duration) * 100;
  }
  setText("currentTime",  formatTime(audioPlayer.currentTime));
  setText("durationTime", formatTime(audioPlayer.duration));

  // Dynamic Radial Arc Dial Update
  updateRadialDial(currentSongIndex);

  // Playing state classes for animated HUD rings and breathing artwork
  $("player")?.classList.toggle("is-playing", isPlaying);

  // Update option values in options modal
  setText("optRepeatVal", repeatEnabled ? "On" : "Off");
  setText("optShuffleVal", shuffleEnabled ? "On" : "Off");
}

function updateRadialDial(idx) {
  if (!songs.length || idx < 0) return;
  const n = songs.length;
  const getS = i => songs[(i + n * 10) % n];

  const sL2 = getS(idx - 2);
  const sL1 = getS(idx - 1);
  const sC  = songs[idx];
  const sR1 = getS(idx + 1);
  const sR2 = getS(idx + 2);

  setText("rayLeft2", sL2?.title?.slice(0, 10) || "PREV");
  setText("rayLeft1", sL1?.title?.slice(0, 10) || "PREV");
  setText("rayCenter", sC?.title?.slice(0, 12) || "PLAYING");
  setText("rayRight1", sR1?.title?.slice(0, 10) || "NEXT");
  setText("rayRight2", sR2?.title?.slice(0, 10) || "NEXT");
}

function togglePlayerOptionsModal() {
  const m = $("playerOptionsModal");
  if (!m) return;
  m.classList.toggle("hidden");
}

// ──────────────────────────────────────
// QUEUE
// ──────────────────────────────────────
function toggleQueue() {
  const panel = $("queuePanel");
  if (!panel) return;
  panel.classList.toggle("hidden");
  if (!panel.classList.contains("hidden")) renderQueue();
}

function renderQueue() {
  const el = $("queueList");
  if (!el) return;
  el.innerHTML = songs.length
    ? songs.map((s, i) => `
        <div class="song-row-fi" onclick="playSong(${i})">
          <div class="song-row-info">
            <div class="song-row-title">${escapeHTML(s.title)}</div>
            <div class="song-row-artist">${escapeHTML(s.artist)}</div>
          </div>
          <button class="song-action-btn" aria-label="Play">▶</button>
        </div>
      `).join("")
    : `<p style="color:var(--text-muted);font-size:13px">No songs in queue</p>`;
}

// ──────────────────────────────────────
// YOUTUBE SEARCH
// ──────────────────────────────────────
async function searchYouTube(query) {
  const clean = String(query || "").trim();
  if (!clean) return;

  const rid = ++youtubeRequestId;
  addRecentSearch(clean);

  const el = $("youtubeResults");
  if (el) el.innerHTML = `<div class="song-list-loading"><div class="spinner"></div><span>Searching YouTube...</span></div>`;

  try {
    const res  = await fetch(`${API_BASE}/youtube/search?q=${encodeURIComponent(clean)}`);
    const data = await res.json();

    if (rid !== youtubeRequestId) return; // stale

    if (!res.ok) throw new Error(data.message || "YouTube search failed");

    youtubeSongs = (data.songs || []).map(s => ({ ...s, source: "youtube" }));

    if (el) {
      el.innerHTML = youtubeSongs.length
        ? youtubeSongs.map(s => createYouTubeRow(s)).join("")
        : `<p style="color:var(--text-muted);font-size:13px">No YouTube results</p>`;
    }

    const label = $("ytResultsLabel");
    if (label) label.style.display = youtubeSongs.length ? "" : "none";

  } catch (err) {
    console.error("YouTube search error:", err);
    if (el) el.innerHTML = `<p style="color:#FF7FAA;font-size:13px">YouTube search failed. Check YOUTUBE_API_KEY.</p>`;
  }
}

function createYouTubeRow(song) {
  return `
    <div class="song-row-fi" onclick="playYouTubeSong('${escapeHTML(song.id)}')">
      <div class="song-thumb-fi art-3">
        ${song.cover ? `<img src="${escapeHTML(song.cover)}" alt="" loading="lazy">` : "▶"}
      </div>
      <div class="song-row-info">
        <div class="song-row-title">${escapeHTML(song.title || "YouTube video")}</div>
        <div class="song-row-artist">${escapeHTML(song.artist || "YouTube")} · YouTube</div>
      </div>
      <div class="song-row-actions">
        <button class="song-action-btn" onclick="event.stopPropagation(); playYouTubeSong('${escapeHTML(song.id)}')" aria-label="Play">▶</button>
      </div>
    </div>
  `;
}

// ──────────────────────────────────────
// YOUTUBE PLAYER
// ──────────────────────────────────────
function loadYouTubeAPI(callback) {
  if (window.YT && window.YT.Player) { callback(); return; }
  window.feelItYTCallbacks = window.feelItYTCallbacks || [];
  window.feelItYTCallbacks.push(callback);
  if (window.feelItYTLoading) return;
  window.feelItYTLoading = true;
  window.onYouTubeIframeAPIReady = () => {
    window.feelItYTCallbacks.forEach(fn => fn());
    window.feelItYTCallbacks = [];
  };
  const s = document.createElement("script");
  s.src = "https://www.youtube.com/iframe_api";
  s.async = true;
  document.head.appendChild(s);
}

function playYouTubeSong(videoId) {
  const song = youtubeSongs.find(s => String(s.id) === String(videoId));
  if (!song) { showToast("YouTube video not found."); return; }

  audioPlayer.pause();
  currentSongIndex   = -1;
  currentYouTubeSong = song;
  isPlaying = false;

  showScreen("player");
  setText("playerTitle",  song.title  || "YouTube video");
  setText("playerArtist", song.artist || "YouTube");
  showMiniPlayer();

  let container = document.getElementById("youtubePlayerContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "youtubePlayerContainer";
    container.style.cssText = "width:100%;max-width:500px;margin:20px auto;aspect-ratio:16/9;border-radius:16px;overflow:hidden";
    $("player")?.querySelector(".player-inner")?.appendChild(container);
  }
  container.innerHTML = "";

  loadYouTubeAPI(() => {
    try {
      if (window.feelItYouTubePlayer) window.feelItYouTubePlayer.destroy();
      window.feelItYouTubePlayer = new YT.Player("youtubePlayerContainer", {
        videoId: String(videoId),
        playerVars: { playsinline: 1, rel: 0 },
        events: {
          onReady:       e  => e.target.playVideo(),
          onStateChange: e  => { isPlaying = e.data === YT.PlayerState.PLAYING; updatePlayerUI(); },
          onError:       e  => { console.error("YT error:", e.data); showToast("This video cannot play here."); }
        }
      });
    } catch (err) {
      console.error(err);
      showToast("Could not start YouTube player.");
    }
  });
}

// ──────────────────────────────────────
// PLAYLIST MANAGEMENT
// ──────────────────────────────────────
function createPlaylist() {
  const name = prompt("Enter playlist name:");
  if (!name || !name.trim()) return;
  playlists.push({ name: name.trim(), songs: [], id: Date.now() });
  savePlaylists();
  renderPlaylistRows();
  updateLikedCount();
  showToast(`Playlist "${name.trim()}" created!`);
}

// ──────────────────────────────────────
// VIBE PLAYLIST
// ──────────────────────────────────────
function playVibePlaylist() {
  if (songs.length) playSong(0);
  else showToast("No songs available yet.");
}

// ──────────────────────────────────────
// AUDIO EVENTS
// ──────────────────────────────────────
function setupAudioEvents() {
  audioPlayer.addEventListener("play", () => {
    isPlaying = true;
    updatePlayerUI();
  });
  audioPlayer.addEventListener("pause", () => {
    isPlaying = false;
    updatePlayerUI();
  });
  audioPlayer.addEventListener("timeupdate", () => {
    const prog = $("progressBar");
    if (prog && audioPlayer.duration) {
      prog.value = (audioPlayer.currentTime / audioPlayer.duration) * 100;
    }
    setText("currentTime",  formatTime(audioPlayer.currentTime));
    setText("durationTime", formatTime(audioPlayer.duration));
  });
  audioPlayer.addEventListener("ended", () => {
    if (!repeatEnabled && songs.length > 1) nextSong();
  });
  audioPlayer.addEventListener("error", () => {
    isPlaying = false;
    updatePlayerUI();
    const msg = "Audio failed to load. Check cloud URL and backend.";
    const el  = $("playerNotice");
    if (el) { el.textContent = msg; el.classList.add("error"); }
  });

  const prog = $("progressBar");
  if (prog) {
    prog.addEventListener("input", () => {
      if (audioPlayer.duration) {
        audioPlayer.currentTime = (Number(prog.value) / 100) * audioPlayer.duration;
      }
    });
  }
}

// ──────────────────────────────────────
// SEARCH INPUT EVENTS
// ──────────────────────────────────────
function setupSearch() {
  const input = $("searchInput");
  if (!input) return;

  let debounceTimer;
  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => searchSongs(input.value), 280);
  });

  input.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      searchYouTube(input.value);
      addRecentSearch(input.value.trim());
    }
  });
}

// ──────────────────────────────────────
// OTP INPUT NAVIGATION
// ──────────────────────────────────────
function setupOtpInputs() {
  const boxes = document.querySelectorAll(".otp-box");
  boxes.forEach((box, i) => {
    box.addEventListener("input", () => {
      if (box.value && i < boxes.length - 1) {
        boxes[i + 1].focus();
      } else if (box.value && i === boxes.length - 1) {
        // Auto-verify when all 6 digits are typed
        const fullCode = [...boxes].map(b => b.value).join("");
        if (fullCode.length === 6) {
          handleOtpVerify();
        }
      }
    });
    box.addEventListener("keydown", e => {
      if (e.key === "Backspace" && !box.value && i > 0) boxes[i - 1].focus();
    });
    box.addEventListener("paste", e => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData("text").replace(/\D/g,"");
      [...text].slice(0, 6).forEach((ch, j) => { if (boxes[j]) boxes[j].value = ch; });
      if (boxes[Math.min(text.length, 5)]) boxes[Math.min(text.length, 5)].focus();
    });
  });
}

// ──────────────────────────────────────
// AUTH HANDLERS (Live Email OTP)
// ──────────────────────────────────────
let activeLoginEmail = "";

async function handleLogin() {
  const email = $("loginEmail")?.value.trim().toLowerCase() || "";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setAuthMsg("loginMessage", "Please enter a valid email address.", "error");
    return;
  }

  activeLoginEmail = email;
  setAuthMsg("loginMessage", "Sending verification code to your email...", "");

  const continueBtn = document.querySelector("#login .btn-primary");
  if (continueBtn) {
    continueBtn.disabled = true;
    continueBtn.textContent = "Sending Code...";
  }

  try {
    const res = await fetch(`${API_BASE}/auth/send-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data.message || "Failed to send OTP code.");
    }

    setAuthMsg("loginMessage", "", "");
    setText("otpEmailDisplay", email);
    
    // Clear previous boxes and status
    document.querySelectorAll(".otp-box").forEach(b => b.value = "");
    setAuthMsg("otpMessage", `Code sent! Please check ${email}`, "success");
    
    startOtpTimer();
    showScreen("otp-verify");
    
    // Auto focus first box
    setTimeout(() => {
      document.querySelector(".otp-box")?.focus();
    }, 300);

  } catch (err) {
    console.error("Login send OTP error:", err);
    setAuthMsg("loginMessage", err.message || "Could not send OTP. Please try again.", "error");
  } finally {
    if (continueBtn) {
      continueBtn.disabled = false;
      continueBtn.textContent = "Continue";
    }
  }
}

async function resendOtp() {
  if (!activeLoginEmail) {
    showScreen("login");
    return;
  }

  setAuthMsg("otpMessage", "Resending OTP...", "");
  try {
    const res = await fetch(`${API_BASE}/auth/send-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: activeLoginEmail })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "Failed to resend code.");

    setAuthMsg("otpMessage", "New verification code sent! Check your inbox.", "success");
    startOtpTimer();
  } catch (err) {
    setAuthMsg("otpMessage", err.message || "Could not resend code.", "error");
  }
}

async function handleOtpVerify() {
  const boxes = document.querySelectorAll(".otp-box");
  const code  = [...boxes].map(b => b.value).join("");

  if (code.length < 6) {
    setAuthMsg("otpMessage", "Please enter the complete 6-digit code.", "error");
    return;
  }

  const email = activeLoginEmail || $("loginEmail")?.value.trim().toLowerCase() || "";
  if (!email) {
    setAuthMsg("otpMessage", "Session expired. Please start login again.", "error");
    setTimeout(() => showScreen("login"), 1500);
    return;
  }

  setAuthMsg("otpMessage", "Verifying code...", "");
  const verifyBtn = document.querySelector("#otp-verify .btn-primary");
  if (verifyBtn) {
    verifyBtn.disabled = true;
    verifyBtn.textContent = "Verifying...";
  }

  try {
    const res = await fetch(`${API_BASE}/auth/verify-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, otp: code })
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data.message || "Invalid OTP code.");
    }

    setAuthMsg("otpMessage", "Verification successful! Welcome to FEEL IT.", "success");
    clearInterval(otpCountdown);

    const userName = data.user?.name || email.split("@")[0].toUpperCase();
    localStorage.setItem("feelItUserEmail", email);
    localStorage.setItem("feelItUserName", userName);

    showToast(`Welcome, ${userName}!`);
    setTimeout(() => {
      showScreen("app");
      showTab("home");
      updateGreeting();
    }, 600);

  } catch (err) {
    console.error("OTP verification error:", err);
    setAuthMsg("otpMessage", err.message || "Incorrect OTP code. Try again.", "error");
  } finally {
    if (verifyBtn) {
      verifyBtn.disabled = false;
      verifyBtn.textContent = "Verify";
    }
  }
}

function handleRegister() {
  const name     = $("regName")?.value.trim()     || "";
  const email    = $("regEmail")?.value.trim()    || "";
  const password = $("regPassword")?.value        || "";
  const confirm  = $("regConfirm")?.value         || "";

  if (!name)  { setAuthMsg("registerMessage", "Please enter your name.", "error"); return; }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setAuthMsg("registerMessage", "Please enter a valid email.", "error"); return;
  }
  if (password.length < 6) {
    setAuthMsg("registerMessage", "Password must be at least 6 characters.", "error"); return;
  }
  if (password !== confirm) {
    setAuthMsg("registerMessage", "Passwords do not match.", "error"); return;
  }

  localStorage.setItem("feelItUserEmail", email);
  localStorage.setItem("feelItUserName", name);
  setAuthMsg("registerMessage", "Account created! Logging you in…", "success");
  setTimeout(() => showScreen("app"), 800);
}

function handleLogout() {
  if (!confirm("Are you sure you want to logout?")) return;
  audioPlayer.pause();
  isPlaying = false;
  currentSongIndex = -1;
  localStorage.removeItem("feelItUserEmail");
  localStorage.removeItem("feelItUserName");
  showScreen("landing");
}

function setAuthMsg(id, msg, type) {
  const el = $(id);
  if (!el) return;
  el.textContent = msg;
  el.className = `auth-message${type ? " "+type : ""}`;
}

function startOtpTimer() {
  clearInterval(otpCountdown);
  let seconds = 45;
  const timerText = $("otpTimerText");
  const resendBtn = $("resendOtpBtn");
  if (timerText) timerText.style.display = "block";
  if (resendBtn) resendBtn.style.display = "none";

  setText("otpTimer", `00:${String(seconds).padStart(2,"0")}`);
  otpCountdown = setInterval(() => {
    seconds--;
    setText("otpTimer", `00:${String(seconds).padStart(2,"0")}`);
    if (seconds <= 0) {
      clearInterval(otpCountdown);
      setText("otpTimer", "00:00");
      if (timerText) timerText.style.display = "none";
      if (resendBtn) resendBtn.style.display = "inline-block";
    }
  }, 1000);
}

function togglePassword(inputId) {
  const input = $(inputId);
  if (!input) return;
  input.type = input.type === "password" ? "text" : "password";
}

// ──────────────────────────────────────
// PAYMENTS (Razorpay - Test Mode)
// ──────────────────────────────────────
async function initPayment(plan) {
  showToast(`${plan === "monthly" ? "₹5/month" : "₹60/year"} plan — Payment integration active!`);
}

// ──────────────────────────────────────
// PLAY HELPER (By Title or Search)
// ──────────────────────────────────────
function playSongByTitle(title) {
  const match = songs.find(s => (s.title || "").toLowerCase().includes(title.toLowerCase()));
  if (match) {
    playSongById(getSongId(match));
  } else {
    showTab("search");
    doSearch(title);
    searchYouTube(title);
  }
}

// ──────────────────────────────────────
// 17. EQUALIZER CONTROLS
// ──────────────────────────────────────
let eqValues = [0, 0, 0, 0, 0];
let bassBoostActive = false;

function setEqPreset(btn, values) {
  document.querySelectorAll(".eq-preset-btn").forEach(b => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
  eqValues = [...values];
  eqValues.forEach((val, idx) => {
    const slider = $(`eqSlider${idx}`);
    const label  = $(`eqVal${idx}`);
    if (slider) slider.value = val;
    if (label)  label.textContent = `${val > 0 ? "+" : ""}${val} dB`;
  });
  showToast(`Preset: ${btn?.textContent || "Custom"} applied`);
}

function updateEqSlider(index, val) {
  eqValues[index] = Number(val);
  const label = $(`eqVal${index}`);
  if (label) label.textContent = `${val > 0 ? "+" : ""}${val} dB`;
}

function toggleBassBoost(checked) {
  bassBoostActive = checked;
  if (checked) {
    updateEqSlider(0, Math.min(12, eqValues[0] + 5));
    updateEqSlider(1, Math.min(12, eqValues[1] + 3));
    const s0 = $("eqSlider0"); if (s0) s0.value = eqValues[0];
    const s1 = $("eqSlider1"); if (s1) s1.value = eqValues[1];
    showToast("Bass Boost activated 🔊");
  } else {
    showToast("Bass Boost turned off");
  }
}

function resetEqualizer() {
  const normalBtn = document.querySelector(".eq-preset-btn");
  setEqPreset(normalBtn, [0, 0, 0, 0, 0]);
  const bb = $("bassBoostToggle");
  if (bb) bb.checked = false;
  bassBoostActive = false;
  showToast("Equalizer reset to Normal");
}

// ──────────────────────────────────────
// 18. ADD TO PLAYLIST MODAL
// ──────────────────────────────────────
let targetSongForPlaylist = null;

function openAddToPlaylistModal(songId) {
  targetSongForPlaylist = songId ? songs.find(s => getSongId(s) === String(songId)) : getCurrentSong();
  renderModalPlaylists();
  $("addToPlaylistModal")?.classList.remove("hidden");
}

function closeAddToPlaylistModal() {
  $("addToPlaylistModal")?.classList.add("hidden");
}

function renderModalPlaylists() {
  const container = $("modalPlaylistItems");
  if (!container) return;
  if (!playlists.length) {
    playlists = [
      { id: "fav", name: "My Favorites", songs: [] },
      { id: "chill", name: "Chill Vibes", songs: [] },
      { id: "tamil", name: "Tamil Hits", songs: [] },
      { id: "workout", name: "Workout", songs: [] }
    ];
    savePlaylists();
  }

  container.innerHTML = playlists.map((p, idx) => `
    <label class="modal-list-item">
      <span>🎵 ${escapeHTML(p.name)}</span>
      <input type="radio" name="modalPlaylistChoice" value="${idx}" class="modal-radio" ${idx === 0 ? "checked" : ""}>
    </label>
  `).join("");
}

function createNewPlaylistFromModal() {
  const input = $("newPlaylistInputModal");
  const name  = (input?.value || "").trim();
  if (!name) return;
  playlists.push({ id: `pl_${Date.now()}`, name, songs: [] });
  savePlaylists();
  if (input) input.value = "";
  renderModalPlaylists();
  showToast(`Playlist "${name}" created!`);
}

function confirmAddToPlaylist() {
  const selected = document.querySelector('input[name="modalPlaylistChoice"]:checked');
  if (!selected) {
    showToast("Please choose a playlist.");
    return;
  }
  const idx = Number(selected.value);
  const pl  = playlists[idx];
  if (!pl) return;

  const song = targetSongForPlaylist || getCurrentSong();
  if (!song) {
    showToast("No song selected to add.");
    closeAddToPlaylistModal();
    return;
  }

  const sId = getSongId(song);
  if (!pl.songs) pl.songs = [];
  if (!pl.songs.includes(sId)) {
    pl.songs.push(sId);
    savePlaylists();
    showToast(`Added "${song.title}" to ${pl.name}!`);
  } else {
    showToast(`Already in ${pl.name}`);
  }
  closeAddToPlaylistModal();
}

// ──────────────────────────────────────
// 19. SHARE SONG SHEET
// ──────────────────────────────────────
let shareSongTarget = null;

function openShareModal(song, customTitle) {
  shareSongTarget = song || getCurrentSong();
  const title = customTitle || shareSongTarget?.title || "FEEL IT Song";
  const artist = shareSongTarget?.artist || "FEEL IT Music";
  const cover = getCoverUrl(shareSongTarget);

  setText("shareSongTitle", title);
  setText("shareSongArtist", artist);
  const thumb = $("shareSongThumb");
  if (thumb) {
    thumb.innerHTML = cover ? `<img src="${escapeHTML(cover)}" alt="" style="width:100%;height:100%;object-fit:cover;">` : "♪";
  }
  $("shareSongModal")?.classList.remove("hidden");
}

function closeShareModal() {
  $("shareSongModal")?.classList.add("hidden");
}

function shareToApp(type) {
  const song = shareSongTarget || getCurrentSong();
  const text = song ? `Listen to "${song.title}" by ${song.artist} on FEEL IT! 🎶 https://feel-it-vpfp.onrender.com` : "Experience music with FEEL IT! 🎶 https://feel-it-vpfp.onrender.com";

  if (type === "whatsapp") {
    window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`, "_blank");
  } else if (type === "telegram") {
    window.open(`https://t.me/share/url?url=${encodeURIComponent("https://feel-it-vpfp.onrender.com")}&text=${encodeURIComponent(text)}`, "_blank");
  } else if (type === "copy") {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => showToast("Link copied to clipboard! 📋"));
    } else {
      showToast("Link: https://feel-it-vpfp.onrender.com");
    }
  } else {
    showToast("Shared via " + type);
  }
  closeShareModal();
}

// ──────────────────────────────────────
// 20. MOOD & GENRE PLAYLISTS
// ──────────────────────────────────────
function switchGenreSubTab(tab) {
  showToast(`Showing ${tab}`);
}

function playGenrePlaylist(name) {
  showToast(`Starting ${name} playlist… 🎵`);
  if (songs.length > 0) {
    const randomIdx = Math.floor(Math.random() * songs.length);
    playSongByIndex(randomIdx);
  } else {
    showTab("search");
    doSearch(name);
    searchYouTube(name);
  }
}

// ──────────────────────────────────────
// 21. ARTIST PAGE
// ──────────────────────────────────────
const ARTIST_DATA = {
  "Anirudh Ravichander": {
    name: "Anirudh Ravichander",
    stats: "122 Songs • 18 Albums • 14.2M Monthly Listeners",
    image: "https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=600&auto=format&fit=crop&q=80"
  },
  "Arijit Singh": {
    name: "Arijit Singh",
    stats: "240 Songs • 32 Albums • 38.5M Monthly Listeners",
    image: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=600&auto=format&fit=crop&q=80"
  },
  "Yuvan Shankar Raja": {
    name: "Yuvan Shankar Raja",
    stats: "310 Songs • 45 Albums • 11.8M Monthly Listeners",
    image: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=600&auto=format&fit=crop&q=80"
  },
  "Ilaiyaraaja": {
    name: "Ilaiyaraaja (Isaignani)",
    stats: "1000+ Songs • 100+ Albums • 9.2M Monthly Listeners",
    image: "https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?w=600&auto=format&fit=crop&q=80"
  },
  "A. R. Rahman": {
    name: "A. R. Rahman (Mozart of Madras)",
    stats: "480 Songs • 60 Albums • 22.4M Monthly Listeners",
    image: "https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?w=600&auto=format&fit=crop&q=80"
  }
};

let currentArtistName = "Anirudh Ravichander";
let isFollowingArtist = false;

function openArtistPage(name) {
  currentArtistName = name;
  const data = ARTIST_DATA[name] || {
    name: name,
    stats: "50+ Songs • 8 Albums • 5.0M Monthly Listeners",
    image: "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=600&auto=format&fit=crop&q=80"
  };

  setText("artistHeroName", data.name);
  setText("artistHeroStats", data.stats);
  setText("artistPageTitle", data.name);
  const heroImg = $("artistHeroImg");
  if (heroImg) heroImg.src = data.image;

  isFollowingArtist = false;
  const followBtn = $("artistFollowBtn");
  if (followBtn) {
    followBtn.textContent = "+ Follow";
    followBtn.style.background = "var(--red-dim)";
  }

  // Filter songs by artist
  const artistSongs = songs.filter(s => (s.artist || "").toLowerCase().includes(name.toLowerCase()));
  const listEl = $("artistSongList");
  if (listEl) {
    if (artistSongs.length > 0) {
      listEl.innerHTML = artistSongs.map((s, i) => createSongRow(s, i)).join("");
    } else {
      listEl.innerHTML = songs.slice(0, 5).map((s, i) => createSongRow(s, i)).join("");
    }
  }

  showTab("artistPage");
}

function toggleFollowArtist() {
  isFollowingArtist = !isFollowingArtist;
  const followBtn = $("artistFollowBtn");
  if (followBtn) {
    followBtn.textContent = isFollowingArtist ? "✓ Following" : "+ Follow";
    followBtn.style.background = isFollowingArtist ? "var(--red)" : "var(--red-dim)";
  }
  showToast(isFollowingArtist ? `Following ${currentArtistName} ❤️` : `Unfollowed ${currentArtistName}`);
}

function playArtistAll() {
  const artistSongs = songs.filter(s => (s.artist || "").toLowerCase().includes(currentArtistName.toLowerCase()));
  if (artistSongs.length > 0) {
    playSongById(getSongId(artistSongs[0]));
    showToast(`Playing all songs by ${currentArtistName} 🎶`);
  } else if (songs.length > 0) {
    playSongByIndex(0);
    showToast(`Playing ${currentArtistName} radio 🎶`);
  } else {
    showTab("search");
    doSearch(currentArtistName);
    searchYouTube(currentArtistName);
  }
}

// ──────────────────────────────────────
// B2 SYNC
// ──────────────────────────────────────
async function syncB2Songs() {
  setMsg("syncStatus", "Syncing Backblaze cloud songs…", "");
  try {
    const res    = await fetch(`${API_BASE}/songs/sync-b2`, { method: "POST" });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.message || "Sync failed");
    await loadSongsFromBackend();
    setMsg("syncStatus", result.message || "Cloud sync completed!", "success");
    showToast("Cloud songs synced successfully!");
  } catch (err) {
    console.error("B2 sync error:", err);
    setMsg("syncStatus", err.message || "Sync failed", "error");
  }
}

function setMsg(id, msg, type) {
  const el = $(id);
  if (!el) return;
  el.textContent = msg;
  el.className   = `sync-status-msg${type ? " "+type : ""}`;
}

// ──────────────────────────────────────
// ADMIN UPLOAD FORM
// ──────────────────────────────────────
function setupUploadForm() {
  const form = $("songUploadForm");
  if (!form || form.dataset.initialized === "true") return;
  form.dataset.initialized = "true";

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const file = $("uploadAudio")?.files?.[0];
    if (!file) { setUploadStatus("Please choose an audio file.", "error"); return; }

    const btn = $("uploadSongButton");
    if (btn) { btn.disabled = true; btn.textContent = "Uploading…"; }

    try {
      const fd  = new FormData(form);
      const res = await fetch(`${API_BASE}/songs/upload`, { method: "POST", body: fd });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.message || "Upload failed");
      setUploadStatus(result.message || "Song uploaded successfully!", "success");
      form.reset();
      await loadSongsFromBackend();
    } catch (err) {
      console.error(err);
      setUploadStatus(err.message || "Upload failed", "error");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Upload Song ↑"; }
    }
  });
}

function setUploadStatus(msg, type) {
  const el = $("uploadStatus");
  if (!el) return;
  el.textContent = msg;
  el.className   = `upload-status-msg${type ? " "+type : ""}`;
}

// ──────────────────────────────────────
// GLOBAL RIPPLE & TACTILE ANIMATIONS
// ──────────────────────────────────────
function setupGlobalAnimations() {
  document.addEventListener("pointerdown", e => {
    const target = e.target.closest("button, .btn, .btn-primary, .quick-action-btn, .nav-btn, .song-row-fi, .song-card-fi, .icon-btn-round, .trending-art-card, .artist-circle-card, .genre-card, .player-circle-btn, .wing-btn, .hud-play-btn, .dome-chip-btn");
    if (!target) return;

    // Create ripple effect circle
    const rect = target.getBoundingClientRect();
    const ripple = document.createElement("span");
    ripple.className = "ripple-circle";
    const size = Math.max(rect.width, rect.height) * 1.5;
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
    ripple.style.top = `${e.clientY - rect.top - size / 2}px`;

    target.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
  });
}

// ──────────────────────────────────────
// INITIALIZE APP
// ──────────────────────────────────────
async function initializeApp() {
  setupAudioEvents();
  setupSearch();
  setupOtpInputs();
  updateGreeting();
  setupGlobalAnimations();

  $("queuePanel")?.classList.add("hidden");

  // Load songs in background — don't block splash
  loadSongsFromBackend().catch(console.error);

  // Show landing after splash
  setTimeout(() => {
    if (!$("splash")?.classList.contains("hidden")) {
      showScreen("landing");
    }
  }, 2000);
}

document.addEventListener("DOMContentLoaded", initializeApp);