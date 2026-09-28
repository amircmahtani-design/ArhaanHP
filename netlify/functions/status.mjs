// GET /api/status -> what's switched on (no secrets are ever returned)
import { json } from "../lib/store.mjs";

export default async () => json({
  stories: process.env.MOCK_AI === "1" || !!process.env.ANTHROPIC_API_KEY,
  covers: process.env.MOCK_AI !== "1" && !!process.env.OPENAI_API_KEY,
  passcode: !!process.env.GENERATE_PASSCODE,
  testMode: process.env.MOCK_AI === "1",
});

export const config = { path: "/api/status" };
