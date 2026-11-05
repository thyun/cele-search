import { NextRequest, NextResponse } from "next/server";
import { InvalidSearchCursorError, searchVideos } from "@/lib/search";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q") ?? undefined;
  const cursor = request.nextUrl.searchParams.get("cursor") ?? undefined;

  try {
    return NextResponse.json(searchVideos(q, cursor));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: message },
      { status: error instanceof InvalidSearchCursorError ? 400 : 500 },
    );
  }
}
