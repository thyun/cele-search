import SearchForm from "./search-form";
import { searchVideos } from "@/lib/search";

export default async function Home({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q.trim() : "";
  const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
  const viewCountMin = typeof params.viewCountMin === "string" ? Number(params.viewCountMin) : undefined;
  const viewCountMax = typeof params.viewCountMax === "string" ? Number(params.viewCountMax) : undefined;
  const dateFrom = typeof params.dateFrom === "string" ? params.dateFrom : undefined;
  const dateTo = typeof params.dateTo === "string" ? params.dateTo : undefined;
  if (params.search !== "1") {
    return <SearchForm />;
  }

  let data = null;
  let error = null;
  try {
    data = await searchVideos(query, cursor, {
      viewCountMin: viewCountMin === undefined ? 300_000 : viewCountMin * 10_000,
      viewCountMax: viewCountMax === undefined ? 1_000_000 : viewCountMax * 10_000,
      dateFrom,
      dateTo,
    });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "검색에 실패했습니다.";
  }

  return (
    <SearchForm initialQuery={data?.query ?? query} initialData={data} initialError={error} />
  );
}
