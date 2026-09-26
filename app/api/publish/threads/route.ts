import { NextRequest, NextResponse } from "next/server";
import { publishToThreads } from "@/lib/threads";
import { getAccountToken, listAccounts, recordPublishedPost } from "@/lib/db";
import { hasValidApiKey, hasValidSession, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_CAPTION = 5000;

export async function POST(request: NextRequest) {
  if (!hasValidApiKey(request) && !hasValidSession(request))
    return unauthorized();

  let body: {
    text?: unknown;
    imageUrl?: unknown;
    videoUrl?: unknown;
    accountId?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { text, imageUrl, videoUrl, accountId } = body;
  if (typeof text !== "string" || !text.trim())
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  if (text.length > MAX_CAPTION)
    return NextResponse.json(
      { error: `text exceeds ${MAX_CAPTION} chars` },
      { status: 400 },
    );

  const img =
    typeof imageUrl === "string" && imageUrl.trim() ? imageUrl.trim() : null;
  const vid =
    typeof videoUrl === "string" && videoUrl.trim() ? videoUrl.trim() : null;
  if (!img && !vid)
    return NextResponse.json(
      { error: "imageUrl or videoUrl is required: every post needs media" },
      { status: 400 },
    );
  if (img && vid)
    return NextResponse.json(
      { error: "pass either imageUrl or videoUrl, not both" },
      { status: 400 },
    );
  const media = (img ?? vid)!;
  if (!/^https:\/\//.test(media))
    return NextResponse.json(
      { error: "media URL must be a public https URL" },
      { status: 400 },
    );

  // default to the only enabled Threads account when none is given
  let id = typeof accountId === "number" ? accountId : null;
  if (id === null) {
    const threads = listAccounts().filter(
      (a) => a.platform === "threads" && a.enabled,
    );
    if (threads.length === 0)
      return NextResponse.json(
        { error: "no Threads account connected" },
        { status: 400 },
      );
    if (threads.length > 1)
      return NextResponse.json(
        { error: "accountId required: multiple accounts connected" },
        { status: 400 },
      );
    id = threads[0].id;
  }

  const account = getAccountToken(id);
  if (!account)
    return NextResponse.json(
      { error: `account ${id} not found or disabled` },
      { status: 404 },
    );

  try {
    const ids = await publishToThreads({
      text,
      imageUrl: img ?? undefined,
      videoUrl: vid ?? undefined,
      userId: account.external_id,
      token: account.token,
    });
    const recordId = recordPublishedPost({
      account_id: id,
      caption: text,
      image_url: img,
      video_url: vid,
      external_ids: ids,
    });
    return NextResponse.json({
      published: true,
      id: recordId,
      post_id: ids[0],
      post_ids: ids,
      parts: ids.length,
    });
  } catch (e) {
    return NextResponse.json(
      { published: false, error: String(e) },
      { status: 502 },
    );
  }
}
