import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import ts from "typescript";

test("searchVideos ranks by efficiency, filters by query, and pages with a cursor", async () => {
  const root = process.cwd();
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "cele-search-test-"));
  const originalDbPath = process.env.DB_PATH;
  try {
    const source = await fs.readFile(path.join(root, "src/lib/search.ts"), "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const modulePath = path.join(temporary, "search.mjs");
    await fs.writeFile(modulePath, compiled);

    process.env.DB_PATH = path.join(temporary, "test.db");
    const { searchVideos, InvalidSearchCursorError, SearchDatabaseMissingError } =
      await import(pathToFileURL(modulePath).href);
    assert.throws(() => searchVideos(), SearchDatabaseMissingError);

    const db = new DatabaseSync(process.env.DB_PATH);
    db.exec(`
      CREATE TABLE channels (channel_id TEXT PRIMARY KEY, title TEXT, subscriber_count INTEGER);
      CREATE TABLE videos (video_id TEXT PRIMARY KEY, channel_id TEXT, title TEXT, published_at TEXT,
        thumbnail_url TEXT, duration_seconds INTEGER, view_count INTEGER, like_count INTEGER,
        comment_count INTEGER, efficiency_score REAL);
      INSERT INTO channels VALUES ('C1', '작은채널', 2000), ('C2', '큰채널', NULL);
    `);
    const insert = db.prepare("INSERT INTO videos VALUES (?, ?, ?, ?, NULL, 300, 10, 1, 1, ?)");
    for (let i = 0; i < 25; i++) insert.run(`v${i}`, "C1", `영상 ${i}`, "2026-01-01", i);
    insert.run("pct", "C2", "100% 협찬", "2026-01-01", 100);
    for (const duration of [60, 180, 181, 239, 240]) {
      insert.run(`duration-${duration}`, "C1", "길이 경계값", "2026-01-01", 1000);
      db.prepare("UPDATE videos SET duration_seconds = ? WHERE video_id = ?")
        .run(duration, `duration-${duration}`);
    }
    db.close();

    const first = searchVideos();
    assert.equal(first.results.length, 20);
    assert.equal(first.results[0].videoId, "duration-240");
    assert.equal(first.results[1].videoId, "pct");
    assert.equal(first.results[1].subscriberCount, null);
    assert.equal(first.results[2].videoId, "v24");
    assert.equal(first.nextCursor, "20");

    const second = searchVideos("", first.nextCursor);
    assert.equal(second.results.length, 27);
    assert.deepEqual(
      second.results.filter((v) => v.videoId.startsWith("duration-")).map((v) => v.videoId),
      ["duration-240"],
    );
    assert.equal(second.nextCursor, null);

    assert.deepEqual(searchVideos("100%").results.map((v) => v.videoId), ["pct"]);
    assert.equal(searchVideos("작은채널").results.length, 20);
    assert.equal(searchVideos("없는검색어").results.length, 0);
    assert.throws(() => searchVideos("", "../x"), InvalidSearchCursorError);
  } finally {
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
