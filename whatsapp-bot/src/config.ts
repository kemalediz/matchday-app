export const config = {
  apiUrl: process.env.MATCHDAY_API_URL || "https://matchday-nine-zeta.vercel.app",
  apiKey: process.env.WHATSAPP_API_KEY || "",
  // How often to poll /api/whatsapp/due-posts per org.
  schedulerIntervalMinutes: parseInt(process.env.SCHEDULER_INTERVAL_MIN || "5"),
};
