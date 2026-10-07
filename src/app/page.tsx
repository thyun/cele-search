import SearchForm from "./search-form";
import { searchAndSaveResults } from "@/lib/search";

export default async function Home({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q.trim() : "";
  const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
  if (params.search !== "1") {
    return <SearchForm />;
  }

  let data = null;
  let error = null;
  try {
    data = await searchAndSaveResults(query, cursor);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "검색에 실패했습니다.";
  }

  return (
    <SearchForm initialQuery={data?.query ?? query} initialData={data} initialError={error} />
  );
}
