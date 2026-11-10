import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { initializeDatabase } from "../scripts/database.mjs";
import { isBroadcaster, isExcludedChannel, removeBroadcasters } from "../scripts/broadcasters.mjs";

test("broadcaster exclusion removes related videos and remembers excluded IDs", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeDatabase(db);
    for (const title of [
      "MBCNEWS", "부산MBC", "KBS WORLD", "SBS 뉴스", "EBS 다큐", "JTBC News",
      "채널A WORLD", "TV조선", "MBN", "YTN star", "연합뉴스TV", "tvN D", "Mnet",
      "KNN 뉴스", "TJB 대전방송", "스브스뉴스",
    ]) assert.equal(isBroadcaster(title), true, title);
    for (const title of ["뉴스리더", "필름그린", "아임뉴비", "mytvnetwork", "Mansi Shukla"]) {
      assert.equal(isBroadcaster(title), false, title);
    }
    db.exec(`
      INSERT INTO channels VALUES ('blocked', '채널A WORLD', 1000, 'uploads', '', '', '');
      INSERT INTO channels VALUES ('keep', 'Test', 1000, 'uploads', '', '', '');
      INSERT INTO videos VALUES ('v', 'blocked', 'Test', '', '', 300, 10, 0, 0, 0.1, '', '', 0);
    `);
    assert.deepEqual(removeBroadcasters(db), { channels: 1, videos: 1 });
    assert.deepEqual(removeBroadcasters(db), { channels: 0, videos: 0 });
    assert.equal(isExcludedChannel(db, "blocked", "새 이름"), true);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM channels").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM videos").get().n, 0);
  } finally {
    db.close();
  }
});

test("database migration backfills Shorts candidates and can run repeatedly", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeDatabase(db);
    db.exec(`
      ALTER TABLE videos DROP COLUMN is_short;
      INSERT INTO channels VALUES ('channel', 'Test', 1000, 'uploads', '', '', '');
    `);
    const insert = db.prepare(`
      INSERT INTO videos VALUES (?, 'channel', 'Test', '', '', ?, 100, 0, 0, 0.1, '', '')
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
    const url = new URL(input);
    const endpoint = url.pathname.split("/").pop();
    const mode = process.argv[2];
    if (mode === "channels" && !["search", "channels"].includes(endpoint)) {
      throw new Error(`Channel batch must not collect videos: ${endpoint}`);
    }
    if (mode === "videos" && !["channels", "playlistItems", "videos"].includes(endpoint)) {
      throw new Error(`Video batch must not discover channels: ${endpoint}`);
    }
    if (endpoint === "search") {
      return Response.json({
        items: [
          { snippet: { channelId: "channel", channelTitle: "Test" } },
          { snippet: { channelId: "discovery-broadcaster", channelTitle: "YTN star" } },
          { snippet: { channelId: "refresh-broadcaster", channelTitle: "Unknown" } },
          { snippet: { channelId: "blocked", channelTitle: "새 이름" } },
        ],
      });
    }
    if (endpoint === "channels") {
      const ids = url.searchParams.get("id").split(",");
      if (ids.includes("blocked") || ids.includes("discovery-broadcaster")) {
        throw new Error("Excluded channel must not be refreshed");
      }
      return Response.json({
        items: ids.map((id) => ({
          id,
          snippet: { title: id === "channel" ? "Test" : "JTBC News" },
          statistics: { subscriberCount: "2000" },
          contentDetails: { relatedPlaylists: { uploads: "uploads" } },
        })),
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
    db.exec(`
      INSERT INTO channels VALUES ('blocked', 'MBCNEWS', 1000, 'uploads', '', '', '');
      INSERT INTO videos VALUES ('blocked-video', 'blocked', 'Test', '', '', 300, 10, 0, 0, 0.1, '', '', 0);
    `);
    const runBatch = (mode) => execFileSync(process.execPath, [
      "--import",
      `data:text/javascript,${encodeURIComponent(`(${installYouTubeMock.toString()})();`)}`,
      "scripts/batch.mjs",
      mode,
      ...(mode === "channels" ? ["--pages=1"] : []),
    ], {
      cwd: process.cwd(),
      env: { ...process.env, DB_PATH: dbPath, YOUTUBE_API_KEY: "test-only" },
      encoding: "utf8",
    });

    assert.match(runBatch("channels"), /refreshed/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM videos").get().n, 0);
    assert.deepEqual(
      db.prepare("SELECT channel_id FROM channels").all().map((row) => row.channel_id),
      ["channel"],
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM excluded_channels").get().n, 2);
    db.exec("UPDATE channels SET subscriber_count = 1, uploads_playlist_id = NULL WHERE channel_id = 'channel'");
    assert.match(runBatch("videos"), /saved 5 videos \(2 Shorts candidates\)/);
    const channel = db.prepare("SELECT subscriber_count, uploads_playlist_id FROM channels WHERE channel_id = 'channel'").get();
    assert.equal(channel.subscriber_count, 2000);
    assert.equal(channel.uploads_playlist_id, "uploads");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM channels").get().n, 1);
    assert.deepEqual(
      db.prepare("SELECT duration_seconds, is_short FROM videos ORDER BY duration_seconds").all()
        .map((row) => [row.duration_seconds, row.is_short]),
      [[1, 1], [180, 1], [181, 0], [239, 0], [240, 0]],
    );
    assert.equal(db.prepare("SELECT efficiency_score FROM videos LIMIT 1").get().efficiency_score, 5);

    db.exec("UPDATE videos SET duration_seconds = 500, is_short = 0 WHERE video_id = 'video-180'");
    runBatch("videos");
    const refreshed = db.prepare("SELECT duration_seconds, is_short FROM videos WHERE video_id = 'video-180'").get();
    assert.equal(refreshed.duration_seconds, 180);
    assert.equal(refreshed.is_short, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM videos").get().n, 5);
  } finally {
    db.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
