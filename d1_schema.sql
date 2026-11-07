-- ============================================================
-- FEEL IT — Cloudflare D1 Database Schema
-- Run this migration on Cloudflare using:
-- npx wrangler d1 execute feelit --remote --file=./d1_schema.sql
-- ============================================================

-- 1. USERS TABLE
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_login TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 2. EMAIL OTP VERIFICATIONS TABLE
CREATE TABLE IF NOT EXISTS otp_verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    otp_code TEXT NOT NULL,
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL,
    is_verified INTEGER DEFAULT 0
);

-- 3. SONGS TABLE (Backblaze B2 & Cloud Streaming)
CREATE TABLE IF NOT EXISTS songs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    artist TEXT DEFAULT 'Unknown artist',
    cover_url TEXT DEFAULT '',
    audio_url TEXT DEFAULT '',
    storage_provider TEXT DEFAULT 'b2',
    b2_key TEXT,
    b2_bucket TEXT,
    file_size INTEGER DEFAULT 0,
    duration REAL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- INDEXES
CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_verifications(email);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_songs_id ON songs(id);
