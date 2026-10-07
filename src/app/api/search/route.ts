import { NextRequest, NextResponse } from "next/server";
import { searchAndSaveResults } from "@/lib/search";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q") ?? undefined;

  try {
    return NextResponse.json(await searchAndSaveResults(q));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
