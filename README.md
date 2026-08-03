# TSG Market Research Outreach

Single-page tool covering the full Market Research outreach process: extract contacts from a property PDF, review and finalize the list, then generate one Outlook draft per contact.

## Workflow

1. **Get your contact list** — two sources:
   - **Extract from a PDF report** (default) — upload a CoStar-style property PDF and the expected property count. The parser pulls Property Address, Property Name, Leasing Company, First Name, Last Name, Contact Email, City, State, and Zip — one contact per property, taken **only from the Primary Leasing Company section**. If that section is blank or absent, the contact fields stay blank and the review table flags them for manual entry (no fallback to Property Manager or True Owner).
   - **Upload an Excel file (.xlsx)** — for lists you already have. Needs email, first name, and property address columns (city optional); column names are matched loosely.
2. **Review & finalize contacts** (PDF path) — editable table of everything extracted. Missing first names and emails are highlighted; type corrections directly into any cell. "Finalize & load contacts" feeds the list straight into the generator — no file download or re-upload. Rows without an email are left out (with a count). "Download Excel file" exports the table *as edited*; "Start over" clears everything.
3. **Choose an email template** — generic industry templates (Office, Office-Medical, Retail, Retail-Medical, Retail-Restaurant, Industrial) with fill-in fields, an uploaded .docx, or pasted text. `NAME` and `ADDRESS` placeholders are replaced per contact (legacy `ADDRESS(ES)` also accepted).
4. **Choose a subject line** — property addresses, addresses filtered by city, or one custom subject.
5. **Generate** — one draft per unique email address. "Open draft" launches the default mail client (Outlook) via `mailto:`; "Copy body" is the fallback for clients that truncate long `mailto:` bodies.

A finalized list is saved in the browser's local storage, so refreshing or returning to the page restores it automatically (with the finalize timestamp shown). "Start over" clears the saved list.

## Privacy

Everything runs in the browser. PDFs, contact lists, and templates are never uploaded to any server. There is no API. The saved finalized list lives only in that browser's local storage.

## Projects (saved sends)

Adding a **project name** in step 5 before generating saves the send — contact emails, subject lines, and date — to Azure Table Storage via the managed Functions API. Clicking "Open draft" marks that contact as opened. The "Saved projects" card lists everything saved, with a **Delete** button on each row (click once to arm, again to confirm). Response reports will build on these records.

Regenerating drafts does **not** create a second project: as long as the project name is unchanged, a re-generate updates the project saved a moment ago (drafts, subjects, and count are replaced; contacts that already opened a draft keep that status). Changing the project name — or reloading the page first — starts a new project, and anything left over can be removed with Delete.

API routes: `GET /api/projects`, `GET /api/projects/{id}`, `POST /api/projects`, `PUT /api/projects/{id}` (replace on regenerate), `PATCH /api/projects/{id}` (mark opened), `DELETE /api/projects/{id}`.

## Monday.com sync

The **Sync to Monday.com** button in the review step pushes the extracted properties (as edited) to a board — either a brand-new board in a chosen workspace or an existing board. Columns created/matched by title: Property Name, Leasing Company, Contact, Email, City, State, Zip, Status (set to "Sent"), Date Sent (today). Item name = property address. A link to the board appears when the sync finishes.

The page works fully without the API — if it isn't configured, drafts still generate, project saving shows a soft warning, and the Monday panel explains what's missing.

## Repo layout

```
src/
  index.html
  staticwebapp.config.json
api/
  host.json
  package.json
  src/functions/projects.js
  src/functions/monday.js
  src/shared/store.js
README.md
```

## Deploy to Azure Static Web Apps

1. Push this repo to GitHub.
2. Azure Portal → Create → Static Web App → connect the GitHub repo.
3. Build settings: **App location** `src`, **Api location** `api`, **Output location** (leave empty).
4. Azure creates the GitHub Actions workflow; every push to main redeploys.

## One-time setup for the API features

1. Workflow yml (`.github/workflows/azure-static-web-apps-*.yml`): `api_location: "api"`.
2. **Storage account** (for projects): Azure Portal → Create → Storage account (Standard, LRS) → Access keys → copy Connection string (key1). SWA → Settings → Environment variables → **Production** → add `STORAGE_CONNECTION_STRING` → **Apply and wait for the confirmation bell**.
3. **Monday token** (for sync): Monday.com → click your avatar → Developers → My access tokens → copy. Add as `MONDAY_API_TOKEN` in the same Environment variables screen → Apply.
4. Optional: `DEBUG_RESPONSE` = `true` while testing (adds error detail to API responses); set back to `false` for users.

The `OutreachProjects` table auto-creates on first save. Round-trip test: generate with a project name → "Project saved" → open one draft → Load projects shows it with opened = 1. Monday test: extract a small PDF → Sync to Monday.com → new board → link appears → board shows the properties.

## External resources (reflected in the CSP)

- `cdnjs.cloudflare.com` — SheetJS (xlsx), mammoth (docx text extraction), pdf.js (PDF parsing + worker)
- `raw.githubusercontent.com` — logo in the header
- `api.monday.com` — called server-side only (no CSP change needed)
