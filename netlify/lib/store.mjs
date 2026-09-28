// Persistence: Netlify Blobs (built into every Netlify site, no setup needed).
// stories  -> "story/<id>" full story JSON, "index" list of summaries (newest first)
// covers   -> "<id>" cover image bytes
// jobs     -> "<jobId>" generation job status
// meta     -> "lock" generation lock, "count-YYYY-MM-DD" daily counter
import { getStore } from "@netlify/blobs";

const strong = (name) => getStore({ name, consistency: "strong" });

export const stories = () => strong("stories");
export const covers = () => strong("covers");
export const jobs = () => strong("jobs");
export const meta = () => strong("meta");

export async function readIndex() {
  return (await stories().get("index", { type: "json" })) || [];
}

export async function getStory(id) {
  return stories().get(`story/${id}`, { type: "json" });
}

export async function saveStory(story) {
  const s = stories();
  await s.setJSON(`story/${story.id}`, story);
  const index = (await s.get("index", { type: "json" })) || [];
  const summary = toSummary(story);
  const next = [summary, ...index.filter((x) => x.id !== story.id)];
  await s.setJSON("index", next);
  return summary;
}

export function toSummary(story) {
  const { pages, cover_prompt, ...rest } = story;
  return rest;
}

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
