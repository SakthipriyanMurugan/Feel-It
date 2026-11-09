// ──────────────────────────────────────
// ANDROID / SYSTEM BACK BUTTON NAVIGATION (Step-by-step history)
// ──────────────────────────────────────
let tabHistory = ["home"];
let currentScreen = "app";
let lastExitBackPress = 0;

window.handleAndroidBackButton = function() {
  // 1. Close any visible modal overlay
  const modals = [
    $("playerOptionsModal"),
    $("addToPlaylistModal"),
    $("shareSongModal"),
    $("themeModal"),
    $("googleSignInModal")
  ];
  for (const m of modals) {
    if (m && !m.classList.contains("hidden")) {
      m.classList.add("hidden");
      return true;
    }
  }

  // 2. Close queue panel if open
  const queue = $("queuePanel");
  if (queue && !queue.classList.contains("hidden")) {
    queue.classList.add("hidden");
    return true;
  }

  // 3. Close Full Player (return to app view, song continues playing in background/mini-player!)
  const playerScreen = $("player");
  if (playerScreen && !playerScreen.classList.contains("hidden")) {
    showScreen("app");
    return true;
  }

  // 4. If in Search screen and search bar has text, clear it first
  const activeTab = currentTab || "home";
  if (activeTab === "search") {
    const sInput = $("searchInput");
    if (sInput && sInput.value.trim().length > 0) {
      clearSearch();
      return true;
    }
  }

  // 5. If on any secondary tab, step back to previous tab in history, or go to Home
  if (activeTab !== "home") {
    if (tabHistory.length > 1) {
      tabHistory.pop(); // Pop current tab
      const prev = tabHistory[tabHistory.length - 1] || "home";
      showTab(prev, false);
    } else {
      showTab("home", false);
    }
    return true;
  }

  // 6. If on onboarding / auth screens, step back
  if (currentScreen === "otp-verify") {
    showScreen("login");
    return true;
  }
  if (currentScreen === "register") {
    showScreen("login");
    return true;
  }
  if (currentScreen === "login") {
    showScreen("landing");
    return true;
  }

  // 7. Already at Home tab - return false to let native double-tap exit
  return false;
};

// Capacitor native App backButton listener
if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
  try {
    window.Capacitor.Plugins.App.addListener('backButton', () => {
      const handled = window.handleAndroidBackButton();
      if (!handled) {
        const now = Date.now();
        if (now - lastExitBackPress < 2000) {
          window.Capacitor.Plugins.App.exitApp();
        } else {
          lastExitBackPress = now;
          showToast("Press back again to exit");
        }
      }
    });
  } catch (e) {}
}

window.addEventListener("popstate", () => {
  window.handleAndroidBackButton();
});

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
audioPlayer.preload = "auto";

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
  currentScreen = name;
  ALL_SCREENS.forEach(n => {
    const s = document.getElementById(n);
    if (s) {
      if (n === name) {
        s.classList.remove("hidden");
        s.classList.remove("mac-screen-enter");
        void s.offsetWidth;
        s.classList.add("mac-screen-enter");
      } else {
        s.classList.add("hidden");
        s.classList.remove("mac-screen-enter");
      }
    }
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
    try { history.pushState({ screen: "player" }, ""); } catch (e) {}
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

function showTab(tab, pushToHistory = true) {
  if (!ALL_TABS.includes(tab)) return;

  if (pushToHistory) {
    if (!tabHistory.length || tabHistory[tabHistory.length - 1] !== tab) {
      tabHistory.push(tab);
    }
    try { history.pushState({ tab: tab }, ""); } catch (e) {}
  }

  currentTab = tab;

  // Show/hide tab sections with Mac spring physics
  ALL_TABS.forEach(t => {
    const el = $(`${t}Tab`);
    if (el) {
      if (t === tab) {
        el.classList.remove("hidden");
        el.classList.remove("mac-page-enter");
        void el.offsetWidth;
        el.classList.add("mac-page-enter");
      } else {
        el.classList.add("hidden");
        el.classList.remove("mac-page-enter");
      }
    }
  });

  // Update bottom nav active state
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
  const title   = cleanSongTitle(song.title) || song.title || "Untitled";
  const artist  = song.artist || "Tamil Melody";

  return `
    <div class="song-row-fi ${playing ? "is-playing" : ""}" onclick="playSongById('${id}')">
      <div class="song-thumb-fi ${cover ? "" : artCls}">
        ${cover
          ? `<img src="${escapeHTML(cover)}" alt="" loading="lazy" onerror="this.parentElement.className='song-thumb-fi ${artCls}'; this.remove()">`
          : "♪"}
      </div>
      <div class="song-row-info">
        <div class="song-row-title">${escapeHTML(title)}</div>
        <div class="song-row-artist">${escapeHTML(artist)}</div>
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

// ──────────────────────────────────────
// MEDIA SESSION & LOCK SCREEN CONTROLS
// ──────────────────────────────────────
let screenWakeLock = null;

async function requestScreenWakeLock() {
  try {
    if ('wakeLock' in navigator && !screenWakeLock) {
      screenWakeLock = await navigator.wakeLock.request('screen');
      screenWakeLock.addEventListener('release', () => {
        screenWakeLock = null;
      });
    }
  } catch (e) {
    // Wake lock may fail if screen is locked or unpermitted; non-fatal
  }
}

function syncNativeMedia(song, isPlaying) {
  if (window.FeelItNativeBridge && window.FeelItNativeBridge.updatePlayback && song) {
    const title = cleanSongTitle(song.title) || song.title || "FEEL IT";
    const artist = song.artist || "Tamil Melody";
    const cover = getCoverUrl(song) || "";
    const pos = Math.floor((audioPlayer.currentTime || 0) * 1000);
    const dur = Math.floor((audioPlayer.duration || 0) * 1000);
    try {
      window.FeelItNativeBridge.updatePlayback(title, artist, cover, isPlaying, pos, dur);
    } catch (e) {}
  }
}

function updateMediaSession(song) {
  if (!song) return;

  syncNativeMedia(song, isPlaying);

  if (!('mediaSession' in navigator)) return;

  const title  = cleanSongTitle(song.title) || song.title || 'FEEL IT Music';
  const artist = song.artist || 'Tamil Melody';
  const album  = song.album || 'FEEL IT';
  const cover  = getCoverUrl(song) || 'https://feelit.feelit.workers.dev/icon.png';

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title,
      artist: artist,
      album: album,
      artwork: [
        { src: cover, sizes: '96x96', type: 'image/jpeg' },
        { src: cover, sizes: '128x128', type: 'image/jpeg' },
        { src: cover, sizes: '192x192', type: 'image/jpeg' },
        { src: cover, sizes: '256x256', type: 'image/jpeg' },
        { src: cover, sizes: '384x384', type: 'image/jpeg' },
        { src: cover, sizes: '512x512', type: 'image/jpeg' }
      ]
    });
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  } catch (err) {
    console.warn('MediaSession metadata error:', err);
  }
}

function setupMediaSessionHandlers() {
  if (!('mediaSession' in navigator)) return;

  const actions = [
    ['play', () => {
      if (audioPlayer.paused) {
        audioPlayer.play().then(() => {
          isPlaying = true;
          updatePlayerUI();
          if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
        }).catch(console.error);
      }
    }],
    ['pause', () => {
      audioPlayer.pause();
      isPlaying = false;
      updatePlayerUI();
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    }],
    ['previoustrack', () => {
      previousSong();
    }],
    ['nexttrack', () => {
      nextSong();
    }],
    ['seekto', (details) => {
      if (details.seekTime && isFinite(details.seekTime) && audioPlayer.duration) {
        audioPlayer.currentTime = Math.min(Math.max(0, details.seekTime), audioPlayer.duration);
        const prog = $('progressBar');
        if (prog) prog.value = (audioPlayer.currentTime / audioPlayer.duration) * 100;
        setText('currentTime', formatTime(audioPlayer.currentTime));
      }
    }]
  ];

  for (const [action, handler] of actions) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch (e) {}
  }
}

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
      const title = cleanSongTitle(s.title || "Untitled");
      const artist = s.artist || "FEEL IT";
      return `
        <div class="trending-art-card" onclick="playSongById('${id}')">
          <div class="trending-art-img-wrap ${cover ? "" : artCls}">
            ${cover
              ? `<img src="${escapeHTML(cover)}" alt="${escapeHTML(title)}" loading="lazy" onerror="this.parentElement.className='trending-art-img-wrap ${artCls}'; this.remove()">`
              : "♪"}
            <button class="trending-card-play-fab" aria-label="Play">▶</button>
          </div>
          <span class="trending-card-title">${escapeHTML(title)}</span>
          <span class="trending-card-artist">${escapeHTML(artist)}</span>
        </div>
      `;
    }).join("");
  };

  // 1. Trending Now (16 tracks)
  const trendingCardsEl = $("trendingCardsScroll");
  if (trendingCardsEl) {
    trendingCardsEl.innerHTML = renderHorizontalCards(songs.slice(0, 16));
  }

  // 2. Chartbusters & Viral Hits (16 tracks)
  const viralCardsEl = $("viralCardsScroll");
  if (viralCardsEl) {
    const viralSongs = songs.slice(16, 32);
    viralCardsEl.innerHTML = renderHorizontalCards(viralSongs.length ? viralSongs : songs.slice(0, 16));
  }

  // 3. Romantic Melodies (Tamil love & melody hits)
  const melodyCardsEl = $("melodyCardsScroll");
  if (melodyCardsEl) {
    const melodySongs = songs.filter(s => {
      const text = `${s.title} ${s.artist}`.toLowerCase();
      return /kadhal|anbe|nenjukkul|uyire|vizhi|priya|love|romance|oru devathai|kaathal|vaali|harris|yuvan/i.test(text);
    });
    melodyCardsEl.innerHTML = renderHorizontalCards(melodySongs.length >= 8 ? melodySongs.slice(0, 16) : songs.slice(32, 48));
  }

  // 4. Anirudh Blockbusters
  const anirudhCardsEl = $("anirudhCardsScroll");
  if (anirudhCardsEl) {
    const anirudhSongs = songs.filter(s => {
      const text = `${s.title} ${s.artist}`.toLowerCase();
      return /anirudh|kolaveri|hukum|chuttamalle|arabic kuthu|master|vikram|petta|beast|naan un|badass|po nee po/i.test(text);
    });
    anirudhCardsEl.innerHTML = renderHorizontalCards(anirudhSongs.length >= 6 ? anirudhSongs.slice(0, 16) : songs.slice(48, 64));
  }

  // 5. Evergreen Classics (A.R. Rahman & Ilaiyaraaja)
  const classicsCardsEl = $("classicsCardsScroll");
  if (classicsCardsEl) {
    const classicsSongs = songs.filter(s => {
      const text = `${s.title} ${s.artist}`.toLowerCase();
      return /rahman|ilaiyaraaja|ilayaraja|deva|vidyasagar|roja|alaipayuthey|sivaji|ghilli|autograph|samurai/i.test(text);
    });
    classicsCardsEl.innerHTML = renderHorizontalCards(classicsSongs.length >= 6 ? classicsSongs.slice(0, 16) : songs.slice(64, 80));
  }

  // 6. Late Night Chill & Relax
  const chillCardsEl = $("chillCardsScroll");
  if (chillCardsEl) {
    const chillSongs = songs.filter(s => {
      const text = `${s.title} ${s.artist}`.toLowerCase();
      return /chill|lo-fi|lofi|soft|peace|rain|night|acoustic|melod|life of ram/i.test(text);
    });
    chillCardsEl.innerHTML = renderHorizontalCards(chillSongs.length >= 6 ? chillSongs.slice(0, 16) : songs.slice(80, 96));
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
  searchOnlineTamilSongs(q);
  addRecentSearch(q);
}

function clearSearch() {
  currentSearchQuery = "";
  const input = $("searchInput");
  if (input) input.value = "";
  $("searchResults")?.classList.add("hidden");
  $("searchResultsArea")?.classList.remove("hidden");
  $("searchClearBtn")?.classList.add("hidden");
  const el = $("unifiedSearchResults");
  if (el) el.innerHTML = "";
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

let currentSearchQuery = "";

function renderUnifiedSearchResults(resultsList, isSearchingOnline = false) {
  const el = $("unifiedSearchResults");
  if (!el) return;

  if (!resultsList.length) {
    if (isSearchingOnline) {
      el.innerHTML = `<div class="song-list-loading"><div class="spinner"></div><span>Searching songs...</span></div>`;
    } else {
      el.innerHTML = `<p style="color:var(--text-muted);font-size:13px;padding:24px 10px;text-align:center;">No matching songs found</p>`;
    }
    return;
  }

  let html = resultsList.map((s, i) => createSongRow(s, i)).join("");
  if (isSearchingOnline) {
    html += `<div class="song-list-loading" style="padding:12px 0;"><div class="spinner"></div><span>Searching more songs...</span></div>`;
  }
  el.innerHTML = html;
}

function searchSongs(query) {
  const clean = String(query || "").trim().toLowerCase();
  currentSearchQuery = clean;

  if (!clean) {
    clearSearch();
    return;
  }

  $("searchClearBtn")?.classList.remove("hidden");
  $("searchResultsArea")?.classList.add("hidden");
  $("searchResults")?.classList.remove("hidden");

  // Instant local/cloud matches
  const localMatches = songs.filter(s =>
    `${s.title || ""} ${s.artist || ""}`.toLowerCase().includes(clean)
  );

  renderUnifiedSearchResults(localMatches, clean.length >= 2);
  return localMatches;
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
  const isAdmin = localStorage.getItem("feelItIsAdmin") === "true" || localStorage.getItem("feelItUserEmail") === "sakthi2007@gmail.com";
  const profileAdminBtn = $("profileAdminBtn");
  if (profileAdminBtn) {
    profileAdminBtn.classList.toggle("hidden", !isAdmin);
  }
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
async function renderAdminTab() {
  setText("adminTotalSongs", songs.length || "-");

  try {
    const res = await fetch(`${API_BASE}/admin/stats`);
    if (res.ok) {
      const stats = await res.json();
      setText("adminTotalUsers", stats.users ?? "-");
      setText("adminTotalSongs", stats.songs ?? songs.length);
    }
  } catch (_) {}

  const container = $("adminSongsContainer");
  if (!container) return;

  if (!songs.length) {
    container.innerHTML = `<p style="color:var(--text-muted); font-size:13px; text-align:center; padding:20px;">No songs found. Upload your first song above!</p>`;
    return;
  }

  let html = "";
  songs.forEach(s => {
    const sId = getSongId(s);
    const cover = getCoverUrl(s);
    const audioType = s.b2_key ? '<span class="badge-b2">B2 Cloud</span>' : '<span class="badge-url">Direct</span>';
    html += `
      <div class="admin-song-row">
        <img class="admin-song-thumb" src="${escapeHTML(cover)}" alt="" onerror="this.src='https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=120&q=80'">
        <div class="admin-song-info">
          <div class="admin-song-title">${escapeHTML(s.title || "Untitled")}</div>
          <div class="admin-song-meta">${escapeHTML(s.artist || "Tamil Melody")} • ${audioType}</div>
        </div>
        <div class="admin-song-actions">
          <button class="icon-btn" title="Play Preview" onclick="playSongById('${sId}')">▶️</button>
          <button class="icon-btn delete-btn" title="Delete Song" onclick="deleteSongAdmin('${sId}', '${escapeHTML(s.title || "Song")}')">🗑️</button>
        </div>
      </div>
    `;
  });
  container.innerHTML = html;
}

async function deleteSongAdmin(id, title) {
  if (!confirm(`Are you sure you want to delete "${title}" from Feel-It?`)) return;
  try {
    const res = await fetch(`${API_BASE}/songs/${id}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "Failed to delete song.");
    showToast(`Deleted "${title}" successfully.`);
    await loadSongsFromBackend();
    renderAdminTab();
  } catch (err) {
    alert(err.message || "Could not delete song.");
  }
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


const ACTOR_AND_CREW_KEYWORDS = new Set([
  "dhanush", "shruti", "shruti haasan", "vikram", "samantha", "samantha ruth prabhu",
  "suriya", "nayanthara", "madhavan", "jyothika", "vijay", "jiiva", "jiva", "ileana",
  "ileana d cruz", "karthi", "catherine tresa", "jayam ravi", "kangana", "cheran",
  "sneha", "gopika", "a.r.murugadoss", "mani ratnam", "vairamuthu", "na muthukumar",
  "sam anton", "yuabharathi", "umapathi", "rakul preet singh", "magesh babu",
  "vishal", "arya", "reema sen", "bharath", "sathya prakash", "aishwarya rai bachchan",
  "aishwarya rai", "jai", "anjali", "srinidhi shetty", "samyuktha hegde", "amala paul",
  "santhanam", "str", "simbu", "gautham", "gautham menon", "ram", "nikki galrani",
  "rajinikanth", "kamal haasan", "andrea jeremiah", "ashok selvan", "janani iyer",
  "siddharth", "ashrita", "tamannah", "tamannaah", "keerthy suresh", "vijay antony",
  "hansika", "genelia", "vikram prabhu", "sri divya", "vimal", "iniya", "priya anand",
  "shiva", "ajith kumar", "lakshmi menon", "sameera reddy", "swathi reddy", "rj balaji",
  "udit narayan", "hariharan", "shreya ghoshal", "sid sriram", "jonita gandhi",
  "shilpa rao", "anand shankar", "vinod kumar", "kv anand", "ayngaran", "ayngaran music",
  "sony music", "think music", "think premiere", "thinkpremiere", "sundar c", "vaali",
  "s.j.surya", "simran", "nivas k prasanna", "darbuka siva", "thamarai", "ghibran",
  "a. sarkunam", "nice worlds", "8d chorus", "star vijay", "srikanth", "mia george",
  "vishnu vishal", "thalapathy vijay", "chiranjeevi", "kamal", "anirudh", "anirudh ravichander",
  "anirudh ravichandran", "harris jayaraj", "harris", "yuvan", "yuvan shankar raja",
  "hiphop tamizha", "d. imman", "imman", "g.v. prakash kumar", "g.v. prakash"
]);

function cleanSongTitle(rawTitle) {
  if (!rawTitle) return "Tamil Melody";
  let t = String(rawTitle).trim();

  // Strip truncated / malformed MP3 tags like ய(MP3 32, (MP3 320K), [MP3_160K]
  t = t.replace(/[\(\[]?\s*MP3[^\)\]]*[\)\]]?/gi, "");
  t = t.replace(/ய\s*\(?MP3[^\s]*/gi, "");

  // Strip bracketed quality / promo tags
  t = t.replace(/[\(\[]\s*(?:8D|16D|32D|128D|AUDIO|VIDEO|HQ|HD|4K|2K|Dolby[^\)\]]*|Magic\s*Music[^\)\]]*|ThinkPremiere|Use\s+in[^\)\]]*|With\s+English[^\)\]]*|From\s+[^\)\]]+|Remastered)[^\)\]]*[\)\]]/gi, "");

  // Strip common promo / label prefixes and suffixes
  t = t.replace(/ThinkPremiere|Ayngaran\s*Music|Ayngaran|Sony\s*Music|Think\s*Music/gi, "");
  t = t.replace(/8D\s*SOUND\s*TRACK|8D\s*Audio|128D\s*Audio|32D\s*Effect[^\n]*/gi, "");
  t = t.replace(/Official\s*(?:Full\s*)?(?:Video|Audio|Lyric|Lyrical)?\s*(?:Song|Track)?/gi, "");
  t = t.replace(/(?:Full\s*)?(?:Video|Audio|Lyric|Lyrical)\s*(?:Song|Track)?/gi, "");
  t = t.replace(/\b(?:4K|2K|HD|HQ|Dolby\s*5\.1)\b/gi, "");
  t = t.replace(/தமிழ்\s*பாடல்வரிகள்|பாடல்வரிகள்|பாடல்/g, "");
  t = t.replace(/90s\s*Kids[^\n]*மெலடி\s*🎶?/gi, "");
  t = t.replace(/Use\s*Headphones|With\s*English\s*Subtitle/gi, "");

  // Split by delimiters BEFORE collapsing multiple spaces
  const rawParts = t.split(/[-–—|•]+|\s{2,}/).map(p => p.trim()).filter(Boolean);

  const parts = [];
  for (const p of rawParts) {
    const cp = p.replace(/^[^\w\u0B80-\u0BFF]+|[^\w\u0B80-\u0BFF]+$/g, "").trim();
    if (!cp || cp.length <= 1) continue;
    if (ACTOR_AND_CREW_KEYWORDS.has(cp.toLowerCase())) continue;
    if (["video", "songs", "song", "lyric", "audio", "tamil", "track", "original", "music"].includes(cp.toLowerCase())) continue;
    parts.push(cp);
  }

  if (!parts.length) return "Tamil Melody";
  if (parts.length === 1) return parts[0];

  const movie = parts[0];
  const song = parts[1];
  return song.toLowerCase().includes(movie.toLowerCase()) ? song : `${song} (${movie})`;
}

function enrichSongMetadata(s, i) {
  let title = String(s.title || "Untitled song").trim();
  let artist = String(s.artist || "").trim();
  let cover = String(s.cover_url || s.cover || "").trim();

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
        break;
      }
    }
  }

  const displayTitle = cleanSongTitle(title);
  if (!artist || artist === "Unknown artist") {
    artist = "Tamil Melody";
  }

  // Cover Art Archive mapping
  if (!cover || cover.includes("google.com")) {
    const searchKey = `${displayTitle} ${artist}`.toLowerCase();
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

    // Pre-populate with top online Tamil tracks in background
    fetch(`${API_BASE}/tamil/search?q=tamil+trending+hits`)
      .then(r => r.json())
      .then(onlineData => {
        const list = onlineData.songs || [];
        list.forEach(s => {
          s.title = cleanSongTitle(s.title) || s.title;
          const id = getSongId(s);
          if (!songs.find(ex => getSongId(ex) === id)) {
            songs.push(s);
          }
        });
        renderHomeTab();
      })
      .catch(() => {});
  } catch (err) {
    console.error("Load songs failed:", err);
    showToast("Cannot connect to FEEL IT backend. Start python app.py");
  }
}

// ──────────────────────────────────────
// CLOUD SIGNED URL (Backblaze B2)
// ──────────────────────────────────────

// ──────────────────────────────────────
// ONLINE TAMIL MUSIC STREAMING ENGINE
// ──────────────────────────────────────
let onlineSongsCache = new Map();
let onlineSearchRequestId = 0;

function getCachedStream(id) {
  if (onlineSongsCache.has(id)) return onlineSongsCache.get(id);
  try {
    const s = localStorage.getItem("feelItStreamCache");
    if (s) {
      const data = JSON.parse(s);
      if (data && data[id]) {
        onlineSongsCache.set(id, data[id]);
        return data[id];
      }
    }
  } catch (e) {}
  return null;
}

function saveCachedStream(id, url) {
  try {
    onlineSongsCache.set(id, url);
    let cache = {};
    const s = localStorage.getItem("feelItStreamCache");
    if (s) cache = JSON.parse(s) || {};
    cache[id] = url;
    const keys = Object.keys(cache);
    if (keys.length > 100) delete cache[keys[0]];
    localStorage.setItem("feelItStreamCache", JSON.stringify(cache));
  } catch (e) {}
}

function prefetchTopOnlineStreams(onlineList) {
  if (!Array.isArray(onlineList)) return;
  onlineList.slice(0, 5).forEach(s => {
    const cleanId = String(s.online_id || s.id).replace(/^online_/, "");
    if (cleanId && !getCachedStream(cleanId)) {
      fetch(`${API_BASE}/tamil/stream/${encodeURIComponent(cleanId)}`)
        .then(r => r.json())
        .then(data => {
          if (data && data.audio_url) {
            saveCachedStream(cleanId, data.audio_url);
            s.audio_url = data.audio_url;
          }
        })
        .catch(() => {});
    }
  });
}

async function getOnlineAudioUrl(song) {
  if (song.audio_url && song.audio_url.startsWith("http")) return song.audio_url;
  const cleanId = String(song.online_id || song.id).replace(/^online_/, "");

  const cached = getCachedStream(cleanId);
  if (cached) {
    song.audio_url = cached;
    return cached;
  }

  const res = await fetch(`${API_BASE}/tamil/stream/${encodeURIComponent(cleanId)}`);
  const result = await res.json().catch(() => ({}));
  if (!res.ok || !result.audio_url) {
    throw new Error(result.message || "Could not stream online track");
  }

  saveCachedStream(cleanId, result.audio_url);
  song.audio_url = result.audio_url;
  return result.audio_url;
}

function playOnlineSong(song) {
  const existingIdx = songs.findIndex(s => getSongId(s) === String(song.id));
  if (existingIdx !== -1) {
    playSong(existingIdx);
  } else {
    songs.unshift(song);
    playSong(0);
  }
}

async function searchOnlineTamilSongs(query) {
  const clean = String(query || "").trim();
  if (!clean || clean.length < 2) return;

  const rid = ++onlineSearchRequestId;

  try {
    const res = await fetch(`${API_BASE}/tamil/search?q=${encodeURIComponent(clean)}`);
    const data = await res.json().catch(() => ({}));
    if (rid !== onlineSearchRequestId || currentSearchQuery !== clean.toLowerCase()) return;

    const onlineList = data.songs || [];

    // Local / Cloud library matches
    const localMatches = songs.filter(s =>
      !String(s.id).startsWith("online_") &&
      `${s.title || ""} ${s.artist || ""} ${s.album || ""}`.toLowerCase().includes(clean.toLowerCase())
    );

    // Merge: localMatches first, then ALL onlineList songs
    const unified = [...localMatches];
    const seenIds = new Set(localMatches.map(s => getSongId(s)));

    onlineList.forEach(s => {
      s.title = cleanSongTitle(s.title) || s.title;
      s.artist = s.artist || "Tamil Melody";
      const id = getSongId(s);
      if (!seenIds.has(id)) {
        seenIds.add(id);
        unified.push(s);
        // Register in global songs array so playSongById finds it immediately
        if (!songs.find(ex => getSongId(ex) === id)) {
          songs.push(s);
        }
      }
    });

    renderUnifiedSearchResults(unified, false);
    prefetchTopOnlineStreams(onlineList);

  } catch (err) {
    if (rid !== onlineSearchRequestId) return;
    console.error("Online search error:", err);
    const localMatches = songs.filter(s =>
      `${s.title || ""} ${s.artist || ""}`.toLowerCase().includes(clean.toLowerCase())
    );
    renderUnifiedSearchResults(localMatches, false);
  }
}

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
  if (!songs.length) return;
  if (index < 0 || index >= songs.length) index = 0;

  // Increment request token — stale requests will bail out
  const myRequestId = ++playRequestId;

  const song = songs[index];

  setPlayerLoading(true);

  let audioUrl = "";

  try {
    if (song.source === "online" || String(song.id).startsWith("online_")) {
      audioUrl = await getOnlineAudioUrl(song);
    } else if (song.storage_provider === "b2" || song.b2_key) {
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

    isPlaying = true;
    updatePlayerUI();
    updateLastPlayed(song);
    updateMediaSession(song);
    requestScreenWakeLock();

    audioPlayer.play().catch(err => {
      console.warn("Autoplay or playback interrupted:", err);
    });

  } catch (err) {
    if (myRequestId !== playRequestId) return; // stale, ignore
    console.error("Playback error:", err);
    isPlaying = false;
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
      .catch(err => { console.error(err); });
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
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    if (window.FeelItNativeBridge && window.FeelItNativeBridge.setPlayingState) {
      window.FeelItNativeBridge.setPlayingState(true);
    }
    requestScreenWakeLock();
  });
  audioPlayer.addEventListener("pause", () => {
    isPlaying = false;
    updatePlayerUI();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    if (window.FeelItNativeBridge && window.FeelItNativeBridge.setPlayingState) {
      window.FeelItNativeBridge.setPlayingState(false);
    }
  });
  audioPlayer.addEventListener("timeupdate", () => {
    const prog = $("progressBar");
    if (prog && audioPlayer.duration) {
      prog.value = (audioPlayer.currentTime / audioPlayer.duration) * 100;
    }
    setText("currentTime",  formatTime(audioPlayer.currentTime));
    setText("durationTime", formatTime(audioPlayer.duration));
    if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession && isFinite(audioPlayer.duration) && audioPlayer.duration > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration: audioPlayer.duration,
          playbackRate: audioPlayer.playbackRate || 1,
          position: Math.min(audioPlayer.currentTime, audioPlayer.duration)
        });
      } catch (e) {}
    }
  });
  audioPlayer.addEventListener("ended", () => {
    if (!repeatEnabled && songs.length > 1) nextSong();
  });
  audioPlayer.addEventListener("error", () => {
    isPlaying = false;
    updatePlayerUI();
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
      if (input.value.trim().length >= 2) {
        searchOnlineTamilSongs(input.value.trim());
      }
    }, 300);
  });

  input.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      searchSongs(input.value);
      if (input.value.trim().length >= 2) {
        searchOnlineTamilSongs(input.value.trim());
      }
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
        const fullCode = [...boxes].map(b => b.value.trim()).join("");
        if (fullCode.length === 6) {
          handleOtpVerify();
        }
      }
    });
    box.addEventListener("keydown", e => {
      if (e.key === "Backspace" && !box.value && i > 0) boxes[i - 1].focus();
      if (e.key === "Enter") handleOtpVerify();
    });
    box.addEventListener("paste", e => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData("text").replace(/\D/g, "");
      [...text].slice(0, 6).forEach((ch, j) => { if (boxes[j]) boxes[j].value = ch; });
      if (text.length >= 6) {
        setTimeout(handleOtpVerify, 200);
      } else if (boxes[Math.min(text.length, 5)]) {
        boxes[Math.min(text.length, 5)].focus();
      }
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

  if (email.toLowerCase() === "sakthi2007@gmail.com") {
    setAuthMsg("loginMessage", "Admin account: Please enter your admin password directly.", "error");
    showToast("Admin account: Please login with admin password.");
    $("loginPassword")?.focus();
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

// ──────────────────────────────────────
// AUTH HANDLERS (Live Gmail SMTP + Password)
// ──────────────────────────────────────
let activeLoginEmail = "";

async function handleLogin() {
  const email = $("loginEmail")?.value.trim().toLowerCase() || "";
  const password = $("loginPassword")?.value || "";

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setAuthMsg("loginMessage", "Please enter a valid email address.", "error");
    return;
  }

  // ──────────────────────────────────────
  // SECRET ADMIN LOGIN GATEWAY (NO OTP)
  // ──────────────────────────────────────
  if (email === "sakthi2007@gmail.com") {
    if (!password) {
      setAuthMsg("loginMessage", "Admin account: Please enter your admin password.", "error");
      $("loginPassword")?.focus();
      return;
    }
    if (password === "fellit2007" || password === "feelit2007") {
      setAuthMsg("loginMessage", "Admin verified! Opening Admin Panel...", "success");
      showToast("Welcome Admin Sakthi! Opening Admin Panel... 🛡️");

      localStorage.setItem("feelItUserEmail", "sakthi2007@gmail.com");
      localStorage.setItem("feelItUserName", "Admin Sakthi");
      localStorage.setItem("feelItIsAdmin", "true");

      setTimeout(() => {
        showScreen("app");
        showTab("admin");
        renderAdminTab();
        setupUploadForm();
      }, 400);
      return;
    } else {
      setAuthMsg("loginMessage", "Incorrect admin password.", "error");
      showToast("Incorrect admin password.");
      return;
    }
  }


  // If password provided, verify password with backend D1
  if (password) {
    setAuthMsg("loginMessage", "Logging in...", "");
    const loginBtn = document.querySelector("#login .btn-primary");
    if (loginBtn) {
      loginBtn.disabled = true;
      loginBtn.textContent = "Logging In...";
    }

    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.message || "Incorrect email or password.");
      }

      const userName = data.user?.name || email.split("@")[0].toUpperCase();
      localStorage.setItem("feelItUserEmail", email);
      localStorage.setItem("feelItUserName", userName);

      setAuthMsg("loginMessage", "Login successful! Welcome back.", "success");
      showToast(`Welcome back, ${userName}!`);
      setTimeout(() => {
        showScreen("app");
        showTab("home");
        updateGreeting();
        if (!localStorage.getItem("feel_it_theme_selected")) {
          setTimeout(() => openThemeModal(true), 800);
        }
      }, 500);

    } catch (err) {
      console.error("Password login error:", err);
      setAuthMsg("loginMessage", err.message || "Incorrect email or password.", "error");
      showToast(err.message || "Incorrect email or password.");
    } finally {
      if (loginBtn) {
        loginBtn.disabled = false;
        loginBtn.textContent = "Log In";
      }
    }
    return;
  }

  // If password empty, trigger OTP login
  startEmailOtpLogin(email);
}

function handleLoginWithOtp() {
  const email = $("loginEmail")?.value.trim().toLowerCase() || "";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setAuthMsg("loginMessage", "Please enter your email to receive OTP.", "error");
    $("loginEmail")?.focus();
    return;
  }
  startEmailOtpLogin(email);
}

async function handleRegister() {
  const name     = $("regName")?.value.trim()     || "";
  const email    = $("regEmail")?.value.trim().toLowerCase() || "";
  const phone    = $("regPhone")?.value.trim()    || "";
  const password = $("regPassword")?.value        || "";
  const confirm  = $("regConfirm")?.value         || "";

  if (!name) {
    setAuthMsg("registerMessage", "Please enter your name.", "error");
    $("regName")?.focus();
    return;
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setAuthMsg("registerMessage", "Please enter a valid email address.", "error");
    $("regEmail")?.focus();
    return;
  }
  if (password.length < 6) {
    setAuthMsg("registerMessage", "Password must be at least 6 characters.", "error");
    $("regPassword")?.focus();
    return;
  }
  if (password !== confirm) {
    setAuthMsg("registerMessage", "Passwords do not match.", "error");
    $("regConfirm")?.focus();
    return;
  }

  setAuthMsg("registerMessage", "Sending verification code to your email...", "");
  const regBtn = document.querySelector("#register .btn-primary");
  if (regBtn) {
    regBtn.disabled = true;
    regBtn.textContent = "Sending Code...";
  }

  try {
    const res = await fetch(`${API_BASE}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, phone, password })
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data.message || "Failed to register. Please try again.");
    }

    activeLoginEmail = email;
    setText("otpEmailDisplay", email);

    // Clear previous boxes and status
    document.querySelectorAll(".otp-box").forEach(b => b.value = "");
    setAuthMsg("otpMessage", `Verification code sent to ${email}! Please check your inbox.`, "success");
    showToast(`Code sent to ${email}! Check inbox & spam.`);

    startOtpTimer();
    showScreen("otp-verify");

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
    console.error("Register send OTP error:", err);
    setAuthMsg("registerMessage", err.message || "Could not register. Please try again.", "error");
    showToast(err.message || "Could not register.");
  } finally {
    if (regBtn) {
      regBtn.disabled = false;
      regBtn.textContent = "Sign Up";
    }
  }
}

async function handleOtpVerify() {
  const boxes = document.querySelectorAll(".otp-box");
  const code  = [...boxes].map(b => b.value.trim()).join("");

  if (code.length < 6) {
    setAuthMsg("otpMessage", "Please enter the complete 6-digit code.", "error");
    showToast("Please enter all 6 digits of the OTP code.");
    return;
  }

  const email = activeLoginEmail 
    || $("otpEmailDisplay")?.textContent.trim().toLowerCase()
    || $("loginEmail")?.value.trim().toLowerCase() 
    || $("regEmail")?.value.trim().toLowerCase() 
    || "";

  if (!email) {
    setAuthMsg("otpMessage", "Session expired. Please restart login or sign up.", "error");
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

    const userName = data.user?.name || $("regName")?.value.trim() || email.split("@")[0].toUpperCase();
    localStorage.setItem("feelItUserEmail", email);
    localStorage.setItem("feelItUserName", userName);

    showToast(`Welcome, ${userName}! 🎉`);
    setTimeout(() => {
      showScreen("app");
      showTab("home");
      updateGreeting();
      if (!localStorage.getItem("feel_it_theme_selected")) {
        setTimeout(() => openThemeModal(true), 800);
      }
    }, 500);

  } catch (err) {
    console.error("OTP verification error:", err);
    setAuthMsg("otpMessage", err.message || "Incorrect OTP code. Try again.", "error");
    showToast(err.message || "Incorrect OTP code. Try again.");
  } finally {
    if (verifyBtn) {
      verifyBtn.disabled = false;
      verifyBtn.textContent = "Verify & Continue";
    }
  }
}

async function resendOtp() {
  const email = activeLoginEmail 
    || $("otpEmailDisplay")?.textContent.trim().toLowerCase()
    || $("loginEmail")?.value.trim().toLowerCase() 
    || $("regEmail")?.value.trim().toLowerCase() 
    || "";

  if (!email) {
    showScreen("login");
    return;
  }

  setAuthMsg("otpMessage", `Resending code to ${email}...`, "");
  try {
    const res = await fetch(`${API_BASE}/auth/send-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "Failed to resend code.");

    setAuthMsg("otpMessage", `New verification code sent! Check ${email}`, "success");
    showToast(`New code sent to ${email}`);
    startOtpTimer();
    if (data.otp_code) {
      showToast(`FEEL IT OTP: ${data.otp_code}`);
    }
  } catch (err) {
    console.error("Resend OTP error:", err);
    setAuthMsg("otpMessage", err.message || "Could not resend code.", "error");
    showToast(err.message || "Could not resend code.");
  }
}


async function handleLogout() {
  if (!confirm("Are you sure you want to logout?")) return;
  audioPlayer.pause();
  isPlaying = false;
  currentSongIndex = -1;
  localStorage.removeItem("feelItUserEmail");
  localStorage.removeItem("feelItUserName");
  localStorage.removeItem("feelItIsAdmin");
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
  } else if (songs.length > 0) {
    playSongByIndex(0);
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
    const audioUrl = $("uploadAudioUrl")?.value.trim() || "";
    if (!file && !audioUrl) {
      setUploadStatus("Please choose an audio file or enter an audio stream URL.", "error");
      return;
    }

    const btn = $("uploadSongButton");
    if (btn) { btn.disabled = true; btn.textContent = "Uploading to Cloudflare & B2…"; }

    try {
      const fd  = new FormData(form);
      const res = await fetch(`${API_BASE}/songs/upload`, { method: "POST", body: fd });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.message || "Upload failed");
      setUploadStatus(result.message || "Song uploaded successfully!", "success");
      showToast(result.message || "Song uploaded successfully! 🎵");
      form.reset();
      await loadSongsFromBackend();
      renderAdminTab();
    } catch (err) {
      console.error(err);
      setUploadStatus(err.message || "Upload failed", "error");
      showToast(err.message || "Upload failed.");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "🚀 Upload Song to Cloudflare & B2"; }
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
  setupMediaSessionHandlers();
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

// Global controls for native Android system media card
window.togglePlayback = togglePlayback;
window.nextSong = nextSong;
window.previousSong = previousSong;
window.audioPlayer = audioPlayer;
