"use client";

import { useState } from "react";
import type { VideoResult } from "@/lib/search";

export interface SearchResponse {
  query: string | null;
  results: VideoResult[];
  nextCursor: string | null;
  error?: string;
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [hours, minutes, seconds].map((v, i) =>
    i === 0 && v === 0 ? null : String(v).padStart(2, "0"),
  );
  return parts.filter((p) => p !== null).join(":");
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat("ko-KR").format(n);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ko-KR", {
    timeZone: "Asia/Seoul",
  });
}

interface SearchFormProps {
  initialQuery?: string;
  initialData?: SearchResponse | null;
  initialError?: string | null;
}

export default function SearchForm({
  initialQuery = "",
  initialData = null,
  initialError = null,
}: SearchFormProps) {
  const today = new Date();
  const sixMonthsAgo = new Date(today);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const toDateInput = (date: Date) => {
    const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
    return kst.toISOString().slice(0, 10);
  };

  const [query, setQuery] = useState(initialQuery);
  const [viewCountMin, setViewCountMin] = useState("30");
  const [viewCountMax, setViewCountMax] = useState("100");
  const [dateFrom, setDateFrom] = useState(toDateInput(sixMonthsAgo));
  const [dateTo, setDateTo] = useState(toDateInput(today));
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [data, setData] = useState<SearchResponse | null>(initialData);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      params.set("viewCountMin", viewCountMin);
      params.set("viewCountMax", viewCountMax);
      params.set("dateFrom", dateFrom);
      params.set("dateTo", dateTo);
      const res = await fetch(`/api/search?${params.toString()}`);
      const json: SearchResponse = await res.json();
      if (!res.ok) {
        throw new Error(json.error ?? "검색에 실패했습니다.");
      }
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.");
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  async function handleLoadMore(e: React.FormEvent) {
    e.preventDefault();
    if (!data?.nextCursor || loadingMore || loading) return;
    setLoadingMore(true);
    setError(null);
    try {
      const params = new URLSearchParams({ cursor: data.nextCursor });
      if (data.query) params.set("q", data.query);
      params.set("viewCountMin", viewCountMin);
      params.set("viewCountMax", viewCountMax);
      params.set("dateFrom", dateFrom);
      params.set("dateTo", dateTo);
      const res = await fetch(`/api/search?${params}`);
      const json: SearchResponse = await res.json();
      if (!res.ok) throw new Error(json.error ?? "추가 검색에 실패했습니다.");
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "추가 검색에 실패했습니다.");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center bg-zinc-50 px-4 py-10 dark:bg-black">
      <main className="w-full max-w-5xl">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
          연예인 광고 컨텐츠 검색
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          최근 6개월 내 수집된 롱폼·쇼츠 영상을 구분 없이, 구독자 수 대비 조회수가
          높은 순으로 20개씩 보여줍니다.
        </p>

        <form action="/" method="get" onSubmit={handleSearch} className="mt-6 space-y-3">
          <input type="hidden" name="search" value="1" />
          <div className="flex gap-2">
            <input
              type="text"
              name="q"
              aria-label="연예인 이름 또는 상품명 (선택 입력)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="연예인 이름 또는 상품명 (선택 입력)"
              className="flex-1 rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-xs text-zinc-600 dark:text-zinc-400">조회수 시작 (만)
              <input type="number" name="viewCountMin" min="0" value={viewCountMin} onChange={(e) => setViewCountMin(e.target.value)} className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50" />
            </label>
            <label className="text-xs text-zinc-600 dark:text-zinc-400">조회수 종료 (만)
              <input type="number" name="viewCountMax" min="0" value={viewCountMax} onChange={(e) => setViewCountMax(e.target.value)} className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50" />
            </label>
            <label className="text-xs text-zinc-600 dark:text-zinc-400">시작일
              <input type="date" name="dateFrom" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50" />
            </label>
            <label className="text-xs text-zinc-600 dark:text-zinc-400">종료일
              <input type="date" name="dateTo" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50" />
            </label>
          </div>
          <button
            type="submit"
            disabled={loading || loadingMore}
            className="rounded-md bg-zinc-900 px-5 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
          >
            {loading ? "검색 중..." : "검색"}
          </button>
        </form>
        <p className="mt-2 text-xs text-zinc-500">
          검색어는 영상/채널 제목에서 찾으며, 비워두면 전체 수집 영상을 보여줍니다.
        </p>
        {loading && (
          <p role="status" className="mt-4 text-sm text-zinc-500">
            수집된 영상에서 검색하고 있습니다.
          </p>
        )}

        {error && (
          <p role="alert" className="mt-4 rounded-md bg-red-50 px-4 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}

        {data && (
          <>
            <p className="mt-6 text-xs text-zinc-500 dark:text-zinc-400">
              결과 {data.results.length}건
            </p>
            <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {data.results.map((video) => (
                <a
                  key={video.videoId}
                  href={video.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm transition hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900"
                >
                  {video.thumbnailUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={video.thumbnailUrl}
                      alt={video.title}
                      className="h-40 w-full object-cover"
                    />
                  )}
                  <div className="flex flex-1 flex-col gap-1 p-3">
                    <h2 className="line-clamp-2 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                      {video.title}
                    </h2>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {video.channelTitle} · {formatDate(video.publishedAt)} ·{" "}
                      {formatDuration(video.durationSeconds)}
                    </p>
                    <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
                      구독자{" "}
                      {video.subscriberCount === null ? "비공개" : formatNumber(video.subscriberCount)} ·
                      조회수 {formatNumber(video.viewCount)}
                    </p>
                    <p className="mt-auto text-xs font-medium text-zinc-900 dark:text-zinc-50">
                      구독자 대비 조회 {video.efficiencyScore.toFixed(1)}배
                    </p>
                  </div>
                </a>
              ))}
            </div>
            {data.results.length === 0 && (
              <p className="mt-6 text-sm text-zinc-500">조건에 맞는 결과가 없습니다.</p>
            )}
            {data.nextCursor ? (
              <form action="/" method="get" onSubmit={handleLoadMore} className="mt-6 text-center">
                <input type="hidden" name="search" value="1" />
                <input type="hidden" name="q" value={data.query ?? ""} />
                <input type="hidden" name="cursor" value={data.nextCursor} />
                <button
                  type="submit"
                  disabled={loading || loadingMore}
                  className="rounded-md border border-zinc-300 px-6 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-800"
                >
                  {loadingMore ? "더 불러오는 중..." : "더보기"}
                </button>
              </form>
            ) : (
              <p className="mt-6 text-center text-sm text-zinc-500">마지막 검색 결과입니다.</p>
            )}
          </>
        )}
      </main>
    </div>
  );
}
