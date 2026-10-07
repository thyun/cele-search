import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import ts from "typescript";

test("search continuation preserves results, buffers, query, and retry state", async () => {
  const root = process.cwd();
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "cele-search-test-"));
  const originalFetch = global.fetch;
  const originalKey = process.env.YOUTUBE_API_KEY;
  try {
    for (const name of ["youtube", "search"]) {
      const source = await fs.readFile(path.join(root, "src/lib", `${name}.ts`), "utf8");
      const compiled = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      }).outputText;
      await fs.writeFile(path.join(temporary, `${name}.js`), compiled);
    }
    process.chdir(temporary);
    process.env.YOUTUBE_API_KEY = "test-only-key";
    const { searchAndSaveResults, InvalidSearchCursorError } = await import(
      pathToFileURL(path.join(temporary, "search.js")).href
    );
    let mode = "pages";
    let fail = false;
    const requests = [];
    const publishedAt = new Date(Date.now() - 86400000).toISOString();
    global.fetch = async (input) => {
      const url = new URL(input);
      requests.push(url);
      if (fail) return new Response("Temporary failure", { status: 503 });
      if (url.pathname.endsWith("/search")) {
        let ids;
        let nextPageToken;
        if (mode === "buffer") {
          ids = Array.from({ length: 45 }, (_, i) => `buffer-${i}`);
        } else {
          const token = url.searchParams.get("pageToken");
          ids = token === "page-2" ? ["old", "new", "short"]
            : token === "page-3" ? ["short"] : ["old", "short"];
          nextPageToken = token === "page-2" ? "page-3"
            : token === "page-3" ? undefined : "page-2";
        }
        return Response.json({ items: ids.map((videoId) => ({ id: { videoId } })), nextPageToken });
      }
      const ids = url.searchParams.get("id").split(",");
      assert.ok(ids.length <= 50);
      return Response.json({
        items: ids.map((id) => ({
          id,
          snippet: { title: id, channelTitle: "Test", publishedAt },
          contentDetails: { duration: id === "short" ? "PT3M59S" : "PT4M" },
          statistics: { viewCount: id === "new" ? "200" : "100" },
        })),
      });
    };

    const first = await searchAndSaveResults("  테스트  ");
    assert.deepEqual(first.results.map((v) => v.videoId), ["old"]);
    assert.ok(first.nextCursor);
    assert.equal(first.query, "테스트");
    const searches = requests.filter((url) => url.pathname.endsWith("/search"));
    assert.equal(searches.length, 6);
    assert.ok(searches.some((url) => url.searchParams.get("q") === "테스트 광고"));
    assert.ok(searches.every((url) => url.searchParams.get("maxResults") === "50"));
    const cutoff = searches[0].searchParams.get("publishedAfter");

    fail = true;
    await assert.rejects(searchAndSaveResults(undefined, first.nextCursor), /503/);
    fail = false;
    requests.length = 0;
    const second = await searchAndSaveResults("ignored changed input", first.nextCursor);
    assert.equal(second.query, "테스트");
    assert.deepEqual(second.results.map((v) => v.videoId), ["old", "new"]);
    assert.ok(second.nextCursor);
    assert.ok(requests.filter((url) => url.pathname.endsWith("/search")).every((url) =>
      url.searchParams.get("pageToken") === "page-2" &&
      url.searchParams.get("publishedAfter") === cutoff));
    assert.deepEqual(
      requests.filter((url) => url.pathname.endsWith("/videos")).map((url) => url.searchParams.get("id")),
      ["new"],
    );

    const last = await searchAndSaveResults(undefined, second.nextCursor);
    assert.equal(last.nextCursor, null);
    assert.deepEqual(last.results, second.results);
    const retry = await searchAndSaveResults(undefined, first.nextCursor);
    assert.deepEqual(retry.results.map((v) => v.videoId), ["old", "new"]);
    await assert.rejects(searchAndSaveResults(undefined, "../unsafe"), InvalidSearchCursorError);
    await assert.rejects(
      searchAndSaveResults(undefined, "12345678-1234-4123-8123-123456789012"),
      InvalidSearchCursorError,
    );

    mode = "buffer";
    const buffered = await searchAndSaveResults();
    assert.equal(buffered.query, null);
    assert.equal(buffered.results.length, 20);
    assert.ok(buffered.nextCursor);
    requests.length = 0;
    const bufferedNext = await searchAndSaveResults(undefined, buffered.nextCursor);
    assert.equal(bufferedNext.results.length, 40);
    assert.equal(requests.length, 0);
    const bufferedLast = await searchAndSaveResults(undefined, bufferedNext.nextCursor);
    assert.equal(bufferedLast.results.length, 45);
    assert.equal(new Set(bufferedLast.results.map((v) => v.videoId)).size, 45);
    assert.equal(bufferedLast.nextCursor, null);
    assert.equal(requests.length, 0);
    const saved = JSON.parse(await fs.readFile(bufferedLast.savedFile, "utf8"));
    assert.deepEqual(saved.results, bufferedLast.results);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = originalKey;
    process.chdir(root);
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
