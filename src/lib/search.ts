import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { searchCelebrityAdLongformVideos } from "./youtube";
import type { SearchContinuation, YoutubeSearchResult } from "./youtube";

const RESULTS_DIR = path.join(process.cwd(), "data", "results");

const PAGE_SIZE = 20;

interface SearchSnapshot {
  query: string | null;
  results: YoutubeSearchResult[];
  pending: YoutubeSearchResult[];
  continuation: SearchContinuation;
}

export class InvalidSearchCursorError extends Error {
  constructor() {
    super("검색 기록을 찾을 수 없습니다. 다시 검색해주세요.");
  }
}

export async function searchAndSaveResults(userQuery?: string, cursor?: string) {
  let state: SearchSnapshot;
  if (cursor) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursor)) {
      throw new InvalidSearchCursorError();
    }
    try {
      state = JSON.parse(await readFile(path.join(RESULTS_DIR, `${cursor}.json`), "utf-8"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new InvalidSearchCursorError();
      }
      throw error;
    }
  } else {
    const query = userQuery?.trim() || null;
    const page = await searchCelebrityAdLongformVideos({ userKeyword: query ?? undefined });
    state = { query, results: [], pending: page.results, continuation: page.continuation };
  }

  // Each click fetches at most one page per active keyword to bound quota usage.
  if (cursor && state.pending.length < PAGE_SIZE &&
      state.continuation.keywords.some((entry) => entry.pageToken !== null)) {
    const page = await searchCelebrityAdLongformVideos({ continuation: state.continuation });
    state.pending.push(...page.results);
    state.pending.sort((a, b) => b.hotScore - a.hotScore);
    state.continuation = page.continuation;
  }
  state.results.push(...state.pending.splice(0, PAGE_SIZE));
  const hasMore = state.pending.length > 0 ||
    state.continuation.keywords.some((entry) => entry.pageToken !== null);
  const savedAt = new Date().toISOString();
  const id = randomUUID();
  const fileName = `${id}.json`;
  const savedFile = path.join("data", "results", fileName);
  const data = {
    query: state.query, savedAt, savedFile, results: state.results,
    nextCursor: hasMore ? id : null,
  };

  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(
    path.join(RESULTS_DIR, fileName),
    JSON.stringify({ ...state, savedAt }, null, 2),
    "utf-8",
  );
  return data;
}
