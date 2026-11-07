
import os
import sqlite3
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import quote

import random
import smtplib
import ssl
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import boto3
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError


# --------------------------------------------------
# FEEL IT - FLASK BACKEND
# SQLite + Backblaze B2 + local uploads
# --------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR.parent
DB_PATH = BASE_DIR / "feel_it.db"
UPLOAD_DIR = BASE_DIR / "uploads"

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_AUDIO_EXTENSIONS = {
    ".mp3", ".m4a", ".aac", ".ogg",
    ".wav", ".flac", ".opus"
}

app = Flask(
    __name__,
    static_folder=str(FRONTEND_DIR),
    static_url_path=""
)

app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024

CORS(app)


# --------------------------------------------------
# ENVIRONMENT SETTINGS
# Set these in PowerShell; do not put secret keys here.
# --------------------------------------------------

B2_KEY_ID = os.getenv("B2_KEY_ID", "")
B2_APPLICATION_KEY = os.getenv("B2_APPLICATION_KEY", "")
B2_BUCKET_NAME = os.getenv("B2_BUCKET_NAME", "feel-it-music")
B2_ENDPOINT_URL = os.getenv(
    "B2_ENDPOINT_URL",
    "https://s3.us-east-005.backblazeb2.com"
)
B2_REGION = os.getenv("B2_REGION", "us-east-005")


SMTP_EMAIL = os.getenv("SMTP_EMAIL", "sakthihinata1205@gmail.com")
SMTP_APP_PASSWORD = os.getenv("SMTP_APP_PASSWORD", "qxfrpbvksewwypzu")

# Mail verification OTPs and verified user accounts are saved directly in the SQLite / Cloudflare D1 database.


# --------------------------------------------------
# DATABASE
# --------------------------------------------------

def get_db():
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def initialize_database():
    with get_db() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS songs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                artist TEXT DEFAULT 'Unknown artist',
                cover_url TEXT DEFAULT '',
                audio_url TEXT DEFAULT '',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        """)

        db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT UNIQUE NOT NULL,
                name TEXT DEFAULT '',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                last_login TEXT DEFAULT CURRENT_TIMESTAMP
            )
        """)

        db.execute("""
            CREATE TABLE IF NOT EXISTS otp_verifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL,
                otp_code TEXT NOT NULL,
                created_at REAL NOT NULL,
                expires_at REAL NOT NULL,
                is_verified INTEGER DEFAULT 0
            )
        """)


        columns = {
            row["name"]
            for row in db.execute("PRAGMA table_info(songs)").fetchall()
        }

        # Add new columns without deleting existing songs.
        migrations = {
            "storage_provider": "TEXT DEFAULT 'local'",
            "b2_key": "TEXT",
            "b2_bucket": "TEXT",
            "file_size": "INTEGER DEFAULT 0",
            "duration": "REAL DEFAULT 0"
        }

        for column, definition in migrations.items():
            if column not in columns:
                db.execute(
                    f"ALTER TABLE songs ADD COLUMN {column} {definition}"
                )

        db.commit()


def row_to_dict(row):
    return dict(row)


def get_song(song_id):
    with get_db() as db:
        row = db.execute(
            "SELECT * FROM songs WHERE id = ?",
            (song_id,)
        ).fetchone()

    return row_to_dict(row) if row else None


# --------------------------------------------------
# BACKBLAZE B2 S3 CLIENT
# --------------------------------------------------

def get_b2_client():
    if not B2_KEY_ID or not B2_APPLICATION_KEY:
        raise RuntimeError(
            "Backblaze credentials are missing. "
            "Set B2_KEY_ID and B2_APPLICATION_KEY in PowerShell."
        )

    return boto3.client(
        "s3",
        endpoint_url=B2_ENDPOINT_URL,
        region_name=B2_REGION,
        aws_access_key_id=B2_KEY_ID,
        aws_secret_access_key=B2_APPLICATION_KEY,
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "virtual"}
        )
    )


def make_signed_url(object_key, expires_in=3600):
    client = get_b2_client()

    return client.generate_presigned_url(
        "get_object",
        Params={
            "Bucket": B2_BUCKET_NAME,
            "Key": object_key
        },
        ExpiresIn=expires_in
    )


# --------------------------------------------------
# HEALTH CHECK
# --------------------------------------------------

@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "app": "FEEL IT",
        "database": str(DB_PATH.name),
        "backblaze_configured": bool(
            B2_KEY_ID and B2_APPLICATION_KEY
        )
    })


# --------------------------------------------------
# GET SONGS
# --------------------------------------------------

@app.route("/api/songs", methods=["GET"])
def list_songs():
    with get_db() as db:
        rows = db.execute(
            "SELECT * FROM songs ORDER BY id DESC"
        ).fetchall()

    return jsonify([row_to_dict(row) for row in rows])


# --------------------------------------------------
# ADD SONG METADATA
# --------------------------------------------------

@app.route("/api/songs", methods=["POST"])
def add_song():
    data = request.get_json(silent=True) or {}

    title = str(data.get("title", "")).strip()
    artist = str(data.get("artist", "Unknown artist")).strip()
    cover_url = str(data.get("cover_url", "")).strip()
    audio_url = str(data.get("audio_url", "")).strip()

    if not title:
        return jsonify({"message": "Song title is required."}), 400

    with get_db() as db:
        cursor = db.execute("""
            INSERT INTO songs
                (title, artist, cover_url, audio_url, storage_provider)
            VALUES (?, ?, ?, ?, 'local')
        """, (title, artist, cover_url, audio_url))

        song_id = cursor.lastrowid
        db.commit()

    return jsonify({
        "message": "Song metadata saved.",
        "id": song_id
    }), 201


# --------------------------------------------------
# UPLOAD A LOCAL AUDIO FILE
# --------------------------------------------------

@app.route("/api/songs/upload", methods=["POST"])
def upload_song():
    audio_file = request.files.get("audio") or request.files.get("file")

    if audio_file is None or not audio_file.filename:
        return jsonify({
            "message": "Choose an audio file to upload."
        }), 400

    original_name = Path(audio_file.filename).name
    extension = Path(original_name).suffix.lower()

    if extension not in ALLOWED_AUDIO_EXTENSIONS:
        return jsonify({
            "message": "Unsupported audio file type."
        }), 400

    safe_name = f"{datetime.now().strftime('%Y%m%d%H%M%S%f')}{extension}"
    save_path = UPLOAD_DIR / safe_name
    audio_file.save(save_path)

    title = request.form.get(
        "title",
        Path(original_name).stem
    ).strip()

    artist = request.form.get(
        "artist",
        "Unknown artist"
    ).strip()

    cover_url = request.form.get("cover_url", "").strip()

    try:
        with get_db() as db:
            cursor = db.execute("""
                INSERT INTO songs
                    (
                        title, artist, cover_url, audio_url,
                        storage_provider, file_size
                    )
                VALUES (?, ?, ?, ?, 'local', ?)
            """, (
                title or Path(original_name).stem,
                artist or "Unknown artist",
                cover_url,
                f"uploads/{safe_name}",
                save_path.stat().st_size
            ))

            song_id = cursor.lastrowid
            db.commit()

        return jsonify({
            "message": "Song uploaded successfully.",
            "id": song_id
        }), 201

    except Exception:
        if save_path.exists():
            save_path.unlink()

        app.logger.exception("Local song upload failed")
        return jsonify({"message": "Could not save song metadata."}), 500


# --------------------------------------------------
# SERVE LOCAL UPLOADS
# --------------------------------------------------

@app.route("/uploads/<path:filename>", methods=["GET"])
def serve_upload(filename):
    return send_from_directory(UPLOAD_DIR, filename)


# --------------------------------------------------
# SYNC PRIVATE BACKBLAZE B2 SONGS INTO SQLITE
# Existing cloud objects are not downloaded.
# Their metadata is saved in the database.
# --------------------------------------------------

@app.route("/api/songs/sync-b2", methods=["POST"])
def sync_b2_songs():
    try:
        client = get_b2_client()

        paginator = client.get_paginator("list_objects_v2")
        added = 0
        updated = 0
        skipped = 0

        with get_db() as db:
            for page in paginator.paginate(Bucket=B2_BUCKET_NAME):
                for obj in page.get("Contents", []):
                    key = obj["Key"]
                    extension = Path(key).suffix.lower()

                    if extension not in ALLOWED_AUDIO_EXTENSIONS:
                        skipped += 1
                        continue

                    if key.endswith("/"):
                        skipped += 1
                        continue

                    filename = Path(key).stem
                    title = filename.replace("_", " ").replace("-", " ").strip()

                    existing = db.execute(
                        "SELECT id FROM songs WHERE b2_key = ?",
                        (key,)
                    ).fetchone()

                    if existing:
                        db.execute("""
                            UPDATE songs
                            SET file_size = ?, b2_bucket = ?,
                                storage_provider = 'b2'
                            WHERE id = ?
                        """, (
                            obj.get("Size", 0),
                            B2_BUCKET_NAME,
                            existing["id"]
                        ))
                        updated += 1

                    else:
                        db.execute("""
                            INSERT INTO songs (
                                title, artist, cover_url, audio_url,
                                storage_provider, b2_key, b2_bucket,
                                file_size
                            )
                            VALUES (?, ?, '', '', 'b2', ?, ?, ?)
                        """, (
                            title or "Untitled song",
                            "Unknown artist",
                            key,
                            B2_BUCKET_NAME,
                            obj.get("Size", 0)
                        ))
                        added += 1

            db.commit()

        return jsonify({
            "message": "Backblaze sync completed.",
            "added": added,
            "updated": updated,
            "skipped": skipped
        })

    except (RuntimeError, BotoCoreError, ClientError) as error:
        app.logger.exception("Backblaze sync failed")
        return jsonify({
            "message": str(error)
        }), 500

    except Exception:
        app.logger.exception("Unexpected cloud sync error")
        return jsonify({
            "message": "Unexpected error while syncing cloud songs."
        }), 500


# --------------------------------------------------
# GET A TEMPORARY SIGNED PLAYBACK URL
# Private B2 files must be accessed using a signed URL.
# --------------------------------------------------

@app.route("/api/songs/<int:song_id>/stream-url", methods=["GET"])
def get_song_stream_url(song_id):
    song = get_song(song_id)

    if not song:
        return jsonify({"message": "Song not found."}), 404

    if song.get("storage_provider") == "b2" or song.get("b2_key"):
        try:
            url = make_signed_url(song["b2_key"], expires_in=3600)

            return jsonify({
                "audio_url": url,
                "expires_in": 3600
            })

        except (RuntimeError, BotoCoreError, ClientError) as error:
            app.logger.exception("Could not create signed URL")
            return jsonify({
                "message": str(error)
            }), 500

    local_url = song.get("audio_url", "")

    if local_url and not local_url.startswith(("http://", "https://")):
        local_url = "/" + local_url.lstrip("/")

    return jsonify({
        "audio_url": local_url
    })


# --------------------------------------------------
# MUSICBRAINZ & COVER ART ARCHIVE SEARCH
# --------------------------------------------------

@app.route("/api/musicbrainz/search", methods=["GET"])
def musicbrainz_search():
    query = request.args.get("q", "").strip()
    if not query:
        return jsonify({"songs": []})

    try:
        import urllib.request
        import json
        from urllib.parse import quote

        url = f"https://musicbrainz.org/ws/2/recording?query={quote(query)}&fmt=json&limit=15"
        req = urllib.request.Request(url, headers={
            "User-Agent": "FeelItMusicApp/1.0.0 ( contact@feelit.workers.dev )",
            "Accept": "application/json"
        })

        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        recordings = data.get("recordings", [])
        songs = []

        for rec in recordings:
            releases = rec.get("releases", [])
            rel = releases[0] if releases else {}
            release_id = rel.get("id", "")
            artist_credit = rec.get("artist-credit", [])
            artist = "".join([c.get("name", "") for c in artist_credit]) if artist_credit else "Unknown artist"
            cover_url = f"https://coverartarchive.org/release/{release_id}/front-250.jpg" if release_id else ""

            songs.append({
                "id": rec.get("id"),
                "title": rec.get("title", "Untitled"),
                "artist": artist,
                "album": rel.get("title", ""),
                "year": rel.get("date", "").split("-")[0] if rel.get("date") else "",
                "release_id": release_id,
                "cover_url": cover_url,
                "duration": round(rec.get("length", 0) / 1000) if rec.get("length") else 0,
                "source": "musicbrainz"
            })

        return jsonify({"songs": songs})

    except Exception as e:
        app.logger.exception("MusicBrainz search failed")
        return jsonify({"songs": [], "error": str(e)}), 500


# --------------------------------------------------
# AUTH & OTP WITH GMAIL SMTP
# --------------------------------------------------

def send_otp_email(to_email, otp_code):
    subject = "FEEL IT - Your Verification Code"
    html_content = f"""
    <div style="font-family: 'Segoe UI', Arial, sans-serif; background-color: #07000F; color: #ffffff; padding: 30px; border-radius: 12px; max-width: 500px; margin: auto; border: 1px solid rgba(255, 215, 0, 0.3);">
        <div style="text-align: center; margin-bottom: 20px;">
            <h1 style="color: #FFD700; margin: 0; font-size: 28px; letter-spacing: 2px;">FEEL IT</h1>
            <p style="color: #8B7BAB; font-size: 13px; margin: 5px 0 0 0;">Music Beyond Limits</p>
        </div>
        <p style="font-size: 15px; color: #D0C4E8;">Hello,</p>
        <p style="font-size: 14px; color: #D0C4E8; line-height: 1.6;">Use the verification code below to sign in to your FEEL IT account:</p>
        <div style="text-align: center; margin: 30px 0;">
            <span style="display: inline-block; font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #FFD700; background: rgba(255, 215, 0, 0.1); padding: 12px 24px; border-radius: 8px; border: 1px solid rgba(255, 215, 0, 0.4);">{otp_code}</span>
        </div>
        <p style="font-size: 13px; color: #8B7BAB;">This code is valid for 5 minutes. If you did not request this, you can safely ignore this email.</p>
        <hr style="border: none; border-top: 1px solid rgba(255, 255, 255, 0.1); margin: 25px 0;" />
        <p style="font-size: 11px; color: #5A4E70; text-align: center;">&copy; FEEL IT. Feel Every Beat.</p>
    </div>
    """

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"FEEL IT <{SMTP_EMAIL}>"
    msg["To"] = to_email

    msg.attach(MIMEText(f"Your FEEL IT verification code is: {otp_code}. Valid for 5 minutes.", "plain"))
    msg.attach(MIMEText(html_content, "html"))

    context = ssl.create_default_context()
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=context) as server:
        server.login(SMTP_EMAIL, SMTP_APP_PASSWORD)
        server.sendmail(SMTP_EMAIL, to_email, msg.as_string())


@app.route("/api/auth/send-otp", methods=["POST"])
def send_otp():
    data = request.get_json(silent=True) or {}
    email = str(data.get("email", "")).strip().lower()

    if not email or "@" not in email:
        return jsonify({"message": "Valid email address is required."}), 400

    otp_code = f"{random.randint(100000, 999999)}"
    current_ts = datetime.now(timezone.utc).timestamp()
    expires_ts = current_ts + 300  # 5 minutes validity

    try:
        with get_db() as db:
            # Invalidate any previously active OTP for this email
            db.execute("""
                UPDATE otp_verifications
                SET is_verified = -1
                WHERE email = ? AND is_verified = 0
            """, (email,))

            # Save newly generated OTP to database
            db.execute("""
                INSERT INTO otp_verifications (email, otp_code, created_at, expires_at, is_verified)
                VALUES (?, ?, ?, ?, 0)
            """, (email, otp_code, current_ts, expires_ts))
            db.commit()

        # Dispatch email via Gmail SMTP
        send_otp_email(email, otp_code)

        return jsonify({
            "message": f"Verification code sent to {email}",
            "status": "success"
        })
    except Exception as e:
        app.logger.exception("Failed to send OTP email")
        return jsonify({
            "message": f"Failed to send email: {str(e)}"
        }), 500


@app.route("/api/auth/verify-otp", methods=["POST"])
def verify_otp():
    data = request.get_json(silent=True) or {}
    email = str(data.get("email", "")).strip().lower()
    otp_entered = str(data.get("otp", "")).strip()

    if not email or not otp_entered:
        return jsonify({"message": "Email and OTP are required."}), 400

    current_time = datetime.now(timezone.utc).timestamp()

    with get_db() as db:
        # Retrieve the latest active OTP from database
        record = db.execute("""
            SELECT * FROM otp_verifications
            WHERE email = ? AND is_verified = 0
            ORDER BY id DESC
            LIMIT 1
        """, (email,)).fetchone()

        if not record:
            return jsonify({"message": "No active OTP requested for this email. Please request a new one."}), 400

        # Check 5 minutes expiration
        if current_time > record["expires_at"]:
            db.execute("UPDATE otp_verifications SET is_verified = -1 WHERE id = ?", (record["id"],))
            db.commit()
            return jsonify({"message": "OTP has expired. Please request a new one."}), 400

        # Validate OTP code
        if record["otp_code"] != otp_entered:
            return jsonify({"message": "Incorrect OTP code. Please check and try again."}), 400

        # Mark OTP as verified (1)
        db.execute("UPDATE otp_verifications SET is_verified = 1 WHERE id = ?", (record["id"],))

        # Check if user already exists, or insert new user
        display_name = email.split("@")[0].capitalize()
        user_row = db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()

        if user_row:
            db.execute("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?", (user_row["id"],))
            display_name = user_row["name"] or display_name
        else:
            db.execute("INSERT INTO users (email, name) VALUES (?, ?)", (email, display_name))

        db.commit()

    return jsonify({
        "message": "Login successful!",
        "status": "success",
        "user": {
            "email": email,
            "name": display_name
        }
    })

# --------------------------------------------------
# SERVE FRONTEND & STATIC ASSETS
# --------------------------------------------------

def find_frontend_file(filename):
    for candidate_dir in [FRONTEND_DIR, BASE_DIR, BASE_DIR / "static"]:
        candidate_file = candidate_dir / filename
        if candidate_file.exists():
            return candidate_dir, filename
    return None, None
# --------------------------------------------------

@app.route("/", methods=["GET"])
def home():
    directory, filename = find_frontend_file("index.html")
    if directory:
        response = send_from_directory(directory, filename)
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response




    return """
    <h1>FEEL IT Backend</h1>
    <p>Backend is running.</p>
    <p>Place index.html in the root folder to serve the app.</p>
    <p>Health check: <a href="/api/health">/api/health</a></p>
    """, 200


# --------------------------------------------------
@app.route("/<path:path>", methods=["GET"])
def serve_static_assets(path):
    if path.startswith("api/"):
        return jsonify({"message": "API endpoint not found"}), 404

    directory, filename = find_frontend_file(path)
    if directory:
        response = send_from_directory(directory, filename)
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response

    fallback_dir, fallback_name = find_frontend_file("index.html")
    if fallback_dir:
        return send_from_directory(fallback_dir, fallback_name)

    return jsonify({"message": "File not found"}), 404


# START SERVER
# --------------------------------------------------

if __name__ == "__main__":
    initialize_database()

    print("---------------------------------------")
    print(" FEEL IT backend is starting...")
    print(" Local URL:   http://127.0.0.1:5000")
    print(" Network URL: http://0.0.0.0:5000 (Open in phone using laptop IP)")
    print(" Health:      http://127.0.0.1:5000/api/health")
    print("---------------------------------------")

    app.run(
        host="0.0.0.0",
        port=5000,
        debug=True
    )
