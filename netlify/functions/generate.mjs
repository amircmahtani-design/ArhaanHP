// POST /api/generate — validates the request, applies the generation lock and daily limit,
// creates a job and hands it to the background worker. Returns { jobId } immediately.
import { jobs, meta, json } from "../lib/store.mjs";
import { ADVENTURE_TYPES, MOODS } from "../lib/prompts.mjs";

const LOCK_MS = 15 * 60 * 1000; // a stuck job can never block generation for longer than this
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

export default async (req, context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  const passcode = process.env.GENERATE_PASSCODE;
  if (passcode && String(body.passcode || "").trim().toLowerCase() !== passcode.trim().toLowerCase()) {
    return json({ error: "That magic word isn't right. Ask a grown-up for the password.", code: "passcode" }, 401);
  }

  const mock = process.env.MOCK_AI === "1";
  if (!mock && !process.env.ANTHROPIC_API_KEY) {
    return json({ error: "The story engine isn't switched on yet. Add ANTHROPIC_API_KEY in Netlify.", code: "setup" }, 503);
  }

  const options = {
    adventure: pick(body.adventure, Object.keys(ADVENTURE_TYPES), "surprise"),
    alysia: pick(body.alysia, ["yes", "no", "surprise"], "surprise"),
    tito: pick(body.tito, ["yes", "no", "surprise"], "surprise"),
    mood: pick(body.mood, [...MOODS, "surprise"], "surprise"),
    similarTo: typeof body.similarTo === "string" ? body.similarTo.slice(0, 80) : null,
  };

  const m = meta();

  // Generation lock: only one story is written at a time.
  const lock = await m.get("lock", { type: "json" });
  if (lock && Date.now() - lock.at < LOCK_MS) {
    const running = await jobs().get(lock.jobId, { type: "json" });
    if (running && !["done", "failed"].includes(running.status)) {
      return json({ error: "A story is already being written. It will appear in the library shortly.", code: "busy", jobId: lock.jobId }, 409);
    }
  }

  // Rate limit: stories per day (Dubai time), default 10.
  const limit = Number(process.env.DAILY_STORY_LIMIT || 10);
  const day = new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10);
  const countKey = `count-${day}`;
  const count = Number((await m.get(countKey)) || 0);
  if (count >= limit) {
    return json({ error: `That's ${limit} new stories today, the library's daily limit. More adventures tomorrow!`, code: "limit" }, 429);
  }

  const jobId = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await jobs().setJSON(jobId, { id: jobId, status: "queued", options, created_at: new Date().toISOString() });
  await m.setJSON("lock", { jobId, at: Date.now() });
  await m.set(countKey, String(count + 1));

  // Hand off to the background function (up to 15 minutes of run time).
  const origin = new URL(req.url).origin;
  const res = await fetch(`${origin}/.netlify/functions/generate-background`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId }),
  }).catch((e) => ({ ok: false, status: 0, e }));

  if (!res.ok && res.status !== 202) {
    await jobs().setJSON(jobId, { id: jobId, status: "failed", error: "Couldn't start the story writer. Please try again." });
    await m.delete("lock");
    await m.set(countKey, String(count));
    return json({ error: "Couldn't start the story writer. Please try again." }, 502);
  }

  return json({ jobId }, 202);
};

export const config = { path: "/api/generate" };
