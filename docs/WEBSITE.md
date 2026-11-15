# The aislet.app website

A single static page in `site/`: plain HTML and CSS, one small script, no framework and no build step. It loads nothing from other domains (no web fonts, analytics or cookies), and the whole page with its images and demo video is about 350 KB.

| File | What it is |
|---|---|
| `site/index.html` | The page |
| `site/styles.css` | All the styles. Colours, type and spacing are variables at the top. |
| `site/site.js` | Plays the demo video while it's on screen (unless the visitor has asked for less motion) and shows the Copy button for the install command. The page works without it. |
| `site/img/` | The demo video and screenshots, made from `docs/images/` |
| `site/favicon.*`, `apple-touch-icon.png`, `icon-*.png`, `og.png` | Icons and the link-preview image, made from the app's logo |
| `site/_headers` | Security headers for Cloudflare Pages (a strict Content Security Policy: everything comes from aislet.app itself) |
| `site/404.html` | Shown for any address that doesn't exist |

## See it on your computer

From the project folder:

```bash
python -m http.server 8000 --directory site
```

Then open http://localhost:8000. (Open it through this server rather than double-clicking `index.html`: the page uses paths that start with `/`.)

## Change the images

After new screenshots land in `docs/images/` (`demo.gif`, `summarise-pdf.png`, `settings-ai.png`), or after the logo changes in `scripts/make-icons.py`, run:

```bash
python scripts/make-site-assets.py
```

It rewrites the logo SVGs, icons, `og.png`, the WebP screenshots and `demo.mp4` (needs Pillow and ffmpeg).

## Before it goes live

- **Rename the GitHub repository first.** Every link on the page points to `github.com/latczar/aislet`, including the Windows install command and the APK download. Until `latczar/untethered` is renamed, those links show GitHub's 404 page.
- **Release 1.0.7 before going live.** Both Android buttons download `releases/latest/download/Aislet.apk` directly. Releases up to 1.0.6 named the file `Untethered.apk`, so the buttons only work once a release with `Aislet.apk` is marked Latest.
- **When 1.0.7 is released:** the page says Linux and Mac are "coming in the next version" (in the Windows column and in the FAQ). Replace that with the `install.sh` command from the README.
- The hero shows a rebuilt chat (an example answer that cites Wikipedia), because there's no real screenshot of a library answer yet. A real phone screenshot would be better; it can replace the `<figure class="hero__figure">` block.

## Put it on aislet.app (Cloudflare Pages)

You do the signing in; nothing here needs your password or an API key in a file.

### Option A: upload from the dashboard (quickest, no command line)

1. Sign in at https://dash.cloudflare.com.
2. Go to **Workers & Pages**, then **Create**, then the **Pages** tab, then **Upload assets** (direct upload).
3. Name the project `aislet` and click **Create project**.
4. Drag the `site` folder (`C:\spaceio\ai\assistant-app-site\site`) onto the upload area, then click **Deploy site**. You get a preview address like `aislet.pages.dev`; check it there first.
5. In the project, open **Custom domains**, click **Set up a custom domain**, type `aislet.app` and click **Continue**, then **Activate domain**. Because aislet.app is already on your Cloudflare account, Cloudflare adds the DNS record itself. HTTPS is switched on automatically (it can take a few minutes).
6. Optional: repeat step 5 with `www.aislet.app`.

To update the site later: open the project, click **Create deployment**, and drag the `site` folder again.

### Option B: from the command line with Wrangler

In PowerShell, in `C:\spaceio\ai\assistant-app-site`:

```bash
npx wrangler login
```

That opens your browser so you can sign in to Cloudflare and allow Wrangler. Then:

```bash
npx wrangler pages project create aislet --production-branch main
```

```bash
npx wrangler pages deploy site --project-name aislet --branch main
```

Run the last command again whenever the site changes. Then add the custom domain as in step 5 of option A.

### Option C: deploy automatically from GitHub

Once the `website` branch is merged into `main` and pushed: **Workers & Pages**, **Create**, **Pages**, **Connect to Git**, pick `latczar/aislet`, production branch `main`, framework preset **None**, build command empty, build output directory `site`. Every push to `main` then redeploys the site. A project made with option A or B can't be switched to this later, so pick one.
