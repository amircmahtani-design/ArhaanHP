// GET /api/stories        -> library index (generated stories, newest first)
// GET /api/stories/:id    -> one full story (never regenerated)
import { readIndex, getStory, json } from "../lib/store.mjs";

export default async (req, context) => {
  const id = context.params && context.params.id;
  if (id) {
    const story = await getStory(id);
    return story ? json(story) : json({ error: "Story not found" }, 404);
  }
  return json({ stories: await readIndex() });
};

export const config = { path: ["/api/stories", "/api/stories/:id"] };
