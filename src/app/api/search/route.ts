import { NextRequest, NextResponse } from "next/server";
import { InvalidSearchCursorError, InvalidSearchFiltersError, searchVideos } from "@/lib/search";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q") ?? undefined;
  const cursor = request.nextUrl.searchParams.get("cursor") ?? undefined;
  const viewCountMin = request.nextUrl.searchParams.get("viewCountMin");
  const viewCountMax = request.nextUrl.searchParams.get("viewCountMax");
  const dateFrom = request.nextUrl.searchParams.get("dateFrom") ?? undefined;
  const dateTo = request.nextUrl.searchParams.get("dateTo") ?? undefined;

  try {
    return NextResponse.json(await searchVideos(q, cursor, {
      viewCountMin: viewCountMin ? Number(viewCountMin) * 10000 : undefined,
      viewCountMax: viewCountMax ? Number(viewCountMax) * 10000 : undefined,
      dateFrom,
      dateTo,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: message },
      { status: error instanceof InvalidSearchCursorError || error instanceof InvalidSearchFiltersError ? 400 : 500 },
    );
  }
}
