/**
 * Manual batch: discover channels via search.list, then collect each channel's
 * recent longform videos and rank them by views relative to subscribers.
 *
 * Usage: npm run batch -- [--pages=2] [--keyword=추가키워드] [--skip-discover]
 *
 * Quota (units): search.list 100/call, channels.list 1/50 channels,
 * playlistItems.list 1/channel, videos.list 1/50 videos.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const API = "https://www.googleapis.com/youtube/v3";
const DB_PATH = process.env.DB_PATH ?? path.join("data", "cele-search.db");
const SIX_MONTHS_MS = 1000 * 60 * 60 * 24 * 30 * 6;
const LONGFORM_MIN_SECONDS = 4 * 60;
const MIN_SUBSCRIBERS = 1000; // floor so tiny/hidden-sub channels don't explode the ratio
const DEFAULT_KEYWORDS = [
  "연예인 광고",
  "셀럽 PPL",
  "스타 협찬",
  "연예인 신제품 광고",
  "아이돌 광고 촬영",
];

const args = process.argv.slice(2);
const pages = Number(
  args.find((a) => a.startsWith("--pages="))?.split("=")[1] ?? 2,
);
const extraKeywords = args
  .filter((a) => a.startsWith("--keyword="))
  .map((a) => a.slice("--keyword=".length).trim())
  .filter(Boolean);
const skipDiscover = args.includes("--skip-discover");

const apiKey = process.env.YOUTUBE_API_KEY;
if (!apiKey || apiKey === "your_youtube_data_api_v3_key_here") {
  console.error("YOUTUBE_API_KEY is not set. Add it to .env first.");
  process.exit(1);
}

let quota = 0;
async function call(endpoint, params, cost) {
  const qs = new URLSearchParams({ key: apiKey, ...params });
  const res = await fetch(`${API}/${endpoint}?${qs}`);
  if (!res.ok) {
    throw new Error(`${endpoint} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  quota += cost;
  return res.json();
}

function parseDuration(iso) {
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
}

const chunk = (arr, size) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
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
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_videos_score ON videos(efficiency_score DESC);
`);

const now = new Date().toISOString();
const cutoff = new Date(Date.now() - SIX_MONTHS_MS).toISOString();

async function discoverChannels() {
  const keywords = [...extraKeywords.map((k) => `${k} 광고`), ...DEFAULT_KEYWORDS];
  const found = new Map(); // channelId -> keyword
  for (const keyword of keywords) {
    let pageToken;
    for (let i = 0; i < pages; i++) {
      const params = {
        q: keyword, part: "snippet", type: "video", order: "viewCount",
        publishedAfter: cutoff, maxResults: "50", relevanceLanguage: "ko",
      };
      if (pageToken) params.pageToken = pageToken;
      const data = await call("search", params, 100);
      for (const item of data.items ?? []) {
        const id = item.snippet?.channelId;
        if (id && !found.has(id)) found.set(id, keyword);
      }
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    console.log(`discovered via "${keyword}": ${found.size} channels so far`);
  }
  const insert = db.prepare(
    `INSERT INTO channels (channel_id, title, discovered_keyword, discovered_at, updated_at)
     VALUES (?, '', ?, ?, ?) ON CONFLICT(channel_id) DO NOTHING`,
  );
  for (const [id, keyword] of found) insert.run(id, keyword, now, now);
}

async function refreshChannels() {
  const ids = db.prepare("SELECT channel_id FROM channels").all().map((r) => r.channel_id);
  const update = db.prepare(
    `UPDATE channels SET title = ?, subscriber_count = ?, uploads_playlist_id = ?, updated_at = ?
     WHERE channel_id = ?`,
  );
  for (const batch of chunk(ids, 50)) {
    const data = await call(
      "channels", { id: batch.join(","), part: "snippet,statistics,contentDetails" }, 1,
    );
    for (const ch of data.items ?? []) {
      const subs = ch.statistics?.hiddenSubscriberCount
        ? null
        : Number(ch.statistics?.subscriberCount ?? 0);
      update.run(
        ch.snippet?.title ?? "", subs,
        ch.contentDetails?.relatedPlaylists?.uploads ?? null, now, ch.id,
      );
    }
  }
  console.log(`refreshed ${ids.length} channels`);
}

async function collectVideos() {
  const channels = db
    .prepare("SELECT channel_id, subscriber_count, uploads_playlist_id FROM channels WHERE uploads_playlist_id IS NOT NULL")
    .all();
  const subsByChannel = new Map(channels.map((c) => [c.channel_id, c.subscriber_count]));

  const videoIds = [];
  for (const ch of channels) {
    try {
      const data = await call(
        "playlistItems",
        { playlistId: ch.uploads_playlist_id, part: "contentDetails", maxResults: "30" },
        1,
      );
      for (const item of data.items ?? []) {
        const published = item.contentDetails?.videoPublishedAt;
        if (published && published >= cutoff) videoIds.push(item.contentDetails.videoId);
      }
    } catch (error) {
      console.warn(`skip channel ${ch.channel_id}: ${error.message}`);
    }
  }

  const upsert = db.prepare(
    `INSERT INTO videos (video_id, channel_id, title, published_at, thumbnail_url, duration_seconds,
       view_count, like_count, comment_count, efficiency_score, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(video_id) DO UPDATE SET
       title = excluded.title, thumbnail_url = excluded.thumbnail_url,
       view_count = excluded.view_count, like_count = excluded.like_count,
       comment_count = excluded.comment_count, efficiency_score = excluded.efficiency_score,
       updated_at = excluded.updated_at`,
  );
  let saved = 0;
  for (const batch of chunk([...new Set(videoIds)], 50)) {
    const data = await call(
      "videos", { id: batch.join(","), part: "snippet,contentDetails,statistics" }, 1,
    );
    for (const v of data.items ?? []) {
      const duration = parseDuration(v.contentDetails?.duration ?? "");
      if (duration < LONGFORM_MIN_SECONDS) continue;
      const views = Number(v.statistics?.viewCount ?? 0);
      const subs = Math.max(subsByChannel.get(v.snippet.channelId) ?? 0, MIN_SUBSCRIBERS);
      upsert.run(
        v.id, v.snippet.channelId, v.snippet.title, v.snippet.publishedAt,
        v.snippet.thumbnails?.medium?.url ?? v.snippet.thumbnails?.default?.url ?? "",
        duration, views, Number(v.statistics?.likeCount ?? 0),
        Number(v.statistics?.commentCount ?? 0), views / subs, now,
      );
      saved++;
    }
  }
  const pruned = db.prepare("DELETE FROM videos WHERE published_at < ?").run(cutoff);
  console.log(`saved ${saved} longform videos, pruned ${pruned.changes} old ones`);
}

if (!skipDiscover) await discoverChannels();
await refreshChannels();
await collectVideos();
console.log(`done. estimated quota used: ${quota} units. db: ${DB_PATH}`);
db.close();
