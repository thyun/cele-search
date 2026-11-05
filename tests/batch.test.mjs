import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { initializeDatabase } from "../scripts/database.mjs";

test("database migration backfills Shorts candidates and can run repeatedly", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeDatabase(db);
    db.exec(`
      ALTER TABLE videos DROP COLUMN is_short;
      INSERT INTO channels VALUES ('channel', 'Test', 1000, 'uploads', '', '', '');
    `);
    const insert = db.prepare(`
      INSERT INTO videos VALUES (?, 'channel', 'Test', '', '', ?, 100, 0, 0, 0.1, '')
    `);
    for (const duration of [0, 1, 180, 181, 240]) {
      insert.run(`video-${duration}`, duration);
    }

    initializeDatabase(db);
    initializeDatabase(db);
    assert.deepEqual(
      db.prepare("SELECT is_short FROM videos ORDER BY duration_seconds").all()
        .map((row) => row.is_short),
      [0, 1, 1, 0, 0],
    );
    assert.throws(() => db.exec("UPDATE videos SET is_short = 2"), /CHECK constraint/);
  } finally {
    db.close();
  }
});

function installYouTubeMock() {
  const publishedAt = new Date(Date.now() - 86400000).toISOString();
  const durations = [0, 1, 180, 181, 239, 240];
  globalThis.fetch = async (input) => {
    const endpoint = new URL(input).pathname.split("/").pop();
    if (endpoint === "channels") {
      return Response.json({
        items: [{
          id: "channel",
          snippet: { title: "Test" },
          statistics: { subscriberCount: "2000" },
          contentDetails: { relatedPlaylists: { uploads: "uploads" } },
        }],
      });
    }
    if (endpoint === "playlistItems") {
      return Response.json({
        items: durations.map((duration) => ({
          contentDetails: { videoId: `video-${duration}`, videoPublishedAt: publishedAt },
        })),
      });
    }
    if (endpoint === "videos") {
      return Response.json({
        items: durations.map((duration) => ({
          id: `video-${duration}`,
          snippet: { channelId: "channel", title: "Test", publishedAt },
          contentDetails: { duration: `PT${duration}S` },
          statistics: { viewCount: "10000" },
        })),
      });
    }
    throw new Error(`Unexpected API request: ${input}`);
  };
}

test("batch persists short videos and updates duration and classification on rerun", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cele-batch-test-"));
  const dbPath = path.join(temporary, "test.db");
  const db = new DatabaseSync(dbPath);
  try {
    initializeDatabase(db);
    db.exec("INSERT INTO channels VALUES ('channel', 'Test', 2000, 'uploads', '', '', '')");
    const runBatch = () => execFileSync(process.execPath, [
      "--import",
      `data:text/javascript,${encodeURIComponent(`(${installYouTubeMock.toString()})();`)}`,
      "scripts/batch.mjs",
      "--skip-discover",
    ], {
      cwd: process.cwd(),
      env: { ...process.env, DB_PATH: dbPath, YOUTUBE_API_KEY: "test-only" },
      encoding: "utf8",
    });

    assert.match(runBatch(), /saved 5 videos \(2 Shorts candidates\)/);
    assert.deepEqual(
      db.prepare("SELECT duration_seconds, is_short FROM videos ORDER BY duration_seconds").all()
        .map((row) => [row.duration_seconds, row.is_short]),
      [[1, 1], [180, 1], [181, 0], [239, 0], [240, 0]],
    );
    assert.equal(db.prepare("SELECT efficiency_score FROM videos LIMIT 1").get().efficiency_score, 5);

    db.exec("UPDATE videos SET duration_seconds = 500, is_short = 0 WHERE video_id = 'video-180'");
    runBatch();
    const refreshed = db.prepare("SELECT duration_seconds, is_short FROM videos WHERE video_id = 'video-180'").get();
    assert.equal(refreshed.duration_seconds, 180);
    assert.equal(refreshed.is_short, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM videos").get().n, 5);
  } finally {
    db.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
