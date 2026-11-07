/**
 * FEEL IT — Cloudflare Worker API
 * Connected to Cloudflare D1 Database binding "DB" (database_name: feelit)
 */

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
            ? "https://coverartarchive.org/release/de6c853a-1f3e-47e6-9ff6-48dfc1491bf5/front-250.jpg"
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

        // 1. First attempt to get the Backblaze B2 pre-signed URL via backend presigner
        try {
          const renderRes = await fetch(`https://feel-it-vpfp.onrender.com/api/songs/${songId}/stream-url`);
          if (renderRes.ok) {
            const data = await renderRes.text();
            return new Response(data, { status: 200, headers: corsHeaders });
          }
        } catch (_) {}

        // 2. Fallback to D1 database audio_url
        const song = await env.DB.prepare("SELECT * FROM songs WHERE id = ?").bind(songId).first();
        if (!song) {
          return new Response(JSON.stringify({ message: "Song not found." }), {
            status: 404,
            headers: corsHeaders
          });
        }

        return new Response(JSON.stringify({
          audio_url: song.audio_url || ""
        }), { status: 200, headers: corsHeaders });
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
