# Pixieset to Cloud Storage Migrator

Chrome extension that migrates authenticated **Pixieset / Pic-Time** gallery data to cloud storage. It orchestrates fetching collections and photos from Pixieset, creates albums in a backend service, and uploads images to Google Cloud Storage.

## What it does

- **Authentication:** Uses your existing Pixieset session (cookies) when you're logged in at [galleries.pixieset.com](https://galleries.pixieset.com).
- **Collections:** Lists your galleries/collections via the Pixieset dashboard API and fetches full metadata per collection.
- **Backend:** Talks to a Cloud Run backend (`pixie-set-backend`) to create albums and obtain signed upload URLs.
- **Upload:** Uploads photos directly to Google Cloud Storage using those signed URLs.
- **State:** Saves migration progress (profile, collections, summary, pause state) so you can resume after closing the browser or restarting.

## Project structure

| Path | Role |
|------|------|
| `popup/` | Popup UI (HTML/CSS/TS) — start migration, view progress, pause/resume |
| `background/` | Service worker — orchestrates API calls, uploads, and state |
| `services/` | `pixieset.api.ts` (Pixieset APIs), `backend.api.ts` (backend API client) |
| `utils/` | Retry, sleep helpers |

---

## Setup

1. **Prerequisites:** Node.js (v18+ recommended) and npm.

2. **Install dependencies:**
   ```bash
   cd chrome-extension
   npm install
   ```

3. **Update backend config:** In `services/backend.api.ts`, set your backend URL and auth token:
   - `BACKEND_BASE_URL` — your Cloud Run (or other) backend base URL
   - `AUTH_TOKEN` — the token used to authenticate requests to the backend  
   Replace the default values before building/running the extension.

4. **Build the extension:**
   ```bash
   npm run build
   ```
   TypeScript is compiled into the `dist/` folder. Use `npm run watch` for continuous build during development.

---

## Run / Load in Chrome

1. Build the extension (see above) so `dist/` is up to date.
2. Open Chrome and go to **chrome://extensions/**.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the **`chrome-extension`** folder (the one that contains `manifest.json` and `dist/`).
5. The extension icon appears in the toolbar. Click it to open the popup and start a migration (ensure you’re logged in to Pixieset in the same browser).

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript → `dist/` |
| `npm run watch` | Compile in watch mode |
| `npm run clean` | Remove `dist/` |

---

## IndexedDB storage persistence

Migration state (profile, collections, summary, pause state) is stored in **IndexedDB** via `stateStore.ts`. The database name is `pixiesetMigrator` with object stores `profile` and `collections`.

### Where the data lives

- **Database:** `pixiesetMigrator`
- **Stores:** `profile`, `collections`
- **Origin:** Extension origin (`chrome-extension://<extension-id>/`)

| Question | Answer |
|----------|--------|
| **How long does it stay?** | Until the extension is uninstalled, its data is cleared, or the extension ID changes. No TTL. |
| **When does it get removed?** | Uninstall, clearing that extension's site data, or (effectively) a new extension ID. |
| **Survives updates?** | Yes, for the same extension ID. |
| **Survives browser/PC restart?** | Yes. |
| **Survives service worker kill (MV3)?** | Yes; data is on disk and reused when the worker runs again. |

So for migration state: it's persistent for the lifetime of the installed extension unless the user uninstalls or clears the extension's data.
