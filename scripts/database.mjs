export function initializeDatabase(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS excluded_channels (
      channel_id TEXT PRIMARY KEY,
      title TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channels (
      channel_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      subscriber_count INTEGER,
      uploads_playlist_id TEXT,
      discovered_keyword TEXT,
      discovered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS videos (
      video_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(channel_id),
      title TEXT NOT NULL,
      published_at TEXT NOT NULL,
      thumbnail_url TEXT,
      duration_seconds INTEGER NOT NULL,
      view_count INTEGER NOT NULL,
      like_count INTEGER NOT NULL,
      comment_count INTEGER NOT NULL,
      efficiency_score REAL NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_short INTEGER NOT NULL DEFAULT 0 CHECK (is_short IN (0, 1))
    );
    CREATE INDEX IF NOT EXISTS idx_videos_score ON videos(efficiency_score DESC);
  `);

  const videoColumns = db.prepare("PRAGMA table_info(videos)").all();

  if (!videoColumns.some((column) => column.name === "created_at")) {
    db.exec(`
      BEGIN;
      ALTER TABLE videos ADD COLUMN created_at TEXT;
      UPDATE videos SET created_at = updated_at WHERE created_at IS NULL;
      COMMIT;
    `);
  }

  if (!videoColumns.some((column) => column.name === "is_short")) {
    db.exec(`
      BEGIN;
      ALTER TABLE videos ADD COLUMN is_short INTEGER NOT NULL DEFAULT 0 CHECK (is_short IN (0, 1));
      UPDATE videos SET is_short = CASE WHEN duration_seconds > 0 AND duration_seconds <= 180 THEN 1 ELSE 0 END;
      COMMIT;
    `);
  }
}
