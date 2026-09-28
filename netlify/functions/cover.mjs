// GET /api/cover/:id -> the story's generated cover image (cached hard; covers never change)
import { covers } from "../lib/store.mjs";

export default async (req, context) => {
  const res = await covers().getWithMetadata(context.params.id, { type: "arrayBuffer" });
  if (!res) return new Response("Not found", { status: 404 });
  return new Response(res.data, {
    headers: {
      "content-type": res.metadata?.contentType || "image/webp",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
};

export const config = { path: "/api/cover/:id" };
