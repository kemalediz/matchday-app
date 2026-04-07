export const config = {
  apiUrl: process.env.MATCHDAY_API_URL || "https://matchday-nine-zeta.vercel.app",
  apiKey: process.env.WHATSAPP_API_KEY || "",
  statusIntervalHours: parseInt(process.env.STATUS_INTERVAL_HOURS || "4"),
};
