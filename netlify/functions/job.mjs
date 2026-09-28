// GET /api/job/:id -> { status: queued|writing|painting|done|failed, storyId?, error? }
import { jobs, json } from "../lib/store.mjs";

export default async (req, context) => {
  const job = await jobs().get(context.params.id, { type: "json" });
  if (!job) return json({ error: "Job not found" }, 404);
  const { status, storyId, error, title } = job;
  return json({ status, storyId, error, title });
};

export const config = { path: "/api/job/:id" };
