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
- The hero shows a rebuilt chat (an example answer that cites Wikipedia), because there's no real screenshot of a library answer yet. A real phone screenshot would be better; it can replace the `<figure class="hero__figure">` block.

## How it's hosted

aislet.app is a Cloudflare Worker called `aislet` that serves the `site/` folder as static files (no server code). The settings are in `deploy/wrangler.jsonc`, including the custom domain aislet.app. It was first deployed on 16 Nov 2026.

### Update the live site

Wrangler is already signed in on Lattrell's laptop. From the project folder:

```bash
npx wrangler deploy --config deploy/wrangler.jsonc
```

It uploads only the files that changed, and the site updates within seconds. Add `--dry-run` to check first. To sign in on another computer, run `npx wrangler login` first.

Don't run `wrangler pages project create` in this repository: newer Wrangler versions try to turn the whole app into a Workers project, edit `package.json` and run `npm install`.

### Cloudflare's own analytics stays off

New Cloudflare domains add a Real User Monitoring script (from `static.cloudflareinsights.com`) to every page. For aislet.app it was switched off on 16 Nov 2026: in the dashboard, the **aislet.app** domain, **Speed**, **Real user monitoring**, **Disable completely**. If it ever comes back, the site's Content Security Policy (in `site/_headers`) still blocks it, so nothing is sent; it would only show as an error in the browser console.
