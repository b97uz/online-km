import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const all: Record<string, string> = {};
  req.headers.forEach((v, k) => { all[k] = v; });

  return NextResponse.json({
    url: req.url,
    host: req.headers.get("host"),
    "x-forwarded-host": req.headers.get("x-forwarded-host"),
    "x-forwarded-proto": req.headers.get("x-forwarded-proto"),
    allHeaders: all,
  });
}
