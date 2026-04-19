/**
 * Quick diagnostic: takes a magic-link token on argv[2] and tells you
 * whether it verifies against the *current* AUTH_SECRET. Prints the
 * decoded payload either way so you can see exp / userId / matchId.
 */
import { verifyMagicLinkToken } from "../src/lib/magic-link.ts";

async function main() {
  const token = process.argv[2];
  if (!token) {
    console.error("usage: tsx scripts/verify-token.ts <token>");
    process.exit(1);
  }

  const secret = process.env.AUTH_SECRET;
  console.log(`AUTH_SECRET loaded: ${secret ? "yes (len=" + secret.length + ")" : "NO"}`);
  console.log(`Token length:       ${token.length}`);

  // Peek at the payload without verification.
  try {
    const body = token.split(".")[0];
    const padded =
      body.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (body.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    console.log(`Payload:            ${JSON.stringify(payload)}`);
    const nowSec = Math.floor(Date.now() / 1000);
    console.log(`exp:                ${payload.exp} (now=${nowSec}, in ${payload.exp - nowSec}s)`);
  } catch (e) {
    console.log(`Payload peek failed: ${e}`);
  }

  const result = await verifyMagicLinkToken(token);
  console.log(`\nverifyMagicLinkToken → ${result ? "✅ VALID" : "❌ INVALID"}`);
  if (result) console.log(`  → ${JSON.stringify(result)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
