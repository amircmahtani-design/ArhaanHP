# Arhaan's Enchanted Chronicles — setup

No terminal needed. Everything is uploaded through the GitHub website and deployed by Netlify.

## What's in here

- `public/` is the website: `index.html` (the whole front end), the favicon set, `site.webmanifest`, the icons, `data/seed-stories.json` (the 7 stories the library starts with), and `assets/art` and `assets/covers` (your painted artwork, converted to lightweight WebP).
- `netlify/functions/` holds the server code. It writes stories with Claude, paints covers with OpenAI, and saves everything. API keys only ever live here, never in the browser.
- `netlify/lib/` holds the shared server code: the story and cover prompts from the build pack, and storage.
- `netlify.toml` and `package.json` tell Netlify how to deploy. There is no build step.

Stories, covers and generation jobs are saved in **Netlify Blobs**. This is storage built into every Netlify site, so no Firebase or database account is needed, and the library is the same on every device.

## Deploy (about 10 minutes)

1. **GitHub.** Create a new repository, for example `arhaans-chronicles`. Choose *Add file → Upload files* and drag in everything from this zip, keeping the folders as they are: `public`, `netlify`, `netlify.toml`, `package.json`, `package-lock.json`. Commit.
2. **Netlify.** Choose *Add new project → Import an existing project → GitHub* and pick the repository. The build settings fill themselves in from `netlify.toml`; leave them alone and deploy.
3. **Add the keys.** Go to *Project configuration → Environment variables* and add the variables in the table below.
4. **Redeploy.** Go to *Deploys → Trigger deploy → Deploy project*. Keys only take effect after a new deploy.

| Variable | Needed? | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | **Required** | Writes the stories (from console.anthropic.com). |
| `OPENAI_API_KEY` | Recommended | Paints each book's cover with `gpt-image-1`. OpenAI requires your organisation to be verified before you can use its image models. Without this key, stories still work and get an illustrated cover drawn by the site. |
| `GENERATE_PASSCODE` | **Strongly recommended** | A "magic word" that has to be typed before a story is generated, so strangers can't spend your API credit. Arhaan's device remembers it after the first time. |
| `DAILY_STORY_LIMIT` | Optional | Maximum new stories per day (Dubai time). Default `10`. |
| `ANTHROPIC_MODEL` | Optional | Default `claude-sonnet-5`. |
| `OPENAI_IMAGE_MODEL` / `OPENAI_IMAGE_QUALITY` | Optional | Defaults `gpt-image-1` / `medium`. Setting quality to `high` gives richer covers at a higher price. |
| `MOCK_AI` | Testing only | Set to `1` to test the whole flow for free: short practice stories are made and no AI is called. Remove it and redeploy to go live. |

## How it works

- **Generate New Story** opens the wizard. The request goes to `/api/generate`. That function checks the passcode, the one-at-a-time lock and the daily limit, then passes the job to a background function, which can run for up to 15 minutes. The page checks progress every few seconds. When the story is ready it appears first on the shelf and opens.
- Before each new story, Claude is given a compact list of every earlier story: title, tags, cast, setting, magical object, problem, obstacle and ending. It is told not to repeat any of them.
- Alysia and Tito are included only when you pick "Yes". "Surprise me" includes them sometimes, and less often if they were in the last few stories.
- Once a story is saved it is never regenerated. Opening it always loads the saved text.
- New covers are painted with your seven seed covers passed to OpenAI as character references, so Arhaan (and Alysia or Tito when they appear) look the same from book to book. If that request fails, the cover is painted without references. If no cover can be painted, the story is still saved and gets a drawn cover in its own colours.

## Good to know

- **Saved Stories** (the bookmark) and the "carry on from page…" position are remembered per device and browser. The stories themselves are available on every device.
- Pages are flowed to fit the screen, so a phone shows more, shorter pages than a laptop. Page numbers adjust to match.
- To remove a story, go to Netlify → *Blobs* → store `stories`. Delete `story/<id>` and remove its entry from `index`. This is rarely needed, so it isn't part of the site itself.
