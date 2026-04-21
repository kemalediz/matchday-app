/**
 * Dry-run: feed Zair's "@M Time should we switch to 5aside? what do
 * you think?" message through the analyser and print what Claude
 * would say — *without* creating a BotJob or posting to the group.
 * Used to verify prompt changes before they go live to players.
 */
const ANALYZE_URL = "https://matchtime.ai/api/whatsapp/analyze";
const GROUP_ID = "447525334985-1607872139@g.us";

async function main() {
  const apiKey = process.env.WHATSAPP_API_KEY;
  if (!apiKey) throw new Error("WHATSAPP_API_KEY not set");

  // Unique waMessageId so the dedupe check doesn't short-circuit.
  const waMessageId = `preview-switch-${Date.now()}`;

  const body = {
    groupId: GROUP_ID,
    history: [],
    messages: [
      {
        waMessageId,
        body: "@M Time should we switch to 5aside? what do you think?",
        authorPhone: "+447930283213", // Kemal — matches DB
        authorName: "Kemal",
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const res = await fetch(ANALYZE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`Status ${res.status}`);
  console.log(text);
  if (!res.ok) process.exit(1);

  const json = JSON.parse(text) as {
    results: Array<{
      intent: string;
      reply: string | null;
      react: string | null;
      reasoning?: string;
    }>;
  };
  const r = json.results[0];
  console.log(`\n--- Verdict ---`);
  console.log(`Intent:    ${r.intent}`);
  console.log(`React:     ${r.react ?? "-"}`);
  console.log(`Reasoning: ${r.reasoning ?? "-"}`);
  console.log(`\n--- Reply ---\n${r.reply ?? "(no reply)"}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
