/**
 * TEMPORARY DIAGNOSTIC — remove after debugging the matchtime.ai
 * magic-link verification issue.
 *
 * Returns a safe fingerprint of the current AUTH_SECRET (SHA256 first
 * 12 chars, hex) plus the verification verdict for a token passed on
 * the query string. No secret material leaks; no auth required because
 * the only thing exposed is a hash prefix and a verdict.
 *
 * Usage:
 *   GET /api/debug/magic-link?t=<token>
 */
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { verifyMagicLinkToken } from "@/lib/magic-link";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("t");

  const secret = process.env.AUTH_SECRET ?? "";
  const hash = createHash("sha256").update(secret).digest("hex").slice(0, 12);

  const info: Record<string, unknown> = {
    auth_secret_sha256_12: hash,
    auth_secret_len: secret.length,
    has_trailing_whitespace: /\s$/.test(secret),
    now: Math.floor(Date.now() / 1000),
  };

  if (token) {
    const result = await verifyMagicLinkToken(token);
    info.token_valid = !!result;
    if (result) info.payload = result;

    // Also peek at the unverified payload so we can see expected exp.
    try {
      const body = token.split(".")[0];
      const padded =
        body.replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - (body.length % 4)) % 4);
      info.payload_unverified = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    } catch {
      info.payload_unverified = null;
    }
  }

  return NextResponse.json(info);
}
