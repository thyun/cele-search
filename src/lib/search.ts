import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { searchCelebrityAdLongformVideos } from "./youtube";

const RESULTS_DIR = path.join(process.cwd(), "data", "results");

export async function searchAndSaveResults(userQuery?: string) {
  const query = userQuery?.trim() || undefined;
  const results = await searchCelebrityAdLongformVideos({
    userKeyword: query,
    resultCount: 20,
  });
  const savedAt = new Date().toISOString();
  const fileName = `${savedAt.replace(/[:.]/g, "-")}.json`;
  const savedFile = path.join("data", "results", fileName);
  const data = { query: query ?? null, savedAt, savedFile, results };

  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(
    path.join(RESULTS_DIR, fileName),
    JSON.stringify({ query: data.query, savedAt, results }, null, 2),
    "utf-8",
  );
  return data;
}
