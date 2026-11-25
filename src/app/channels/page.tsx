import Link from "next/link";
import { revalidatePath } from "next/cache";
import { listChannels, setChannelApproved } from "@/lib/search";

export default async function ChannelsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; status?: string; q?: string }>;
}) {
  const params = await searchParams;
  const page = Number(params.page ?? 1);
  const status = params.status === "pending" || params.status === "approved" ? params.status : "all";
  const q = params.q?.trim() ?? "";
  const data = await listChannels(page, 20, status, q);

  async function updateApproval(formData: FormData) {
    "use server";
    const channelId = String(formData.get("channelId") ?? "");
    const isApproved = formData.get("isApproved") === "1";
    await setChannelApproved(channelId, isApproved);
    revalidatePath("/channels");
  }

  const makePageUrl = (nextPage: number) => {
    const next = new URLSearchParams();
    next.set("page", String(nextPage));
    if (status !== "all") next.set("status", status);
    if (q) next.set("q", q);
    return `/channels?${next.toString()}`;
  };

  const formatNumber = (value: number | null) =>
    value === null ? "비공개" : new Intl.NumberFormat("ko-KR").format(value);

  return (
    <div className="flex min-h-screen flex-col items-center bg-zinc-50 px-4 py-10 dark:bg-black">
      <main className="w-full max-w-5xl">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">채널 관리</h1>
          <Link href="/" className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">영상 검색</Link>
        </div>

        <form method="get" className="mt-6 flex flex-wrap gap-2">
          <input name="q" defaultValue={q} placeholder="채널명 검색" className="min-w-52 flex-1 rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
          <select name="status" defaultValue={status} className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            <option value="all">전체</option>
            <option value="pending">승인 대기</option>
            <option value="approved">승인됨</option>
          </select>
          <button type="submit" className="rounded-md bg-zinc-900 px-5 py-2 text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-900">조회</button>
        </form>

        <p className="mt-4 text-sm text-zinc-500">전체 {data.total}개 · {data.page}/{Math.max(data.totalPages, 1)} 페이지</p>

        <div className="mt-3 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          {data.channels.map((channel) => (
            <div key={channel.channelId} className="flex flex-col gap-3 border-b border-zinc-200 p-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between dark:border-zinc-800">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <a href={`https://www.youtube.com/channel/${channel.channelId}`} target="_blank" rel="noopener noreferrer" className="truncate font-semibold text-zinc-900 hover:underline dark:text-zinc-50">{channel.title || "제목 없음"}</a>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${channel.isApproved ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
                    {channel.isApproved ? "승인됨" : "승인 대기"}
                  </span>
                </div>
                <p className="mt-1 text-xs text-zinc-500">구독자 {formatNumber(channel.subscriberCount)} · 발굴 키워드 {channel.discoveredKeyword || "-"}</p>
              </div>
              <form action={updateApproval}>
                <input type="hidden" name="channelId" value={channel.channelId} />
                <input type="hidden" name="isApproved" value={channel.isApproved ? "0" : "1"} />
                <button type="submit" className={`rounded-md px-4 py-2 text-sm font-medium ${channel.isApproved ? "border border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-200" : "bg-green-700 text-white hover:bg-green-800"}`}>
                  {channel.isApproved ? "승인 취소" : "승인"}
                </button>
              </form>
            </div>
          ))}
          {data.channels.length === 0 && <p className="p-6 text-center text-sm text-zinc-500">표시할 채널이 없습니다.</p>}
        </div>

        {data.totalPages > 1 && (
          <nav className="mt-6 flex items-center justify-center gap-2" aria-label="페이지 이동">
            {data.page > 1 && <a href={makePageUrl(data.page - 1)} className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">이전</a>}
            {Array.from({ length: data.totalPages }, (_, i) => i + 1).filter((n) => n === 1 || n === data.totalPages || Math.abs(n - data.page) <= 2).map((n) => (
              <a key={n} href={makePageUrl(n)} aria-current={n === data.page ? "page" : undefined} className={`rounded-md px-3 py-2 text-sm ${n === data.page ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900" : "border border-zinc-300 dark:border-zinc-700"}`}>{n}</a>
            ))}
            {data.page < data.totalPages && <a href={makePageUrl(data.page + 1)} className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700">다음</a>}
          </nav>
        )}
      </main>
    </div>
  );
}
