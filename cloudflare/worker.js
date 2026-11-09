import CryptoJS from "crypto-js";
import { connect } from "cloudflare:sockets";

/**
 * FEEL IT — Cloudflare Worker API
 * Connected to Cloudflare D1 Database binding "DB" (database_name: feelit)
 */


// ──────────────────────────────────────
const onlineStreamEdgeCache = new Map();
// ONLINE TAMIL MUSIC STREAMING ENGINE (High-Speed CDN / DES Decrypt)
// ──────────────────────────────────────
function decryptSaavnUrl(enc) {
  try {
    const key = CryptoJS.enc.Utf8.parse("38346591");
    const decrypted = CryptoJS.DES.decrypt(
      { ciphertext: CryptoJS.enc.Base64.parse(enc) },
      key,
      { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }
    );
    const raw = decrypted.toString(CryptoJS.enc.Utf8).trim();
    if (!raw) return "";
    return raw.replace(/_96\.mp4|_160\.mp4/, "_320.mp4");
  } catch (e) {
    console.error("Saavn URL decryption failed:", e);
    return "";
  }
}

function decodeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function getHighResImage(url) {
  if (!url) return "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=500&q=80";
  return url.replace(/150x150/g, "500x500").replace(/50x50/g, "500x500");
}

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



// ──────────────────────────────────────
// GMAIL SMTP OTP SENDER (sakthihinata1205@gmail.com)
// ──────────────────────────────────────
async function sendGmailOtp(toEmail, otpCode) {
  try {
    const socket = connect({ hostname: "smtp.gmail.com", port: 465 }, { secureTransport: "on" });
    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    let buffer = "";
    async function readResponse() {
      while (true) {
        if (buffer.includes("\r\n")) {
          const lines = buffer.split("\r\n");
          for (let i = 0; i < lines.length - 1; i++) {
            const line = lines[i];
            if (/^\d{3}\s/.test(line)) {
              buffer = lines.slice(i + 1).join("\r\n");
              return line;
            }
          }
        }
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      return buffer;
    }

    async function sendCommand(cmd) {
      await writer.write(encoder.encode(cmd + "\r\n"));
      return await readResponse();
    }

    // 1. Initial greeting
    await readResponse();

    // 2. EHLO
    await sendCommand("EHLO localhost");

    // 3. AUTH LOGIN
    await sendCommand("AUTH LOGIN");

    // 4. Base64 Username
    await sendCommand(btoa("sakthihinata1205@gmail.com"));

    // 5. Base64 App Password
    const authRes = await sendCommand(btoa("veifgytddqomzawy"));
    if (!authRes.startsWith("235")) {
      console.error("Gmail SMTP auth failed:", authRes);
      return false;
    }

    // 6. MAIL FROM
    await sendCommand("MAIL FROM:<sakthihinata1205@gmail.com>");

    // 7. RCPT TO
    await sendCommand(`RCPT TO:<${toEmail}>`);

    // 8. DATA
    await sendCommand("DATA");

    // 9. Send email payload
    const emailBody = [
      'From: "FEEL IT Music" <sakthihinata1205@gmail.com>',
      `To: <${toEmail}>`,
      `Subject: FEEL IT - Verification Code: ${otpCode}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<div style="background:#050507;color:#ffffff;padding:28px;border-radius:14px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;max-width:480px;border:1px solid #FF1744;box-shadow:0 10px 40px rgba(0,0,0,0.8);">',
      '  <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">',
      '    <h1 style="color:#FF1744;margin:0;font-size:26px;letter-spacing:1px;">FEEL IT</h1>',
      '  </div>',
      '  <p style="font-size:15px;color:#e2e8f0;margin:0 0 12px 0;">Welcome to FEEL IT! Use the verification code below to verify your email address:</p>',
      '  <div style="background:rgba(255,23,68,0.14);border:1px solid #FF1744;border-radius:10px;padding:16px;text-align:center;margin:18px 0;">',
      `    <span style="font-size:36px;font-weight:900;letter-spacing:8px;color:#FFD700;display:inline-block;">${otpCode}</span>`,
      '  </div>',
      '  <p style="color:#94a3b8;font-size:13px;line-height:1.5;margin:0;">This verification code is valid for <b>5 minutes</b>. Please do not share this code with anyone.</p>',
      '  <hr style="border:none;border-top:1px solid rgba(255,255,255,0.08);margin:20px 0;">',
      '  <p style="color:#64748b;font-size:11px;margin:0;">FEEL IT &bull; Music Feels Better Here</p>',
      '</div>',
      '.\r\n'
    ].join('\r\n');

    await writer.write(encoder.encode(emailBody));
    await readResponse();

    // 10. QUIT
    await sendCommand("QUIT");
    writer.releaseLock();
    reader.releaseLock();
    socket.close();

    console.log("Successfully sent OTP email to", toEmail, "from sakthihinata1205@gmail.com");
    return true;
  } catch (err) {
    console.error("Gmail SMTP Send Exception:", err);
    return false;
  }
}

async function hashPassword(password) {
  const enc = new TextEncoder().encode(password + "_feel_it_salt_2026");
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
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
      // 3. REGISTER (EMAIL + PASSWORD + OTP SENT VIA GMAIL)
      // ──────────────────────────────────────
      if (url.pathname === "/api/auth/register" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const name = String(body.name || "").trim();
        const email = String(body.email || "").trim().toLowerCase();
        const phone = String(body.phone || "").trim();
        const password = String(body.password || "");

        if (!name) {
          return new Response(JSON.stringify({ message: "Please enter your full name." }), {
            status: 400,
            headers: corsHeaders
          });
        }
        if (!email || !email.includes("@")) {
          return new Response(JSON.stringify({ message: "Please enter a valid email address." }), {
            status: 400,
            headers: corsHeaders
          });
        }
        if (password.length < 6) {
          return new Response(JSON.stringify({ message: "Password must be at least 6 characters." }), {
            status: 400,
            headers: corsHeaders
          });
        }

        // Check if user already exists
        const existing = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
        if (existing && existing.password_hash) {
          return new Response(JSON.stringify({ message: "An account with this email already exists. Please log in." }), {
            status: 400,
            headers: corsHeaders
          });
        }

        // Generate 6-digit OTP
        const otpCode = String(Math.floor(100000 + Math.random() * 900000));
        const now = Date.now() / 1000;
        const expiresAt = now + 300;
        const pwdHash = await hashPassword(password);

        // Invalidate previous pending OTPs
        await env.DB.prepare(
          "UPDATE otp_verifications SET is_verified = -1 WHERE email = ? AND is_verified = 0"
        ).bind(email).run();

        // Save pending registration with password
        await env.DB.prepare(
          "INSERT INTO otp_verifications (email, otp_code, created_at, expires_at, is_verified, pending_name, pending_password, pending_phone) VALUES (?, ?, ?, ?, 0, ?, ?, ?)"
        ).bind(email, otpCode, now, expiresAt, name, pwdHash, phone).run();

        // Send OTP directly from sakthihinata1205@gmail.com
        const sent = await sendGmailOtp(email, otpCode);

        return new Response(JSON.stringify({
          status: "success",
          message: `Verification code sent to ${email} from sakthihinata1205@gmail.com`,
          email: email,
          otp_code: !sent ? otpCode : undefined
        }), { status: 200, headers: corsHeaders });
      }

      // ──────────────────────────────────────
      // 4. LOGIN (EMAIL & PASSWORD CHECK)
      // ──────────────────────────────────────
      if (url.pathname === "/api/auth/login" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const email = String(body.email || "").trim().toLowerCase();
        const password = String(body.password || "");

        // ──────────────────────────────────────
        // SECRET ADMIN LOGIN GATEWAY (NO OTP)
        // ──────────────────────────────────────
        if (email === "sakthi2007@gmail.com") {
          if (password === "fellit2007" || password === "feelit2007") {
            const pwdHash = await hashPassword(password);
            const adminUser = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
            if (!adminUser) {
              await env.DB.prepare("INSERT INTO users (email, name, password_hash, last_login) VALUES (?, ?, ?, CURRENT_TIMESTAMP)")
                .bind(email, "Admin Sakthi", pwdHash).run();
            } else {
              await env.DB.prepare("UPDATE users SET name = 'Admin Sakthi', password_hash = ?, last_login = CURRENT_TIMESTAMP WHERE id = ?")
                .bind(pwdHash, adminUser.id).run();
            }

            return new Response(JSON.stringify({
              status: "success",
              message: "Welcome Admin Sakthi!",
              is_admin: true,
              user: {
                email: "sakthi2007@gmail.com",
                name: "Admin Sakthi"
              }
            }), { status: 200, headers: corsHeaders });
          } else {
            return new Response(JSON.stringify({ message: "Incorrect admin password." }), {
              status: 400,
              headers: corsHeaders
            });
          }
        }

        if (!email || !email.includes("@")) {
          return new Response(JSON.stringify({ message: "Please enter a valid email address." }), {
            status: 400,
            headers: corsHeaders
          });
        }

        const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
        if (!user) {
          return new Response(JSON.stringify({ message: "No account found with this email. Please sign up." }), {
            status: 404,
            headers: corsHeaders
          });
        }

        if (!password) {
          return new Response(JSON.stringify({ message: "Password is required to log in." }), {
            status: 400,
            headers: corsHeaders
          });
        }

        const pwdHash = await hashPassword(password);
        if (user.password_hash && user.password_hash !== pwdHash) {
          return new Response(JSON.stringify({ message: "Incorrect password. Please check and try again." }), {
            status: 400,
            headers: corsHeaders
          });
        }

        // If user was created without password previously, update password now
        if (!user.password_hash) {
          await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(pwdHash, user.id).run();
        }

        await env.DB.prepare("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?").bind(user.id).run();

        return new Response(JSON.stringify({
          status: "success",
          message: "Login successful!",
          user: {
            email: user.email,
            name: user.name || user.email.split("@")[0]
          }
        }), { status: 200, headers: corsHeaders });
      }

      // ──────────────────────────────────────
      // 5. SEND OTP (EMAIL VERIFICATION)
      // ──────────────────────────────────────
      if (url.pathname === "/api/auth/send-otp" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const email = String(body.email || "").trim().toLowerCase();

        if (email === "sakthi2007@gmail.com") {
          return new Response(JSON.stringify({
            message: "Admin account: Please enter your admin password directly on login screen."
          }), { status: 400, headers: corsHeaders });
        }

        if (!email || !email.includes("@")) {
          return new Response(JSON.stringify({ message: "Valid email address is required." }), {
            status: 400,
            headers: corsHeaders
          });
        }

        const otpCode = String(Math.floor(100000 + Math.random() * 900000));
        const now = Date.now() / 1000;
        const expiresAt = now + 300;

        const prev = await env.DB.prepare(
          "SELECT pending_name, pending_password, pending_phone FROM otp_verifications WHERE email = ? AND pending_name IS NOT NULL AND pending_name != '' ORDER BY id DESC LIMIT 1"
        ).bind(email).first();

        await env.DB.prepare(
          "UPDATE otp_verifications SET is_verified = -1 WHERE email = ? AND is_verified = 0"
        ).bind(email).run();

        await env.DB.prepare(
          "INSERT INTO otp_verifications (email, otp_code, created_at, expires_at, is_verified, pending_name, pending_password, pending_phone) VALUES (?, ?, ?, ?, 0, ?, ?, ?)"
        ).bind(email, otpCode, now, expiresAt, prev ? prev.pending_name : "", prev ? prev.pending_password : "", prev ? prev.pending_phone : "").run();

        // Send email via Gmail SMTP
        const sent = await sendGmailOtp(email, otpCode);

        return new Response(JSON.stringify({
          message: `Verification code sent to ${email} from sakthihinata1205@gmail.com`,
          status: "success",
          otp_code: !sent ? otpCode : undefined
        }), { status: 200, headers: corsHeaders });
      }

      // ──────────────────────────────────────
      // 6. VERIFY OTP
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
        const record = await env.DB.prepare(
          "SELECT * FROM otp_verifications WHERE email = ? AND is_verified = 0 ORDER BY id DESC LIMIT 1"
        ).bind(email).first();

        if (!record) {
          return new Response(JSON.stringify({ message: "No active OTP requested for this email." }), {
            status: 400,
            headers: corsHeaders
          });
        }

        if (now > record.expires_at) {
          await env.DB.prepare("UPDATE otp_verifications SET is_verified = -1 WHERE id = ?").bind(record.id).run();
          return new Response(JSON.stringify({ message: "OTP has expired. Please request a new one." }), {
            status: 400,
            headers: corsHeaders
          });
        }

        if (String(record.otp_code).trim() !== String(otpEntered).trim()) {
          return new Response(JSON.stringify({ message: "Incorrect OTP code. Please check and try again." }), {
            status: 400,
            headers: corsHeaders
          });
        }

        // Mark verified
        await env.DB.prepare("UPDATE otp_verifications SET is_verified = 1 WHERE id = ?").bind(record.id).run();

        let displayName = record.pending_name || email.split("@")[0];
        displayName = displayName.charAt(0).toUpperCase() + displayName.slice(1);

        const existingUser = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();

        if (existingUser) {
          if (record.pending_password) {
            await env.DB.prepare("UPDATE users SET name = ?, password_hash = ?, phone = ?, last_login = CURRENT_TIMESTAMP WHERE id = ?")
              .bind(displayName, record.pending_password, record.pending_phone || "", existingUser.id).run();
          } else {
            await env.DB.prepare("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?").bind(existingUser.id).run();
          }
          displayName = existingUser.name || displayName;
        } else {
          await env.DB.prepare("INSERT INTO users (email, name, password_hash, phone) VALUES (?, ?, ?, ?)")
            .bind(email, displayName, record.pending_password || "", record.pending_phone || "").run();
        }

        return new Response(JSON.stringify({
          message: "Account verified & login successful!",
          status: "success",
          user: {
            email: email,
            name: displayName
          }
        }), { status: 200, headers: corsHeaders });
      }


      // ──────────────────────────────────────
      // ADMIN: UPLOAD SONG TO B2 + CLOUDFLARE D1
      // ──────────────────────────────────────
      if (url.pathname === "/api/songs/upload" && request.method === "POST") {
        try {
          const contentType = request.headers.get("content-type") || "";
          let title = "";
          let artist = "Tamil Melody";
          let coverUrl = "";
          let audioUrl = "";
          let b2Key = "";
          const b2Bucket = env.B2_BUCKET_NAME || "feel-it-music";

          if (contentType.includes("multipart/form-data")) {
            const formData = await request.formData();
            title = String(formData.get("title") || "").trim();
            artist = String(formData.get("artist") || "Tamil Melody").trim();
            coverUrl = String(formData.get("cover_url") || "").trim();
            audioUrl = String(formData.get("audio_url") || "").trim();

            const audioFile = formData.get("audio");
            if (audioFile && typeof audioFile === "object" && audioFile.size > 0) {
              const originalName = audioFile.name || "song.mp3";
              const safeName = `${Date.now()}_${originalName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
              b2Key = safeName;

              // B2 Upload Process
              const keyId = env.B2_KEY_ID || "005e08faae1d9a70000000005";
              const appKey = env.B2_APPLICATION_KEY || "K005lzRZRyXdiI3fMZSeb5SvhA19xoY";
              const bucketId = env.B2_BUCKET_ID || "0ea0a8bf1a6a4e01ad190a17";

              const authRes = await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
                headers: { "Authorization": `Basic ${btoa(`${keyId}:${appKey}`)}` }
              });
              if (!authRes.ok) throw new Error("Failed to authorize with Backblaze B2");
              const authData = await authRes.json();
              const b2ApiUrl = authData.apiInfo?.storageApi?.apiUrl || "https://api005.backblazeb2.com";
              const b2AuthToken = authData.authorizationToken;

              // Get Upload URL
              const upRes = await fetch(`${b2ApiUrl}/b2api/v3/b2_get_upload_url`, {
                method: "POST",
                headers: { "Authorization": b2AuthToken, "Content-Type": "application/json" },
                body: JSON.stringify({ bucketId: bucketId })
              });
              if (!upRes.ok) throw new Error("Failed to get B2 upload URL");
              const upData = await upRes.json();

              // Upload File Buffer to B2
              const fileBuffer = await audioFile.arrayBuffer();
              const uploadRes = await fetch(upData.uploadUrl, {
                method: "POST",
                headers: {
                  "Authorization": upData.authorizationToken,
                  "X-Bz-File-Name": encodeURIComponent(safeName),
                  "Content-Type": audioFile.type || "audio/mpeg",
                  "Content-Length": String(fileBuffer.byteLength),
                  "X-Bz-Content-Sha1": "do_not_verify"
                },
                body: fileBuffer
              });
              if (!uploadRes.ok) {
                const upErr = await uploadRes.text();
                throw new Error("B2 file upload failed: " + upErr);
              }
            }
          } else {
            const body = await request.json().catch(() => ({}));
            title = String(body.title || "").trim();
            artist = String(body.artist || "Tamil Melody").trim();
            coverUrl = String(body.cover_url || "").trim();
            audioUrl = String(body.audio_url || "").trim();
            b2Key = String(body.b2_key || "").trim();
          }

          if (!title) {
            return new Response(JSON.stringify({ message: "Song title is required." }), { status: 400, headers: corsHeaders });
          }
          if (!b2Key && !audioUrl) {
            return new Response(JSON.stringify({ message: "Please provide an audio file or an audio URL." }), { status: 400, headers: corsHeaders });
          }

          if (!coverUrl) {
            coverUrl = "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=500&q=80";
          }

          const insertRes = await env.DB.prepare(
            "INSERT INTO songs (title, artist, cover_url, audio_url, b2_key, b2_bucket, created_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)"
          ).bind(title, artist, coverUrl, audioUrl, b2Key || null, b2Key ? b2Bucket : null).run();

          return new Response(JSON.stringify({
            status: "success",
            message: `"${title}" uploaded to Feel-It successfully!`,
            id: insertRes.meta.last_row_id
          }), { status: 201, headers: corsHeaders });

        } catch (uploadErr) {
          console.error("Upload error:", uploadErr);
          return new Response(JSON.stringify({ message: uploadErr.message || "Upload failed." }), { status: 500, headers: corsHeaders });
        }
      }

      // ──────────────────────────────────────
      // ADMIN: DELETE SONG FROM D1
      // ──────────────────────────────────────
      const deleteMatch = url.pathname.match(/^\/api\/songs\/(\d+)$/);
      if (deleteMatch && request.method === "DELETE") {
        const songId = deleteMatch[1];
        await env.DB.prepare("DELETE FROM songs WHERE id = ?").bind(songId).run();
        await env.DB.prepare("DELETE FROM user_likes WHERE song_id = ?").bind(songId).run();
        return new Response(JSON.stringify({ status: "success", message: "Song deleted successfully." }), {
          status: 200,
          headers: corsHeaders
        });
      }

      // ──────────────────────────────────────
      // ADMIN: STATS
      // ──────────────────────────────────────
      if (url.pathname === "/api/admin/stats" && request.method === "GET") {
        const userCount = await env.DB.prepare("SELECT COUNT(*) as cnt FROM users").first();
        const songCount = await env.DB.prepare("SELECT COUNT(*) as cnt FROM songs").first();
        return new Response(JSON.stringify({
          users: userCount?.cnt || 0,
          songs: songCount?.cnt || 0
        }), { status: 200, headers: corsHeaders });
      }


      // ──────────────────────────────────────
      // 10. ONLINE TAMIL TRENDING HITS
      // ──────────────────────────────────────
      if (url.pathname === "/api/tamil/trending" && request.method === "GET") {
        try {
          const saavnUrl = "https://www.jiosaavn.com/api.php?__call=search.getResults&_format=json&_marker=0&cc=in&p=1&n=30&q=trending+tamil+hits+2026";
          const res = await fetch(saavnUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
          });
          const data = await res.json().catch(() => ({}));
          const results = data.results || [];
          const formatted = results.map(r => ({
            id: `online_${r.id}`,
            online_id: r.id,
            title: decodeHtml(r.song || r.title || "Untitled"),
            artist: decodeHtml(r.singers || r.primary_artists || r.music || "Tamil Melody"),
            album: decodeHtml(r.album || ""),
            cover_url: getHighResImage(r.image),
            duration: parseInt(r.duration || 0, 10),
            year: r.year || "2026",
            source: "online"
          }));

          return new Response(JSON.stringify({ songs: formatted }), {
            status: 200,
            headers: {
              ...corsHeaders,
              "Cache-Control": "public, max-age=3600"
            }
          });
        } catch (err) {
          console.error("Tamil trending error:", err);
          return new Response(JSON.stringify({ songs: [], error: err.message }), { status: 500, headers: corsHeaders });
        }
      }

      // ──────────────────────────────────────
      // 11. ONLINE TAMIL MUSIC SEARCH (Millions of Songs)
      // ──────────────────────────────────────
      if (url.pathname === "/api/tamil/search" && request.method === "GET") {
        const query = url.searchParams.get("q") || "";
        const page = url.searchParams.get("p") || "1";
        if (!query.trim()) {
          return new Response(JSON.stringify({ songs: [] }), { status: 200, headers: corsHeaders });
        }

        try {
          const cleanQ = query.trim().toLowerCase().includes("tamil") ? query.trim() : `${query.trim()} tamil`;
          const saavnUrl = `https://www.jiosaavn.com/api.php?__call=search.getResults&_format=json&_marker=0&cc=in&p=${page}&n=25&q=${encodeURIComponent(cleanQ)}`;
          const res = await fetch(saavnUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
          });
          const data = await res.json().catch(() => ({}));
          const results = data.results || [];

          const formatted = results.map(r => ({
            id: `online_${r.id}`,
            online_id: r.id,
            title: decodeHtml(r.song || r.title || "Untitled"),
            artist: decodeHtml(r.singers || r.primary_artists || r.music || "Tamil Melody"),
            album: decodeHtml(r.album || ""),
            cover_url: getHighResImage(r.image),
            duration: parseInt(r.duration || 0, 10),
            year: r.year || "",
            source: "online"
          }));

          return new Response(JSON.stringify({ songs: formatted, query }), {
            status: 200,
            headers: corsHeaders
          });
        } catch (err) {
          console.error("Tamil search error:", err);
          return new Response(JSON.stringify({ songs: [], error: err.message }), { status: 500, headers: corsHeaders });
        }
      }

      // ──────────────────────────────────────
      // 12. ONLINE TAMIL STREAM RESOLVER (320kbps High-Speed CDN)
      // ──────────────────────────────────────
      const tamilStreamMatch = url.pathname.match(/^\/api\/tamil\/stream\/([a-zA-Z0-9_-]+)$/);
      if (tamilStreamMatch && request.method === "GET") {
        const rawId = tamilStreamMatch[1];
        const cleanId = rawId.replace(/^online_/, "");

        if (onlineStreamEdgeCache.has(cleanId)) {
          return new Response(JSON.stringify(onlineStreamEdgeCache.get(cleanId)), {
            status: 200,
            headers: {
              ...corsHeaders,
              "Cache-Control": "public, max-age=86400, s-maxage=86400"
            }
          });
        }

        try {
          const detailUrl = `https://www.jiosaavn.com/api.php?__call=song.getDetails&cc=in&_marker=0&_format=json&api_version=4&ctx=web6dot0&pids=${cleanId}`;
          const detRes = await fetch(detailUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
          });
          const detData = await detRes.json().catch(() => ({}));
          const song = (detData.songs && detData.songs[0]) || detData[cleanId];

          if (!song) {
            return new Response(JSON.stringify({ message: "Song details not found on stream provider." }), { status: 404, headers: corsHeaders });
          }

          const enc = song.more_info?.encrypted_media_url;
          if (!enc) {
            return new Response(JSON.stringify({ message: "No stream available for this song." }), { status: 404, headers: corsHeaders });
          }

          const streamUrl = decryptSaavnUrl(enc);
          if (!streamUrl) {
            return new Response(JSON.stringify({ message: "Failed to decrypt audio stream." }), { status: 500, headers: corsHeaders });
          }

          const payload = {
            status: "success",
            id: `online_${cleanId}`,
            audio_url: streamUrl,
            title: decodeHtml(song.song || song.title),
            artist: decodeHtml(song.more_info?.artistMap?.primary_artists?.map(a => a.name).join(", ") || song.singers || "Tamil Melody"),
            cover_url: getHighResImage(song.image),
            duration: parseInt(song.more_info?.duration || song.duration || 0, 10)
          };

          if (onlineStreamEdgeCache.size > 500) {
            const firstKey = onlineStreamEdgeCache.keys().next().value;
            onlineStreamEdgeCache.delete(firstKey);
          }
          onlineStreamEdgeCache.set(cleanId, payload);

          return new Response(JSON.stringify(payload), {
            status: 200,
            headers: {
              ...corsHeaders,
              "Cache-Control": "public, max-age=86400, s-maxage=86400"
            }
          });
        } catch (err) {
          console.error("Stream resolution error:", err);
          return new Response(JSON.stringify({ message: err.message || "Failed to resolve stream." }), { status: 500, headers: corsHeaders });
        }
      }

      // ──────────────────────────────────────
      // 7. STREAM URL
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
