/**
 * FEEL IT — Cloudflare Worker API
 * Connected to Cloudflare D1 Database binding "DB" (database_name: feelit)
 */

let b2Cache = {
  token: "",
  downloadUrl: "https://f005.backblazeb2.com",
  expiresAt: 0
};

async function getB2AuthorizedDownload(env) {
  const now = Date.now();
  if (b2Cache.token && b2Cache.expiresAt > (now + 300000)) {
    return b2Cache;
  }

  const keyId = env.B2_KEY_ID || "005e08faae1d9a70000000005";
  const appKey = env.B2_APPLICATION_KEY || "K005lzRZRyXdiI3fMZSeb5SvhA19xoY";
  const defaultBucketId = env.B2_BUCKET_ID || "0ea0a8bf1a6a4e01ad190a17";

  try {
    const creds = btoa(`${keyId}:${appKey}`);
    const authRes = await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
      headers: { "Authorization": `Basic ${creds}` }
    });
    if (!authRes.ok) return null;
    const authData = await authRes.json();

    const token = authData.authorizationToken;
    const apiUrl = authData.apiInfo?.storageApi?.apiUrl || "https://api005.backblazeb2.com";
    const downloadUrl = authData.apiInfo?.storageApi?.downloadUrl || "https://f005.backblazeb2.com";
    const bucketId = authData.apiInfo?.storageApi?.bucketId || defaultBucketId;

    const dlRes = await fetch(`${apiUrl}/b2api/v3/b2_get_download_authorization`, {
      method: "POST",
      headers: {
        "Authorization": token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        bucketId: bucketId,
        fileNamePrefix: "",
        validDurationInSeconds: 86400
      })
    });

    if (!dlRes.ok) return null;
    const dlData = await dlRes.json();

    b2Cache = {
      token: dlData.authorizationToken,
      downloadUrl: downloadUrl,
      expiresAt: now + (23 * 60 * 60 * 1000) // valid 23 hours
    };
    return b2Cache;
  } catch (err) {
    console.error("Backblaze Auth Error:", err);
    return null;
  }
}


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Standard CORS headers for web and mobile (Capacitor)
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json"
    };

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Serve static frontend assets for non-API routes (Over-The-Air Live Update)
    if (!url.pathname.startsWith("/api/") && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    try {
      // ──────────────────────────────────────
      // 1. HEALTH CHECK
      // ──────────────────────────────────────
      if (url.pathname === "/api/health" && request.method === "GET") {
        let dbOk = false;
        try {
          const test = await env.DB.prepare("SELECT 1 as alive").first();
          dbOk = Boolean(test?.alive);
        } catch (_) {}

        return new Response(JSON.stringify({
          status: "ok",
          app: "FEEL IT",
          database: "Cloudflare D1 (feelit)",
          d1_connected: dbOk
        }), { status: 200, headers: corsHeaders });
      }

      // ──────────────────────────────────────
      // 2. GET SONGS
      // ──────────────────────────────────────
      if (url.pathname === "/api/songs" && request.method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT * FROM songs ORDER BY id DESC"
        ).all();

        const formatted = (results || []).map(s => ({
          ...s,
          artist: (!s.artist || s.artist === "Unknown artist") ? "Tamil Melody" : s.artist,
          cover_url: (!s.cover_url || s.cover_url.includes("google.com"))
            ? "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=500&q=80"
            : s.cover_url
        }));

        return new Response(JSON.stringify(formatted), {
          status: 200,
          headers: corsHeaders
        });
      }

      // ──────────────────────────────────────
      // 3. SEND OTP (EMAIL VERIFICATION)
      // ──────────────────────────────────────
      if (url.pathname === "/api/auth/send-otp" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const email = String(body.email || "").trim().toLowerCase();

        if (!email || !email.includes("@")) {
          return new Response(JSON.stringify({ message: "Valid email address is required." }), {
            status: 400,
            headers: corsHeaders
          });
        }

        // Generate 6-digit OTP
        const otpCode = String(Math.floor(100000 + Math.random() * 900000));
        const now = Date.now() / 1000;
        const expiresAt = now + 300; // 5 minutes validity

        // Supersede previous pending OTPs
        await env.DB.prepare(
          "UPDATE otp_verifications SET is_verified = -1 WHERE email = ? AND is_verified = 0"
        ).bind(email).run();

        // Save new OTP to Cloudflare D1
        await env.DB.prepare(
          "INSERT INTO otp_verifications (email, otp_code, created_at, expires_at, is_verified) VALUES (?, ?, ?, ?, 0)"
        ).bind(email, otpCode, now, expiresAt).run();

        // If email service configured (Resend / MailChannels / Webhook)
        if (env.RESEND_API_KEY) {
          try {
            await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${env.RESEND_API_KEY}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                from: "FEEL IT <onboarding@resend.dev>",
                to: [email],
                subject: "FEEL IT - Your Verification Code",
                html: `<div style="font-family:sans-serif;padding:20px;background:#07000F;color:#fff;border-radius:10px;">
                  <h2 style="color:#FFD700">FEEL IT</h2>
                  <p>Your verification code is: <b style="font-size:24px;color:#FFD700;letter-spacing:4px">${otpCode}</b></p>
                  <p style="color:#888;font-size:12px">Valid for 5 minutes.</p>
                </div>`
              })
            });
          } catch (mailErr) {
            console.error("Resend send failed:", mailErr);
          }
        }

        return new Response(JSON.stringify({
          message: `Verification code sent to ${email}`,
          status: "success"
        }), { status: 200, headers: corsHeaders });
      }

      // ──────────────────────────────────────
      // 4. VERIFY OTP
      // ──────────────────────────────────────
      if (url.pathname === "/api/auth/verify-otp" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const email = String(body.email || "").trim().toLowerCase();
        const otpEntered = String(body.otp || "").trim();

        if (!email || !otpEntered) {
          return new Response(JSON.stringify({ message: "Email and OTP are required." }), {
            status: 400,
            headers: corsHeaders
          });
        }

        const now = Date.now() / 1000;

        // Fetch active OTP from D1
        const record = await env.DB.prepare(
          "SELECT * FROM otp_verifications WHERE email = ? AND is_verified = 0 ORDER BY id DESC LIMIT 1"
        ).bind(email).first();

        if (!record) {
          return new Response(JSON.stringify({ message: "No active OTP requested for this email." }), {
            status: 400,
            headers: corsHeaders
          });
        }

        // Check expiration
        if (now > record.expires_at) {
          await env.DB.prepare("UPDATE otp_verifications SET is_verified = -1 WHERE id = ?").bind(record.id).run();
          return new Response(JSON.stringify({ message: "OTP has expired. Please request a new one." }), {
            status: 400,
            headers: corsHeaders
          });
        }

        // Compare OTP code
        if (record.otp_code !== otpEntered) {
          return new Response(JSON.stringify({ message: "Incorrect OTP code. Please check and try again." }), {
            status: 400,
            headers: corsHeaders
          });
        }

        // Mark verified in D1
        await env.DB.prepare("UPDATE otp_verifications SET is_verified = 1 WHERE id = ?").bind(record.id).run();

        // Check or create user in D1
        let displayName = email.split("@")[0];
        displayName = displayName.charAt(0).toUpperCase() + displayName.slice(1);

        const existingUser = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();

        if (existingUser) {
          await env.DB.prepare("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?").bind(existingUser.id).run();
          displayName = existingUser.name || displayName;
        } else {
          await env.DB.prepare("INSERT INTO users (email, name) VALUES (?, ?)").bind(email, displayName).run();
        }

        return new Response(JSON.stringify({
          message: "Login successful!",
          status: "success",
          user: {
            email: email,
            name: displayName
          }
        }), { status: 200, headers: corsHeaders });
      }

      // ──────────────────────────────────────
      // 5. STREAM URL
      // ──────────────────────────────────────
      const streamMatch = url.pathname.match(/^\/api\/songs\/(\d+)\/stream-url$/);
      if (streamMatch && request.method === "GET") {
        const songId = streamMatch[1];

        // Fetch song from Cloudflare D1
        const song = await env.DB.prepare("SELECT * FROM songs WHERE id = ?").bind(songId).first();
        if (!song) {
          return new Response(JSON.stringify({ message: "Song not found." }), {
            status: 404,
            headers: corsHeaders
          });
        }

        let audioUrl = song.audio_url || "";
        if (!audioUrl && song.b2_key) {
          const bucket = song.b2_bucket || "feel-it-music";
          const b2 = await getB2AuthorizedDownload(env);
          if (b2 && b2.token) {
            audioUrl = `${b2.downloadUrl}/file/${bucket}/${encodeURIComponent(song.b2_key)}?Authorization=${b2.token}`;
          } else {
            // Direct streaming CDN proxy fallback
            audioUrl = `https://feelit.feelit.workers.dev/api/stream/${song.id}`;
          }
        }

        return new Response(JSON.stringify({
          audio_url: audioUrl,
          song_id: song.id,
          title: song.title
        }), { status: 200, headers: corsHeaders });
      }

      // ──────────────────────────────────────
      // 5B. DIRECT STREAMING CDN PROXY (Zero 401s, High-Speed Edge Delivery)
      // ──────────────────────────────────────
      const proxyMatch = url.pathname.match(/^\/api\/stream\/(\d+)$/);
      if (proxyMatch && request.method === "GET") {
        const songId = proxyMatch[1];
        const song = await env.DB.prepare("SELECT * FROM songs WHERE id = ?").bind(songId).first();
        if (!song || !song.b2_key) {
          return new Response("Song not found", { status: 404 });
        }

        const bucket = song.b2_bucket || "feel-it-music";
        const b2 = await getB2AuthorizedDownload(env);
        let b2Url = "";
        const fwdHeaders = new Headers();

        if (b2 && b2.token) {
          b2Url = `${b2.downloadUrl}/file/${bucket}/${encodeURIComponent(song.b2_key)}?Authorization=${b2.token}`;
        } else {
          b2Url = `https://f005.backblazeb2.com/file/${bucket}/${encodeURIComponent(song.b2_key)}`;
        }

        const range = request.headers.get("Range");
        if (range) {
          fwdHeaders.set("Range", range);
        }

        const b2Res = await fetch(b2Url, {
          method: "GET",
          headers: fwdHeaders
        });

        const resHeaders = new Headers(b2Res.headers);
        resHeaders.set("Access-Control-Allow-Origin", "*");
        resHeaders.set("Access-Control-Allow-Headers", "*");
        resHeaders.set("Content-Type", "audio/mpeg");
        resHeaders.set("Accept-Ranges", "bytes");
        resHeaders.set("Cache-Control", "public, max-age=604800, immutable");

        return new Response(b2Res.body, {
          status: b2Res.status,
          headers: resHeaders
        });
      }

      // ──────────────────────────────────────
      // 6. MUSICBRAINZ & COVER ART ARCHIVE SEARCH
      // ──────────────────────────────────────
      if (url.pathname === "/api/musicbrainz/search" && request.method === "GET") {
        const query = url.searchParams.get("q") || "";
        if (!query.trim()) {
          return new Response(JSON.stringify({ songs: [] }), {
            status: 200,
            headers: corsHeaders
          });
        }

        try {
          const mbUrl = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query.trim())}&fmt=json&limit=15`;
          const mbRes = await fetch(mbUrl, {
            headers: {
              "User-Agent": "FeelItMusicApp/1.0.0 ( contact@feelit.workers.dev )",
              "Accept": "application/json"
            }
          });

          if (!mbRes.ok) {
            return new Response(JSON.stringify({ songs: [], error: "MusicBrainz API unreachable" }), {
              status: 200,
              headers: corsHeaders
            });
          }

          const mbData = await mbRes.json();
          const recordings = mbData.recordings || [];

          const songs = recordings.map(rec => {
            const rel = (rec.releases || [])[0];
            const artist = (rec["artist-credit"] || []).map(c => c.name).join("") || "Unknown artist";
            const releaseId = rel?.id || "";
            // Official Cover Art Archive front cover thumbnail
            const coverUrl = releaseId ? `https://coverartarchive.org/release/${releaseId}/front-250.jpg` : "";

            return {
              id: rec.id,
              title: rec.title || "Untitled",
              artist: artist,
              album: rel?.title || "",
              year: rel?.date ? rel.date.split("-")[0] : "",
              release_id: releaseId,
              cover_url: coverUrl,
              duration: rec.length ? Math.round(rec.length / 1000) : 0,
              source: "musicbrainz"
            };
          });

          return new Response(JSON.stringify({ songs }), {
            status: 200,
            headers: corsHeaders
          });
        } catch (fetchErr) {
          console.error("MusicBrainz search error:", fetchErr);
          return new Response(JSON.stringify({ songs: [], error: fetchErr.message }), {
            status: 200,
            headers: corsHeaders
          });
        }
      }

      // ──────────────────────────────────────
      // 7. COVER ART ARCHIVE DIRECT LOOKUP BY RELEASE MBID
      // ──────────────────────────────────────
      const caMatch = url.pathname.match(/^\/api\/coverart\/([0-9a-f-]+)$/i);
      if (caMatch && request.method === "GET") {
        const releaseId = caMatch[1];
        return new Response(JSON.stringify({
          release_id: releaseId,
          cover_url: `https://coverartarchive.org/release/${releaseId}/front-250.jpg`,
          full_cover_url: `https://coverartarchive.org/release/${releaseId}/front`
        }), { status: 200, headers: corsHeaders });
      }


      // ──────────────────────────────────────
      // 7. LIKES & FAVORITES (SYNC WITH D1)
      // ──────────────────────────────────────
      if (url.pathname === "/api/likes" && request.method === "GET") {
        const email = String(url.searchParams.get("email") || "").trim().toLowerCase();
        if (!email) {
          return new Response(JSON.stringify({ likes: [] }), { status: 200, headers: corsHeaders });
        }
        const { results } = await env.DB.prepare(
          "SELECT song_id FROM user_likes WHERE user_email = ? ORDER BY id DESC"
        ).bind(email).all();
        const ids = (results || []).map(r => r.song_id);
        return new Response(JSON.stringify({ likes: ids }), { status: 200, headers: corsHeaders });
      }

      if (url.pathname === "/api/likes" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const email = String(body.email || "").trim().toLowerCase();
        const songId = parseInt(body.song_id, 10);
        if (!email || isNaN(songId)) {
          return new Response(JSON.stringify({ message: "email and song_id required" }), { status: 400, headers: corsHeaders });
        }
        const existing = await env.DB.prepare(
          "SELECT id FROM user_likes WHERE user_email = ? AND song_id = ?"
        ).bind(email, songId).first();

        if (existing) {
          await env.DB.prepare("DELETE FROM user_likes WHERE id = ?").bind(existing.id).run();
          return new Response(JSON.stringify({ liked: false, song_id: songId }), { status: 200, headers: corsHeaders });
        } else {
          await env.DB.prepare("INSERT INTO user_likes (user_email, song_id) VALUES (?, ?)").bind(email, songId).run();
          return new Response(JSON.stringify({ liked: true, song_id: songId }), { status: 200, headers: corsHeaders });
        }
      }

      // ──────────────────────────────────────
      // 8. LISTENING HISTORY (SCROBBLE)
      // ──────────────────────────────────────
      if (url.pathname === "/api/history" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const email = String(body.email || "guest").trim().toLowerCase();
        const songId = parseInt(body.song_id, 10);
        const duration = parseFloat(body.duration || 0);
        if (!isNaN(songId)) {
          await env.DB.prepare(
            "INSERT INTO listening_history (user_email, song_id, duration_played) VALUES (?, ?, ?)"
          ).bind(email, songId, duration).run();
        }
        return new Response(JSON.stringify({ status: "recorded" }), { status: 200, headers: corsHeaders });
      }

      // ──────────────────────────────────────
      // 9. PERSONALIZED RECOMMENDATIONS
      // ──────────────────────────────────────
      if (url.pathname === "/api/recommendations" && request.method === "GET") {
        const email = String(url.searchParams.get("email") || "").trim().toLowerCase();
        let topArtists = [];
        if (email) {
          const hist = await env.DB.prepare(`
            SELECT s.artist, COUNT(*) as cnt 
            FROM listening_history h 
            JOIN songs s ON h.song_id = s.id 
            WHERE h.user_email = ? AND s.artist != 'Unknown artist'
            GROUP BY s.artist ORDER BY cnt DESC LIMIT 3
          `).bind(email).all();
          topArtists = (hist.results || []).map(r => r.artist);
        }

        let query = "SELECT * FROM songs ";
        if (topArtists.length > 0) {
          const placeholders = topArtists.map(() => "?").join(",");
          query += `WHERE artist IN (${placeholders}) ORDER BY RANDOM() LIMIT 15`;
          const { results } = await env.DB.prepare(query).bind(...topArtists).all();
          return new Response(JSON.stringify({ recommendations: results || [] }), { status: 200, headers: corsHeaders });
        } else {
          query += "ORDER BY RANDOM() LIMIT 15";
          const { results } = await env.DB.prepare(query).all();
          return new Response(JSON.stringify({ recommendations: results || [] }), { status: 200, headers: corsHeaders });
        }
      }

      return new Response(JSON.stringify({ message: "Endpoint not found" }), {
        status: 404,
        headers: corsHeaders
      });

    } catch (err) {
      console.error("Worker error:", err);
      return new Response(JSON.stringify({
        message: "Internal server error",
        error: err.message
      }), {
        status: 500,
        headers: corsHeaders
      });
    }
  }
};
