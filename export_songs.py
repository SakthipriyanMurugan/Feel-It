import sqlite3
import json

conn = sqlite3.connect('backend/feel_it.db')
conn.row_factory = sqlite3.Row
cursor = conn.cursor()

rows = cursor.execute("""
    SELECT id, title, artist, cover_url, audio_url, storage_provider, b2_key, b2_bucket, file_size, duration, created_at 
    FROM songs ORDER BY id ASC
""").fetchall()

sql_statements = ["-- Export songs to Cloudflare D1", "DELETE FROM songs;"]

for r in rows:
    def esc(val):
        if val is None:
            return "NULL"
        if isinstance(val, (int, float)):
            return str(val)
        s = str(val).replace("'", "''")
        return f"'{s}'"

    vals = [
        esc(r["id"]),
        esc(r["title"]),
        esc(r["artist"]),
        esc(r["cover_url"]),
        esc(r["audio_url"]),
        esc(r["storage_provider"]),
        esc(r["b2_key"]),
        esc(r["b2_bucket"]),
        esc(r["file_size"]),
        esc(r["duration"]),
        esc(r["created_at"])
    ]

    sql_statements.append(f"INSERT INTO songs (id, title, artist, cover_url, audio_url, storage_provider, b2_key, b2_bucket, file_size, duration, created_at) VALUES ({', '.join(vals)});")

with open('songs_data.sql', 'w', encoding='utf-8') as f:
    f.write('\n'.join(sql_statements))

print(f"Exported {len(rows)} songs to songs_data.sql")
