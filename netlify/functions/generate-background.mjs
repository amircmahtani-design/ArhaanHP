// Background worker (Netlify background function, up to 15 min).
// 1. writes the story with Claude  2. paints the cover with OpenAI  3. saves both  4. marks the job done.
import { jobs, meta, covers, readIndex, saveStory } from "../lib/store.mjs";
import { STORY_SYSTEM_PROMPT, ADVENTURE_TYPES, coverPrompt } from "../lib/prompts.mjs";
import { SEED_FINGERPRINTS } from "../lib/seed-fingerprints.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const MOTIFS = ["compass", "forest", "skyship", "cauldron", "library", "island", "moon", "castle", "key", "dragon"];
const MOTIF_WORDS = {
  compass: ["compass", "map", "mountain", "treasure", "explor"],
  forest: ["forest", "wood", "tree", "grove", "garden"],
  skyship: ["sky", "ship", "flight", "fly", "cloud", "balloon", "clockwork"],
  cauldron: ["potion", "cauldron", "funny", "mishap", "brew", "accident"],
  library: ["library", "book", "school", "corridor", "classroom", "secret room"],
  island: ["sea", "island", "ocean", "lake", "river", "boat", "shore"],
  moon: ["moon", "star", "night", "eclipse", "time", "clock"],
  castle: ["castle", "kingdom", "tower", "palace", "hidden"],
  key: ["key", "door", "lock", "vault", "puzzle"],
  dragon: ["dragon", "creature", "beast", "griffin", "egg"],
};

export default async (req) => {
  let jobId;
  try { ({ jobId } = await req.json()); } catch { return; }
  if (!jobId) return;

  const jobStore = jobs();
  const job = await jobStore.get(jobId, { type: "json" });
  // Only jobs created by /api/generate can run, and only once.
  if (!job || job.status !== "queued") return;

  const update = (patch) => jobStore.setJSON(jobId, { ...job, ...patch, updated_at: new Date().toISOString() });

  try {
    await update({ status: "writing" });
    const index = await readIndex();
    const cast = resolveCast(job.options, index);
    const story = process.env.MOCK_AI === "1"
      ? await mockStory(job.options, cast, index)
      : await writeStory(job.options, cast, index);

    story.id = `${slugify(story.title)}-${Math.random().toString(36).slice(2, 6)}`;
    story.slug = story.id;
    story.created_at = new Date().toISOString();
    story.options = job.options;
    story.cover_motif = chooseMotif(story);
    story.cover_image_url = null;

    await update({ status: "painting", title: story.title });
    try {
      const img = await paintCover(story, new URL(req.url).origin);
      if (img) {
        await covers().set(story.id, img.blob, { metadata: { contentType: img.type } });
        story.cover_image_url = `/api/cover/${story.id}`;
      }
    } catch (e) {
      // The story is still saved; the site draws an illustrated fallback cover instead.
      story.cover_error = String(e.message || e).slice(0, 300);
    }

    await saveStory(story);
    await update({ status: "done", storyId: story.id, title: story.title });
  } catch (e) {
    console.error(e);
    await update({ status: "failed", error: friendly(e) });
  } finally {
    const m = meta();
    const lock = await m.get("lock", { type: "json" });
    if (lock && lock.jobId === jobId) await m.delete("lock");
  }
};

// ---------- cast ----------
function resolveCast(options, index) {
  const recent = index.slice(0, 3);
  const decide = (who, choice) => {
    if (choice === "yes") return true;
    if (choice === "no") return false;
    // "surprise me": sometimes, and less likely if they were in the last few stories
    const recentCount = recent.filter((s) => (s.characters || []).includes(who)).length;
    return Math.random() < Math.max(0.12, 0.4 - recentCount * 0.12);
  };
  return { alysia: decide("Alysia", options.alysia), tito: decide("Tito", options.tito) };
}

// ---------- story ----------
function previousStoriesText(index) {
  const all = [
    ...index.map((s) => ({ title: s.title, tags: s.tags, characters: s.characters, ...(s.fingerprint || {}) })),
    ...SEED_FINGERPRINTS,
  ].slice(0, 60);
  return all
    .map((s, i) => `${i + 1}. "${s.title}" — tags: ${(s.tags || []).join(", ")}; cast: ${(s.characters || []).join(", ")}; setting: ${s.setting || "?"}; object: ${s.magical_object || "?"}; problem: ${s.problem || "?"}; obstacle: ${s.antagonist_or_obstacle || "?"}; ending: ${s.ending || "?"}`)
    .join("\n");
}

function optionsText(options, cast) {
  const lines = [
    `Adventure type: ${ADVENTURE_TYPES[options.adventure]}.`,
    `Mood: ${options.mood === "surprise" ? "your choice — pick one that contrasts with the most recent stories" : options.mood}.`,
    cast.alysia ? "Include Alysia (Arhaan's sister) as a supporting character." : "Do NOT include Alysia in this story.",
    cast.tito ? "Include Tito (Arhaan's uncle) as a supporting character." : "Do NOT include Tito in this story.",
    "Arhaan is the hero. The \"characters\" array must list Arhaan first and only include Alysia/Tito if they appear.",
  ];
  if (options.similarTo) lines.push(`The reader loved "${options.similarTo}". Capture a similar feeling, but with a completely new plot, setting, object and ending.`);
  return lines.join("\n");
}

async function writeStory(options, cast, index) {
  const system = STORY_SYSTEM_PROMPT
    .replace("{{PREVIOUS_STORIES}}", previousStoriesText(index) || "(none yet)")
    .replace("{{USER_OPTIONS}}", optionsText(options, cast));

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(240000),
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
        max_tokens: 12000,
        system,
        messages: [{ role: "user", content: attempt === 0
          ? "Write Arhaan's next adventure now. Return only the JSON object."
          : "Write Arhaan's next adventure now. Return only the JSON object — it must parse, and it must have between 8 and 12 pages." }],
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      lastErr = new Error(`Story API ${res.status}: ${t.slice(0, 300)}`);
      if (res.status === 401 || res.status === 403 || res.status === 404) break;
      continue;
    }
    const data = await res.json();
    const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    try {
      return normaliseStory(parseJSON(text));
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("Story generation failed");
}

function parseJSON(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("No JSON in story response");
  return JSON.parse(text.slice(start, end + 1));
}

function normaliseStory(raw) {
  const pages = (raw.pages || [])
    .filter((p) => p && typeof p.text === "string" && p.text.trim())
    .map((p, i) => ({
      page_number: i + 1,
      heading: p.heading ? String(p.heading) : undefined,
      text: String(p.text).trim(),
      illustration_prompt: p.illustration_prompt ? String(p.illustration_prompt) : undefined,
      illustration_url: null,
    }));
  if (!raw.title || pages.length < 6) throw new Error("Story came back incomplete");
  let characters = Array.isArray(raw.characters) ? raw.characters.map(String) : [];
  characters = ["Arhaan", ...characters.filter((c) => c !== "Arhaan")];
  return {
    title: String(raw.title).slice(0, 120),
    subtitle: String(raw.subtitle || "An Arhaan Adventure").slice(0, 160),
    short_summary: String(raw.short_summary || "").slice(0, 600),
    characters,
    tags: (Array.isArray(raw.tags) ? raw.tags : []).map((t) => String(t).toLowerCase()).slice(0, 6),
    cover_prompt: String(raw.cover_prompt || ""),
    fingerprint: raw.fingerprint && typeof raw.fingerprint === "object" ? raw.fingerprint : {},
    pages,
  };
}

// ---------- cover ----------
// The seven painted seed covers double as character references, so every new cover keeps
// Arhaan (and Alysia / Tito when they appear) looking like the same people.
const CHARACTER_REFS = {
  Arhaan: { file: "/assets/covers/lost-compass-valmora.webp", note: "the dark-haired boy in the dark cloak with emerald and silver trim is Arhaan" },
  Alysia: { file: "/assets/covers/whispering-woods.webp", note: "the girl with long dark wavy hair in the violet cloak is his sister Alysia" },
  Tito: { file: "/assets/covers/titos-magical-mishap.webp", note: "the cheerful man with curly hair and a moustache is his uncle Tito" },
};
async function paintCover(story, origin) {
  if (process.env.MOCK_AI === "1" || !process.env.OPENAI_API_KEY) return null;
  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  const quality = process.env.OPENAI_IMAGE_QUALITY || "medium";
  const cast = (story.characters || []).filter((c) => CHARACTER_REFS[c]);
  let prompt = coverPrompt({ title: story.title, summary: story.short_summary, coverPrompt: story.cover_prompt });
  const auth = { authorization: `Bearer ${process.env.OPENAI_API_KEY}` };

  // 1) with character reference images (keeps faces consistent across the library)
  try {
    const base = process.env.URL || origin;
    const refs = [];
    for (const c of cast) {
      const bytes = await loadRef(CHARACTER_REFS[c].file, base);
      if (bytes) refs.push({ c, blob: new Blob([bytes], { type: "image/webp" }) });
    }
    if (refs.length) {
      const fd = new FormData();
      fd.append("model", model);
      fd.append("prompt", `${prompt}\n\nThe reference images show how the characters look: ${refs.map((x) => CHARACTER_REFS[x.c].note).join("; ")}. Keep their faces, hair and clothing consistent with the references, but paint a completely new scene, setting and composition for THIS story. Do not copy the reference backgrounds, poses or layouts.`);
      refs.forEach((x, i) => fd.append("image[]", x.blob, `ref-${i}.webp`));
      fd.append("size", "1024x1536");
      fd.append("quality", quality);
      fd.append("output_format", "webp");
      fd.append("output_compression", "82");
      fd.append("input_fidelity", "high");
      const res = await fetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: auth, body: fd, signal: AbortSignal.timeout(180000) });
      if (res.ok) { const img = await readImage(await res.json()); if (img) return img; }
      else console.warn("Cover with references failed:", res.status, (await res.text()).slice(0, 200));
    }
  } catch (e) { console.warn("Cover with references failed:", e); }

  // 2) plain generation as a fallback
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ model, prompt, size: "1024x1536", quality, output_format: "webp", output_compression: 82, n: 1 }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`Image API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const img = await readImage(await res.json());
  if (!img) throw new Error("Image API returned no image");
  return img;
}
// Reference covers are bundled with the function (netlify.toml included_files); fetching them
// from the live site is only a fallback, e.g. when running locally.
async function loadRef(file, base) {
  const rel = path.join("public", file);
  for (const root of [process.env.LAMBDA_TASK_ROOT, process.cwd(), path.resolve(".")].filter(Boolean)) {
    try { return await readFile(path.join(root, rel)); } catch {}
  }
  try { const r = await fetch(base + file, { signal: AbortSignal.timeout(15000) }); if (r.ok) return Buffer.from(await r.arrayBuffer()); } catch {}
  return null;
}
async function readImage(data) {
  const item = data.data && data.data[0];
  if (item && item.b64_json) {
    const buf = Buffer.from(item.b64_json, "base64");
    const type = buf.slice(0, 4).toString() === "RIFF" ? "image/webp" : buf[0] === 0x89 ? "image/png" : "image/jpeg";
    return { blob: new Blob([buf], { type }), type };
  }
  if (item && item.url) {
    const r = await fetch(item.url);
    const type = r.headers.get("content-type") || "image/png";
    return { blob: new Blob([await r.arrayBuffer()], { type }), type };
  }
  return null;
}

function chooseMotif(story) {
  const hay = [story.title, story.short_summary, ...(story.tags || []), story.fingerprint?.setting, story.fingerprint?.magical_object]
    .join(" ").toLowerCase();
  let best = null, bestScore = 0;
  for (const m of MOTIFS) {
    const score = MOTIF_WORDS[m].reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
    if (score > bestScore) { best = m; bestScore = score; }
  }
  return best || MOTIFS[Math.floor(Math.random() * MOTIFS.length)];
}

// ---------- helpers ----------
function slugify(s) {
  return String(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "story";
}

function friendly(e) {
  const msg = String(e && e.message || e);
  if (/401|403|invalid.*key|authentication/i.test(msg)) return "The story engine's key was rejected. Check ANTHROPIC_API_KEY in Netlify.";
  if (/429|overloaded|529/i.test(msg)) return "The story engine is very busy right now. Please try again in a minute.";
  return "The ink got smudged and the story couldn't be finished. Please try again.";
}

// ---------- test mode (MOCK_AI=1): no API calls, lets you test the whole flow for free ----------
async function mockStory(options, cast, index) {
  await new Promise((r) => setTimeout(r, 2500));
  const n = index.length + 1;
  const characters = ["Arhaan", ...(cast.alysia ? ["Alysia"] : []), ...(cast.tito ? ["Tito"] : [])];
  const pages = Array.from({ length: 9 }, (_, i) => ({
    page_number: i + 1,
    heading: ["A Knock at Midnight", "The Silver Thread", "Down the Spiral Stair", "A Door That Hummed", "The Riddle of Glass", "Arhaan's Plan", "A Small Mistake", "The Turn of the Key", "Home by Candlelight"][i],
    text: `This is test story number ${n}, page ${i + 1}. Arhaan${cast.alysia ? ", with Alysia close behind," : ""}${cast.tito ? " and Uncle Tito" : ""} followed the silver thread deeper into Mirecastle, counting every step.\n\n"Adventure type: ${options.adventure}. Mood: ${options.mood}," he whispered, because in test mode even the castle knows it is only practising.\n\nThe candles leaned in to listen, and the story went on.`,
  }));
  return {
    title: `The Test of the Silver Thread ${n}`,
    subtitle: "A practice adventure (test mode)",
    short_summary: "A short practice story used to test the library without calling the AI.",
    characters,
    tags: ["test", options.adventure, options.mood],
    cover_prompt: "",
    fingerprint: { setting: "test", magical_object: "silver thread", problem: "test", antagonist_or_obstacle: "test", ending: "test" },
    pages,
  };
}
