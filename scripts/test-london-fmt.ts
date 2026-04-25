import { formatLondon } from "../src/lib/london-time.ts";
const d = new Date("2026-04-28T20:30:00.000Z");
console.log(`UTC ISO: ${d.toISOString()}`);
console.log(`formatLondon EEE 'at' HH:mm: ${formatLondon(d, "EEE 'at' HH:mm")}`);
console.log(`formatLondon HH:mm: ${formatLondon(d, "HH:mm")}`);
console.log(`formatLondon EEEE, d MMM yyyy 'at' HH:mm: ${formatLondon(d, "EEEE, d MMM yyyy 'at' HH:mm")}`);
