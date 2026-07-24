# Run Finder — Parcel Run Lookup PWA

An offline-first web app: scan a parcel label, OCR reads the address on your
phone (no server, no internet needed after first install), it fuzzy-matches
the street against your 492-row run list, and shows the run number in big text.

## What's inside
- `index.html`, `styles.css`, `app.js` — the app itself
- `match.js` — the fuzzy street/number-range matching engine
- `streets-data.js` — your CSV, pre-parsed into structured data (embedded, no network calls)
- `vendor/` — Tesseract.js OCR engine (English), bundled locally
- `lang-data/eng.traineddata.gz` — the OCR language model, bundled locally
- `service-worker.js` — caches everything on first load so it works with the phone in flight-mode style / no signal

Total size ~24 MB, almost all of it the one-time OCR engine + language file. That downloads once, then the service worker caches it and every future load is offline.

## Important: PWAs need HTTPS to install
Android/Chrome will only let you "Add to Home Screen" as a proper installable
app (and only let the service worker cache things for offline use) if the site
is served over **HTTPS**. Opening the `index.html` file directly from your
phone's storage won't work for the camera or offline caching. You need to put
these files on a free HTTPS host first. Two easy options, no coding required:

### Option A — GitHub Pages (free, permanent, recommended)
1. Create a free GitHub account if you don't have one: https://github.com/signup
2. Create a new repository (e.g. `run-finder`), public, no README needed.
3. On the repo page, click **Add file → Upload files**, then drag in *every
   file and folder* from this `pwa` folder (keep the folder structure —
   `vendor/`, `lang-data/`, `icons/` etc. need to stay as subfolders).
4. Commit the upload.
5. Go to **Settings → Pages**, under "Build and deployment" set **Source:
   Deploy from a branch**, branch: `main`, folder: `/ (root)`, then Save.
6. After a minute, GitHub shows you a URL like
   `https://yourusername.github.io/run-finder/`. That's your app.

### Option B — Netlify Drop (free, fastest, good for testing)
1. Go to https://app.netlify.com/drop
2. Drag the whole `pwa` folder (or a zip of it) onto the page.
3. It gives you an HTTPS URL immediately (e.g. `random-name.netlify.app`).
4. For something more permanent, create a free Netlify account and it'll keep the site.

## Installing on your Android phone
1. Open the HTTPS URL from Option A or B in **Chrome** on your phone.
2. Allow camera access when prompted (needed to scan labels).
3. Wait for the first scan or app load to finish downloading the OCR engine
   (~24 MB, once — do this on wifi).
4. Tap the Chrome menu (⋮) → **Add to Home screen** / **Install app**.
5. Launch it from your home screen from then on — it opens full-screen like a
   normal app and works with no signal.

## Using it
- **Scan a label**: tap "Scan a label", line the address up in the frame, tap
  the round capture button.
- The app reads the text, fuzzy-matches the street (typo-tolerant), works out
  the correct number range/side of the street, and shows the **run number**
  in big text, with the matched street underneath so you can double-check.
- If it's unsure, it shows "Needs your check" with its best guesses as
  tappable buttons, plus a "Show raw scanned text" toggle so you can see
  exactly what the OCR read.
- "Search streets manually" (from the home screen or the result screen) lets
  you type/search the street list directly and pick the right number range
  yourself — this always works, OCR or no OCR.

## Updating the street/run list later
If your run list changes, re-export the CSV in the same 4-column format and
tell me — I'll regenerate `streets-data.js` and you just re-upload that one
file to your host.

## Notes on accuracy
- OCR is on-device and reasonably good on printed labels, but handwriting or
  glare can trip it up — that's what the manual search is for.
- Odd/even side-of-street ranges, "X only" single numbers, and plain ranges
  are all handled from your CSV. Three rows with non-numeric entries ("Lot 3"
  etc.) can't be auto-matched by number and will always route to manual
  street selection.
