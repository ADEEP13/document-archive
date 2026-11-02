# Document Archive

A static, free-to-host viewer for one very large PDF (about 2,000 pages, 160 MB).
Visitors can read, zoom, search every page, and share a link to any page, e.g. `https://addon.indevs.in/?page=847`.

```
Visitor → Cloudflare DNS → GitHub Pages (this repo: viewer + search index)
                                  │
                                  └→ Cloudflare Worker (free, tiny CORS/Range proxy)
                                          └→ GitHub Release asset (the 160 MB PDF)
```

## Read this first: the CORS catch

PDF.js runs in the visitor's browser and must be allowed to read the PDF from another domain.
GitHub Release downloads redirect to a storage host that, in my understanding, does not reliably send the
required CORS headers, so the viewer usually cannot read them directly. I could not test your exact URL,
so check it yourself (step 6 below). If it fails, use the included Worker in `workers/`: it is free
(Cloudflare Workers free plan), needs no R2 and no database, and forwards HTTP Range requests so only the
pages being viewed are downloaded. The **Download Original PDF** button always links straight to the GitHub
asset and does not need CORS.

## Project layout

| Path | Purpose |
|---|---|
| `index.html` | Page shell |
| `src/config.js` | **All document metadata and URLs, edit here** |
| `src/app.js` | Wiring, URL handling, keyboard shortcuts, errors |
| `src/viewer.js` | Virtualised PDF.js viewer, zoom, in-page find |
| `src/thumbnails.js` | Virtualised thumbnail sidebar |
| `src/search.js`, `src/search-worker.js` | Whole-document search (runs in a Web Worker) |
| `scripts/extract_pdf_text.py` | Builds the search index with PyMuPDF |
| `public/search-index/` | Generated index (committed to Git) |
| `workers/pdf-proxy.js` | Optional free Cloudflare Worker for CORS + Range |
| `.github/workflows/deploy.yml` | Deploys to GitHub Pages on every push to `main` |
| `CNAME` | `addon.indevs.in` |

## Local development

```bash
python -m http.server 8000      # from the repo root
# open http://localhost:8000/?page=1
```

For local testing, temporarily point `pdfUrl` in `src/config.js` at a local copy (`"document.pdf"` next to
`index.html`; it is git-ignored) and the viewer will work without the Worker. Note that `python -m http.server`
does not support Range requests, so the whole file loads; that is fine locally.

## Setup, step by step

### 1. Create the repository
On GitHub: **New repository** (public), e.g. `document-archive`. Then:

```bash
git init -b main
git add .
git commit -m "Initial site"
git remote add origin https://github.com/YOUR-USER/document-archive.git
git push -u origin main
```

### 2. Enable GitHub Pages
Repository → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
The workflow in `.github/workflows/deploy.yml` then publishes on each push.

### 3. Custom domain
Same page, **Custom domain**: enter `addon.indevs.in`, save, and tick **Enforce HTTPS** once it becomes available.
(When deploying with Actions the `CNAME` file is not what sets the domain, the setting above is.)

### 4. Cloudflare DNS
Cloudflare dashboard → `indevs.in` → **DNS → Add record**:

| Type | Name | Target | Proxy status |
|---|---|---|---|
| CNAME | `addon` | `YOUR-USER.github.io` | **DNS only** (grey cloud) at first |

Wait for GitHub to show "DNS check successful" and issue the certificate. After that you may switch the
record to Proxied (orange cloud) if you want Cloudflare's CDN, but set **SSL/TLS mode to Full** first,
otherwise you get redirect loops.

### 5. Create the Release and upload the PDF
Repository → **Releases → Draft a new release**, tag `v1`, drag the PDF into the assets box
(single files up to 2 GB are allowed), and publish. Rename the file to something simple like `document.pdf`.
Asset URL format:

```
https://github.com/YOUR-USER/document-archive/releases/download/v1/document.pdf
```

### 6. Test whether the direct URL works from a browser
Open your deployed site (or any page on `https://addon.indevs.in`), open DevTools → Console and run:

```js
fetch("PASTE-ASSET-URL", { headers: { Range: "bytes=0-1023" } })
  .then(r => console.log(r.status, r.headers.get("content-range")))
  .catch(e => console.log("Blocked:", e.message))
```

`206` and a `bytes 0-1023/...` value means you can use the GitHub URL directly as `pdfUrl`.
`Blocked` (a CORS error) means do step 7.

### 7. Deploy the CORS/Range proxy (free)
1. Cloudflare dashboard → **Workers & Pages → Create → Create Worker**, name it `pdf-proxy`, deploy the hello-world, then **Edit code**.
2. Paste the contents of `workers/pdf-proxy.js` and deploy.
3. Worker → **Settings → Variables**, add:
   `PDF_URL` = the Release asset URL, `ALLOWED_ORIGINS` = `https://addon.indevs.in` (add `,http://localhost:8000` while testing).
4. Note the Worker address, e.g. `https://pdf-proxy.YOUR-ACCOUNT.workers.dev`.

(CLI alternative: edit `workers/wrangler.toml`, then `cd workers && npx wrangler deploy`.)
The free plan allows 100,000 requests per day, which is plenty for a document that is fetched in ranges.

### 8. Edit `src/config.js`
```js
pdfUrl:      "https://pdf-proxy.YOUR-ACCOUNT.workers.dev/document.pdf", // or the GitHub URL if step 6 passed
downloadUrl: "https://github.com/YOUR-USER/document-archive/releases/download/v1/document.pdf",
title, description, totalPages, fileSize, source, publicationDate
```

### 9. Build the search index
```bash
pip install -r scripts/requirements.txt
python scripts/extract_pdf_text.py document.pdf
```
This writes `public/search-index/manifest.json` and `index-001.json … index-020.json` (100 pages per file).
The script prints the page count and file size to paste into `config.js`.
If it reports that most pages have no text, the PDF is scanned; run `ocrmypdf --skip-text input.pdf searchable.pdf`
first and index `searchable.pdf` (keep uploading the *original* to the Release if you prefer).

Options: `--out DIR`, `--chunk-size N`.

### 10. Deploy
```bash
git add src/config.js public/search-index
git commit -m "Add search index and config"
git push
```
Watch **Actions**; the site is live at `https://addon.indevs.in/` within a minute or two.
To replace the PDF later: upload a new asset (or release), update `pdfUrl`/`downloadUrl`/`PDF_URL`, re-run step 9, push.

## Using the site

- `?page=847` opens page 847; scrolling, the page box, thumbnails and search results all keep the URL in sync. Back/Forward work.
- Invalid values (`?page=0`, `?page=99999`, `?page=abc`) show a message and open the nearest valid page.
- **Search all pages** (header, or Ctrl/Cmd+F) searches the whole document. **Find on this page** (bottom bar) highlights matches on the pages you are looking at. They are deliberately separate.
- Keys: ←/→ previous/next page (when not zoomed sideways or typing), Ctrl/Cmd+F global search, Esc closes panels and the About dialog.

## Performance notes

- **Virtual scrolling.** One tall spacer reserves space for all 2,000 pages, but only the visible pages ±2 exist in the DOM. Pages that scroll away are cancelled and released with `page.cleanup()`.
- **Range loading.** `disableAutoFetch: true` and 512 KB ranges mean only the data for pages you open is downloaded, not 160 MB. This needs a server that supports Range requests (the Worker does).
- **Thumbnails** are virtualised the same way, decoded only after scrolling settles, two at a time, at about 112 px wide.
- **Canvas cap.** Rendering resolution is capped at 12 megapixels per page and a device pixel ratio of 2 to protect phones.
- **Search** loads the index once (about 20 small JSON chunks, gzip-compressed by GitHub Pages, fetched three at a time) inside a Web Worker and scans it there, streaming results back per chunk. A newer query cancels the previous one. Results cap at 1,000 pages per query.
- **Cache busting.** `manifest.json` carries a content hash that is appended to chunk URLs, so a re-indexed document is never served stale.
- **Known limits.** Page slots are sized from page 1, so documents with mixed page sizes are scaled to fit inside that slot. Search is exact-phrase, case-insensitive; phrases split across a line break in the PDF text layer match in global search but not in "Find on this page". PDF.js loads from cdnjs (pinned to 3.11.174); to self-host, copy `pdf.min.js` and `pdf.worker.min.js` into `public/` and update `index.html` and `src/app.js`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "The server did not return the PDF" | CORS or wrong `pdfUrl`. Repeat step 6/7 and check the Worker's `PDF_URL` and `ALLOWED_ORIGINS`. |
| Loading bar climbs to 160 MB | The server ignores Range requests; use the Worker. |
| "The search index has not been published yet" | Step 9 not run or `public/search-index/` not committed. |
| Site shows 404 on the custom domain | DNS not propagated, or the Pages custom domain setting is empty. |
