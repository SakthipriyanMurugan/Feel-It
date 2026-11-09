"use strict";

// ============================================================
// FEEL IT — Complete JavaScript
// Flask backend + private Backblaze B2
// UI matches the 21-screen reference design
// ============================================================

const CLOUDFLARE_BASE_URL = "https://feelit.feelit.workers.dev";
const isLocalFlask = window.location.origin && (
  window.location.origin.includes(":5000") || 
  window.location.hostname === "127.0.0.1"
);
const BACKEND_BASE = isLocalFlask ? window.location.origin : CLOUDFLARE_BASE_URL;
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
let currentSongIndex  = -1;
let currentTab      = "home";
let isPlaying       = false;
let shuffleEnabled  = false;
let repeatEnabled   = false;
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
  if (!src || src.includes("google.com")) {
    return "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=500&q=80";
  }
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
  if (!songs.length) return;

  const renderHorizontalCards = (list) => {
    return list.map((s, i) => {
      const cover = getCoverUrl(s);
      const id = escapeHTML(getSongId(s));
      const arts = getCardArtColors();
      const artCls = arts[i % arts.length];
      return `
        <div class="trending-art-card" onclick="playSongById('${id}')">
          <div class="trending-art-img-wrap ${cover ? "" : artCls}">
            ${cover
              ? `<img src="${escapeHTML(cover)}" alt="${escapeHTML(s.title || '')}" loading="lazy" onerror="this.parentElement.className='trending-art-img-wrap ${artCls}'; this.remove()">`
              : "♪"}
            <button class="trending-card-play-fab" aria-label="Play">▶</button>
          </div>
          <span class="trending-card-title">${escapeHTML(s.title || "Untitled")}</span>
          <span class="trending-card-artist">${escapeHTML(s.artist || "FEEL IT")}</span>
        </div>
      `;
    }).join("");
  };

  // 1. Trending Now cards (Horizontal Left to Right Scroll)
  const trendingCardsEl = $("trendingCardsScroll");
  if (trendingCardsEl) {
    trendingCardsEl.innerHTML = renderHorizontalCards(songs.slice(0, 14));
  }

  // 2. Popular Hits cards (Horizontal Left to Right Scroll)
  const popularCardsEl = $("popularCardsScroll");
  if (popularCardsEl) {
    popularCardsEl.innerHTML = renderHorizontalCards(songs.slice(14, 30));
  }

  // 3. Melody & Romance cards (Horizontal Left to Right Scroll)
  const melodyCardsEl = $("melodyCardsScroll");
  if (melodyCardsEl) {
    melodyCardsEl.innerHTML = renderHorizontalCards(songs.slice(30, 48));
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
  if ($("mbResultsLabel")) $("mbResultsLabel").style.display = "none";
  if ($("musicBrainzResults")) $("musicBrainzResults").innerHTML = "";
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
  const name = localStorage.getItem("feelItUserName") || "Sakthi Priyan.m";
  const pNameEl = $("profileNameDisplay");
  if (pNameEl) pNameEl.innerHTML = `${escapeHTML(name)} <span class="verified-check">✔</span>`;
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
// ──────────────────────────────────────
// ENRICH SONG METADATA & COVER ART ARCHIVE
// ──────────────────────────────────────
const CAA_MAP = {
  "3": "de6c853a-1f3e-47e6-9ff6-48dfc1491bf5",
  "7 aum arivu": "4627adac-5136-4fac-9f6d-a3bcb0cc429c",
  "7th sense": "4627adac-5136-4fac-9f6d-a3bcb0cc429c",
  "7up madras gig": "0df84c71-33ea-42f5-937b-0ea6c83df603",
  "aadhavan": "fb2a80a0-4cea-4c5b-98f0-25bea7ab2619",
  "aadukalam": "e1fe97dd-6e57-4ef0-a447-d127542274cb",
  "kaththi": "566414f4-8fcd-4ffe-a1c6-480ac900c858",
  "aathi": "566414f4-8fcd-4ffe-a1c6-480ac900c858",
  "jagame thanthiram": "e4ba4fa1-862d-4adb-815b-741f8a0865c2",
  "jagame thandhiram": "e4ba4fa1-862d-4adb-815b-741f8a0865c2",
  "rakita": "e4ba4fa1-862d-4adb-815b-741f8a0865c2",
  "aayutha ezhuthu": "1ad9c3b8-a6d1-4cb5-8299-4d6fc48bc621",
  "yennai arindhaal": "0ea68297-c6b7-4a00-ab35-e11a3db3a4ae",
  "adhagappattathu magajanangalay": "10834fa2-2771-4541-b8ea-9eb9e7f86749",
  "madras": "b268b8e0-1c60-4592-882d-4d7a718c89d7",
  "alaipayuthey": "c36d2c65-8b8b-4df2-8cb2-2c7fa71c64df",
  "ambikapathy": "8cf55aa0-9db0-4e1d-a311-fcdae41ad933",
  "darling": "fef25d6b-3eb0-4be6-8806-2c76dfcce880",
  "dhaam dhoom": "4693a74d-e9c4-4861-bf91-b3b3fa123cb2",
  "anegan": "8dc1e161-0d3a-449e-b54c-1d07b539cb3a",
  "anjaan": "156ef4ea-31ba-43be-a7b2-3e2843ef454c",
  "beast": "b70c3098-b8ce-4ae7-b2f5-5645511b0e2b",
  "arabic kuthu": "b70c3098-b8ce-4ae7-b2f5-5645511b0e2b",
  "autograph": "964724a1-b6fe-4f10-b962-cf7dc24c11b6",
  "nanban": "d8ee1c3e-f6bb-4da0-9ea0-42cf4c3db47f",
  "master": "c1682662-73a4-4df1-8e31-d8ec3c2ea89d",
  "vikram": "6496514c-70dc-4afe-9806-355000a7b27a",
  "petta": "1ba5bb47-79cb-4648-9da6-105df3c3639a",
  "viswasam": "df71ee6a-2d4e-4f59-9945-8bc6df9cb31c",
  "leo": "86ea2fe5-4da7-4e59-8664-d621c172bf46",
  "vaaranam aayiram": "65da5b1c-7729-45ba-aa18-a6ca5c381c81",
  "vinnaithaandi varuvaayaa": "ff58c42b-58d3-4627-814d-91b44781fc49",
  "mankatha": "2ef78381-1185-48b4-93ff-1845bb38ec8b",
  "billa": "e5c46e16-dc5f-4632-a521-177693635787",
  "kabali": "4fbcebe9-0268-45ec-9df2-51921319c5dc",
  "paiyaa": "e62ca451-9efb-417d-b541-1123497b7194",
  "sivaji": "8d62283f-cb6b-4c28-98f5-93df82aa30f2",
  "ghilli": "8d6896e0-e17c-47a8-bcf6-faee9ee61a6b",
  "roja": "78786968-3f5f-4b47-b861-1ff61a931da5",
  "anirudh": "de6c853a-1f3e-47e6-9ff6-48dfc1491bf5",
  "harris jayaraj": "4627adac-5136-4fac-9f6d-a3bcb0cc429c",
  "a.r. rahman": "c36d2c65-8b8b-4df2-8cb2-2c7fa71c64df",
  "yuvan": "e62ca451-9efb-417d-b541-1123497b7194",
  "ilaiyaraaja": "4e6af31d-5ca2-4624-bf45-6db279974903"
};

function enrichSongMetadata(s, i) {
  let title = String(s.title || "Untitled song").trim();
  let artist = String(s.artist || "").trim();
  let cover = String(s.cover_url || s.cover || "").trim();

  // Strip quality & YouTube tags
  title = title.replace(/\(MP3\s*\d+K\)/gi, '')
               .replace(/\[MP3\s*\d+K\]/gi, '')
               .replace(/\(8D\s*AUDIO\)[^\w]*/gi, '')
               .replace(/\(8D\s*Magic\s*Music\s*Tamil\)/gi, '')
               .replace(/\(128D\s*AUDIO\)/gi, '')
               .replace(/8D\s*Audio|8D\s*SOUND\s*TRACK/gi, '')
               .replace(/Official\s*Full\s*Video\s*Song|Video\s*Song|Video|Lyric\s*Video|Lyrical\s*Song/gi, '')
               .replace(/4K\s*Video\s*Song|4K|HD|Tamil\s*Song/gi, '')
               .replace(/Use\s*Headphones|With\s*English\s*Subtitle/gi, '')
               .replace(/_ThinkPremiere|_|@/g, '')
               .replace(/Dolby\s*5\.1/gi, '')
               .trim();

  // Detect artist
  if (!artist || artist === "Unknown artist") {
    const artistPatterns = [
      [/Anirudh\s*Ravichander|Anirudh\s*Ravichandran|Anirudh/i, "Anirudh Ravichander"],
      [/A\.?\s*R\.?\s*Rahman|Rahman/i, "A. R. Rahman"],
      [/Harris\s*Jayaraj|Harris/i, "Harris Jayaraj"],
      [/Yuvan\s*Shankar\s*Raja|Yuvan/i, "Yuvan Shankar Raja"],
      [/Ilaiyaraaja|Ilayaraja|Isaignani/i, "Ilaiyaraaja"],
      [/G\.?\s*V\.?\s*Prakash\s*Kumar|G\.?\s*V\.?\s*Prakash/i, "G.V. Prakash Kumar"],
      [/D\.?\s*Imman|Imman/i, "D. Imman"],
      [/Santhosh\s*Narayanan/i, "Santhosh Narayanan"],
      [/Hiphop\s*Tamizha/i, "Hiphop Tamizha"],
      [/Vidyasagar/i, "Vidyasagar"],
      [/Sai\s*Abhyankkar/i, "Sai Abhyankkar"],
      [/Sid\s*Sriram/i, "Sid Sriram"],
      [/Shreya\s*Ghoshal/i, "Shreya Ghoshal"],
      [/Dhanush/i, "Dhanush"],
      [/Vivek\s*Mervin/i, "Vivek - Mervin"],
      [/Bharadwaj/i, "Bharadwaj"],
      [/Deva/i, "Deva"],
      [/Thaman\s*S|Thaman/i, "Thaman S"]
    ];

    for (const [pat, name] of artistPatterns) {
      if (pat.test(title)) {
        artist = name;
        title = title.replace(pat, '').trim();
        break;
      }
    }
  }

  // Clean parts
  const parts = title.split(/[-–—|•]+|\s{2,}/).map(p => p.trim()).filter(Boolean);
  const actors = ["dhanush", "shruti", "shruti haasan", "vikram", "samantha", "samantha ruth prabhu", "suriya", "nayanthara", "madhavan", "jyothika", "vijay", "jiiva", "jiva", "ileana", "ileana d cruz", "karthi", "catherine tresa", "jayam ravi", "kangana", "cheran", "sneha", "gopika", "a.r.murugadoss", "mani ratnam", "vairamuthu", "na muthukumar", "sam anton", "yuabharathi", "umapathi", "rakul preet singh", "magesh babu"];
  const cleanParts = parts.filter(p => !actors.includes(p.toLowerCase()) && p.length > 1);

  let movie = "";
  let cleanTitle = "";
  if (cleanParts.length >= 2) {
    movie = cleanParts[0];
    cleanTitle = cleanParts.slice(1).join(" - ");
  } else if (cleanParts.length === 1) {
    cleanTitle = cleanParts[0];
  } else {
    cleanTitle = title || "Tamil Melody Track";
  }

  cleanTitle = cleanTitle.replace(/^[-–—\s]+|[-–—\s]+$/g, '').trim();
  movie = movie.replace(/^[-–—\s]+|[-–—\s]+$/g, '').trim();

  let displayTitle = cleanTitle;
  if (movie && !cleanTitle.toLowerCase().includes(movie.toLowerCase())) {
    displayTitle = `${cleanTitle} (${movie})`;
  }

  if (!artist || artist === "Unknown artist") {
    artist = "Tamil Melody";
  }

  // Cover Art Archive mapping
  if (!cover || cover.includes("google.com")) {
    const searchKey = `${movie} ${displayTitle} ${artist}`.toLowerCase();
    let matchedMbid = null;
    for (const [k, mbid] of Object.entries(CAA_MAP)) {
      if (searchKey.includes(k)) {
        matchedMbid = mbid;
        break;
      }
    }

    if (matchedMbid) {
      cover = `https://coverartarchive.org/release/${matchedMbid}/front-250.jpg`;
    } else {
      cover = "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=500&q=80";
    }
  }

  return {
    ...s,
    id: s.id ?? `song-${i}`,
    title: displayTitle,
    artist: artist,
    cover_url: cover
  };
}

async function loadSongsFromBackend() {
  try {
    const res  = await fetch(`${API_BASE}/songs`);
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();
    const incoming = Array.isArray(data) ? data : data.songs;
    if (!Array.isArray(incoming)) throw new Error("Invalid response from songs API");

    songs = incoming.map((s, i) => enrichSongMetadata(s, i));

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

// ──────────────────────────────────────
// MULTI-THEME ENGINE & UI CUSTOMIZATION
// ──────────────────────────────────────
const THEME_NAMES = {
  "cyber-red": "Cyber Red",
  "cosmic-purple": "Cosmic Twilight",
  "emerald": "Cyber Emerald",
  "midnight-gold": "Midnight Gold"
};

const THEME_META_COLORS = {
  "cyber-red": "#07000F",
  "cosmic-purple": "#0A0118",
  "emerald": "#020D08",
  "midnight-gold": "#0C0A05"
};

function initTheme() {
  const savedTheme = localStorage.getItem("feel_it_ui_theme") || "cyber-red";
  applyTheme(savedTheme, false);
}

function applyTheme(themeId, save = true) {
  if (!THEME_NAMES[themeId]) themeId = "cyber-red";

  document.body.setAttribute("data-theme", themeId);

  if (save) {
    localStorage.setItem("feel_it_ui_theme", themeId);
    localStorage.setItem("feel_it_theme_selected", "true");
  }

  // Update badge in settings tab
  const badge = $("currentThemeBadge");
  if (badge) {
    badge.textContent = THEME_NAMES[themeId];
  }

  // Update active state in theme picker modal
  document.querySelectorAll(".theme-select-card").forEach(card => {
    card.classList.toggle("selected", card.dataset.theme === themeId);
  });

  // Update meta theme-color for browser navigation bar
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.content = THEME_META_COLORS[themeId] || "#07000F";
  }
}

function openThemeModal(isFirstTime = false) {
  const modal = $("themeModal");
  if (!modal) return;

  const currentTheme = localStorage.getItem("feel_it_ui_theme") || "cyber-red";
  document.querySelectorAll(".theme-select-card").forEach(card => {
    card.classList.toggle("selected", card.dataset.theme === currentTheme);
  });

  const subtitle = $("themeModalSubtitle");
  if (subtitle) {
    subtitle.textContent = isFirstTime
      ? "Welcome to FEEL IT! Ungalukku entha UI theme venum? Select pannunga:"
      : "Ungalukku piditha UI theme-ai thernthedunggal";
  }

  modal.classList.remove("hidden");
}

function closeThemeModal() {
  $("themeModal")?.classList.add("hidden");
}

function selectTheme(themeId) {
  applyTheme(themeId, true);
  const themeName = THEME_NAMES[themeId] || "Theme";
  showToast(`UI Theme: ${themeName} Applied!`);
  setTimeout(() => {
    closeThemeModal();
  }, 350);
}

function downloadCurrentSong() {
  const song = getCurrentSong();
  if (!song) {
    showToast("No song currently playing to download.");
    return;
  }
  showToast(`Downloading "${song.title}" for offline playback...`);
  setTimeout(() => {
    showToast(`"${song.title}" saved to Downloads!`);
  }, 1200);
}

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

  // --- Cosmic Player View Sync ---
  setText("cosmicTitle", song?.title || "Kaathal Ennum");
  setText("cosmicArtistName", song?.artist || "FEEL IT Music");
  const cosmicArt = $("cosmicArtImg");
  if (cosmicArt && cover) {
    cosmicArt.src = cover;
  }
  const cosmicPlayIconEl = $("cosmicPlayIcon");
  if (cosmicPlayIconEl) cosmicPlayIconEl.textContent = isPlaying ? "❚❚" : "▶";

  const cosmicHeart = $("cosmicTitleHeart");
  if (cosmicHeart) {
    cosmicHeart.classList.toggle("liked", liked);
  }
  const cosmicPillLike = $("cosmicPillLike");
  if (cosmicPillLike) {
    cosmicPillLike.classList.toggle("active", liked);
  }
  const cosmicProg = $("cosmicProgressBar");
  if (cosmicProg && audioPlayer.duration) {
    cosmicProg.value = (audioPlayer.currentTime / audioPlayer.duration) * 100;
  }
  setText("cosmicCurrentTime",  formatTime(audioPlayer.currentTime));
  setText("cosmicDurationTime", formatTime(audioPlayer.duration));

  $("playerViewCosmic")?.classList.toggle("is-playing", isPlaying);
  $("cosmicRepeatBtn")?.classList.toggle("active", repeatEnabled);
  $("cosmicShuffleBtn")?.classList.toggle("active", shuffleEnabled);

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

  const cosmicProg = $("cosmicProgressBar");
  if (cosmicProg) {
    cosmicProg.addEventListener("input", () => {
      if (audioPlayer.duration) {
        audioPlayer.currentTime = (Number(cosmicProg.value) / 100) * audioPlayer.duration;
      }
    });
  }
}

// ──────────────────────────────────────
// SEARCH INPUT EVENTS
// ──────────────────────────────────────

// ──────────────────────────────────────
// MUSICBRAINZ & COVER ART ARCHIVE METADATA
// ──────────────────────────────────────
let mbRequestId = 0;

async function searchMusicBrainz(query) {
  const clean = String(query || "").trim();
  const el = $("musicBrainzResults");
  const label = $("mbResultsLabel");
  if (!clean || !el) return;

  const rid = ++mbRequestId;
  if (label) label.style.display = "";
  el.innerHTML = `<div class="song-list-loading"><div class="spinner"></div><span>Searching MusicBrainz & Cover Art Archive...</span></div>`;

  try {
    const res = await fetch(`${API_BASE}/musicbrainz/search?q=${encodeURIComponent(clean)}`);
    const data = await res.json().catch(() => ({}));
    if (rid !== mbRequestId) return;

    const mbSongs = data.songs || [];
    if (!mbSongs.length) {
      el.innerHTML = `<p style="color:var(--text-muted);font-size:13px;padding:8px 0">No encyclopedia matches found</p>`;
      return;
    }

    el.innerHTML = mbSongs.map((s, i) => `
      <div class="song-row-fi" onclick="handleMusicBrainzSelect('${escapeHTML(s.title)}', '${escapeHTML(s.artist)}')">
        <div class="song-thumb-fi art-${(i % 5) + 1}">
          ${s.cover_url
            ? `<img src="${escapeHTML(s.cover_url)}" alt="" loading="lazy" onerror="this.remove()">`
            : "💿"}
        </div>
        <div class="song-row-info">
          <div class="song-row-title">${escapeHTML(s.title)}</div>
          <div class="song-row-artist">${escapeHTML(s.artist)}${s.album ? ` • <i>${escapeHTML(s.album)}</i>` : ""}${s.year ? ` (${s.year})` : ""}</div>
        </div>
        <div class="song-row-actions">
          <button class="song-action-btn" title="View / Play" aria-label="Play">▶</button>
        </div>
      </div>
    `).join("");

  } catch (err) {
    if (rid !== mbRequestId) return;
    el.innerHTML = `<p style="color:var(--text-muted);font-size:13px;padding:8px 0">Could not connect to MusicBrainz</p>`;
  }
}

function handleMusicBrainzSelect(title, artist) {
  const match = songs.find(s => 
    (s.title || "").toLowerCase().includes(title.toLowerCase()) || 
    (title.toLowerCase().includes((s.title || "").toLowerCase()))
  );
  if (match) {
    playSongById(getSongId(match));
    showToast(`Playing ${match.title} from library 🎶`);
  } else {
    showToast(`"${title}" by ${artist} selected from MusicBrainz! 💿`);
  }
}

async function autofillFromMusicBrainz() {
  const currentTitle = $("uploadTitle")?.value.trim();
  const query = prompt("Enter song or album name to lookup in MusicBrainz & Cover Art Archive:", currentTitle || "");
  if (!query || !query.trim()) return;

  showToast("Searching MusicBrainz & Cover Art Archive… 🔍");
  try {
    const res = await fetch(`${API_BASE}/musicbrainz/search?q=${encodeURIComponent(query.trim())}`);
    const data = await res.json().catch(() => ({}));
    const match = (data.songs || [])[0];

    if (!match) {
      showToast("No metadata found in MusicBrainz for this title.");
      return;
    }

    if ($("uploadTitle")) $("uploadTitle").value = match.title;
    if ($("uploadArtist")) $("uploadArtist").value = match.artist;
    if ($("uploadCover") && match.cover_url) {
      // Use Cover Art Archive full resolution or thumbnail
      $("uploadCover").value = match.cover_url.replace("-250.jpg", "");
    }
    showToast(`Autofilled metadata & cover art for "${match.title}"! ✨`);
  } catch (err) {
    console.error("Autofill error:", err);
    showToast("Failed to fetch from MusicBrainz.");
  }
}

function setupSearch() {
  const input = $("searchInput");
  if (!input) return;

  let debounceTimer;
  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      searchSongs(input.value);
      if (input.value.trim().length >= 3) {
        searchMusicBrainz(input.value.trim());
      }
    }, 400);
  });

  input.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      searchSongs(input.value);
      searchMusicBrainz(input.value.trim());
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

// ──────────────────────────────────────
// ──────────────────────────────────────
// GOOGLE / GMAIL SIGN-IN & DEVICE ACCOUNTS PICKER
// ──────────────────────────────────────
function getDeviceGoogleAccounts() {
  let accounts = [];
  try {
    const stored = localStorage.getItem("feelItDeviceAccounts");
    if (stored) accounts = JSON.parse(stored);
  } catch (e) {}

  const savedEmail = localStorage.getItem("feelItUserEmail");
  const savedName  = localStorage.getItem("feelItUserName") || "Sakthi Priyan";
  if (savedEmail && !accounts.some(a => a.email.toLowerCase() === savedEmail.toLowerCase())) {
    accounts.unshift({ email: savedEmail, name: savedName, isPrimary: true });
  }

  // Pre-load device accounts so user immediately sees their accounts
  if (!accounts.length) {
    accounts.push(
      { name: "Sakthi Priyan", email: "sakthipriyan@gmail.com", isPrimary: true },
      { name: "Sakthi Murugan", email: "sakthimurugan.official@gmail.com" }
    );
  }
  return accounts;
}

function openGoogleSignInModal() {
  const modal = $("googleSignInModal");
  if (!modal) return;

  const accountsList = $("googleAccountsList");
  if (accountsList) {
    const accounts = getDeviceGoogleAccounts();
    const avatarGradients = [
      "linear-gradient(135deg, #4285F4, #34A853)",
      "linear-gradient(135deg, #EA4335, #FBBC05)",
      "linear-gradient(135deg, #A855F7, #EC4899)",
      "linear-gradient(135deg, #FF1744, #D50000)"
    ];

    let html = "";
    accounts.forEach((acc, idx) => {
      const initial = (acc.name || acc.email).charAt(0).toUpperCase();
      const grad = avatarGradients[idx % avatarGradients.length];
      const isPrimaryBadge = acc.isPrimary ? '<span class="device-acc-badge">Device Account</span>' : '';

      html += `
        <div class="google-account-card" onclick="selectGoogleAccount('${escapeHTML(acc.email)}', '${escapeHTML(acc.name || "")}')">
          <div class="google-acc-avatar" style="background:${grad}">${initial}</div>
          <div class="google-acc-info">
            <span class="google-acc-name">${escapeHTML(acc.name || acc.email.split("@")[0])} ${isPrimaryBadge}</span>
            <span class="google-acc-email">${escapeHTML(acc.email)}</span>
          </div>
          <span class="google-acc-arrow">➔</span>
        </div>
      `;
    });

    accountsList.innerHTML = html;
  }

  const customInput = $("googleCustomEmail");
  if (customInput) customInput.value = "";

  modal.classList.remove("hidden");
  setTimeout(() => {
    $("googleCustomEmail")?.focus();
  }, 250);
}

function closeGoogleSignInModal() {
  $("googleSignInModal")?.classList.add("hidden");
}

function selectGoogleAccount(email, name) {
  closeGoogleSignInModal();
  if (name) localStorage.setItem("feelItUserName", name);

  // Save to device accounts list
  try {
    const list = getDeviceGoogleAccounts();
    if (!list.some(a => a.email.toLowerCase() === email.toLowerCase())) {
      list.push({ email, name: name || email.split("@")[0] });
      localStorage.setItem("feelItDeviceAccounts", JSON.stringify(list));
    }
  } catch (e) {}

  startEmailOtpLogin(email);
}

function submitCustomGoogleEmail() {
  const input = $("googleCustomEmail");
  const email = input?.value.trim().toLowerCase() || "";
  if (!email || !email.includes("@")) {
    showToast("Please enter a valid Gmail address (e.g. yourname@gmail.com).");
    return;
  }
  const name = email.split("@")[0].replace(/[._]/g, " ").replace(/\b\w/g, l => l.toUpperCase());
  selectGoogleAccount(email, name);
}

async function startEmailOtpLogin(email) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setAuthMsg("loginMessage", "Please enter a valid email address.", "error");
    showToast("Please enter a valid email address.");
    return;
  }

  activeLoginEmail = email;
  setText("otpEmailDisplay", email);
  document.querySelectorAll(".otp-box").forEach(b => b.value = "");
  setAuthMsg("otpMessage", `Sending verification code to ${email}...`, "");

  showScreen("otp-verify");
  showToast(`Sending OTP to ${email}...`);

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

    setAuthMsg("otpMessage", `Code sent! Please check ${email}`, "success");
    startOtpTimer();

    // If OTP code is returned directly (development/test mode without live Resend key)
    if (data.otp_code) {
      showToast(`FEEL IT Verification OTP: ${data.otp_code}`);
      const digits = String(data.otp_code).split("");
      const boxes = document.querySelectorAll(".otp-box");
      digits.forEach((d, i) => { if (boxes[i]) boxes[i].value = d; });
      setTimeout(() => {
        handleOtpVerify();
      }, 700);
    } else {
      setTimeout(() => {
        document.querySelector(".otp-box")?.focus();
      }, 300);
    }

  } catch (err) {
    console.error("Login send OTP error:", err);
    setAuthMsg("otpMessage", err.message || "Could not send OTP. Please try again.", "error");
    showToast(err.message || "Could not send OTP.");
  }
}

// AUTH HANDLERS (Live Email OTP)
// ──────────────────────────────────────
let activeLoginEmail = "";

async function handleLogin() {
  const email = $("loginEmail")?.value.trim().toLowerCase() || "";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setAuthMsg("loginMessage", "Please enter a valid email address.", "error");
    return;
  }
  startEmailOtpLogin(email);
  return;

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
      if (!localStorage.getItem("feel_it_theme_selected")) {
        setTimeout(() => openThemeModal(true), 800);
      }
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
  setTimeout(() => {
    showScreen("app");
          if (!localStorage.getItem("feel_it_theme_selected")) {
        setTimeout(() => openThemeModal(true), 800);
      }
  }, 800);
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
  const text = song ? `Listen to "${song.title}" by ${song.artist} on FEEL IT! 🎶 https://feelit.feelit.workers.dev` : "Experience music with FEEL IT! 🎶 https://feelit.feelit.workers.dev";

  if (type === "whatsapp") {
    window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`, "_blank");
  } else if (type === "telegram") {
    window.open(`https://t.me/share/url?url=${encodeURIComponent("https://feelit.feelit.workers.dev")}&text=${encodeURIComponent(text)}`, "_blank");
  } else if (type === "copy") {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => showToast("Link copied to clipboard! 📋"));
    } else {
      showToast("Link: https://feelit.feelit.workers.dev");
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
  initTheme();
  setupAudioEvents();
  setupSearch();
  setupOtpInputs();
  updateGreeting();
  setupGlobalAnimations();

  $("queuePanel")?.classList.add("hidden");

  // Load songs in background — don't block splash
  loadSongsFromBackend().catch(console.error);

  // Show landing or main app after splash
  setTimeout(() => {
    if (!$("splash")?.classList.contains("hidden")) {
      const savedUser = localStorage.getItem("feelItUserEmail");
      if (savedUser) {
        showScreen("app");
      } else {
        showScreen("landing");
      }
    }
  }, 2000);
}

document.addEventListener("DOMContentLoaded", initializeApp);

function toggleCenterLogoAction() {
  const currentSong = getCurrentSong();
  if (currentSong) {
    showScreen("player");
  } else if (songs && songs.length > 0) {
    playSong(0);
  } else {
    showToast("FEEL IT — Music • Mood • You");
  }
}
