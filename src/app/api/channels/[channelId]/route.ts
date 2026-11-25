import { NextRequest, NextResponse } from "next/server";
import { setChannelApproved } from "@/lib/search";

export async function POST(request: NextRequest, { params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  try {
    const body = await request.json() as { isApproved?: boolean };
    if (typeof body.isApproved !== "boolean") {
      return NextResponse.json({ error: "승인 상태가 올바르지 않습니다." }, { status: 400 });
    }
    await setChannelApproved(channelId, body.isApproved);
    return NextResponse.json({ channelId, isApproved: body.isApproved });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "승인 상태 변경에 실패했습니다." },
      { status: 500 },
    );
  }
}
