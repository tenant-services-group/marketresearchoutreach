# TSG Market Research Outreach

Tool covering the full Market Research outreach process: extract contacts from a property PDF, review and finalize the list, generate one Outlook draft per contact — then come back later to work the replies.

## Pages

Everything is served from the one `src/index.html` file; the pages are hash routes over it, so links can be bookmarked and shared.

| Route | Page | Contains |
|---|---|---|
| `/` | **Home** | Card menu for the two tools |
| `/#/generate` | **Generate Emails** | Steps 1–5 (contact list → review → template → subject → generate) and the draft list |
| `/#/followup` | **Project Follow-up** | Saved projects and the response report (check replies, process them, update Monday.com) |

"Sign in" appears on both tool pages; "Reset all" only on Generate Emails, where the saved contact list lives.

## Workflow (Generate Emails)

1. **Get your contact list** — two sources:
   - **Extract from a PDF report** (default) — upload a CoStar-style property PDF and the expected property count. The parser pulls Property Address, Property Name, Leasing Company, First Name, Last Name, Contact Email, City, State, and Zip — one contact per property, taken **only from the Primary Leasing Company section**. If that section is blank or absent, the contact fields stay blank and the review table flags them for manual entry (no fallback to Property Manager or True Owner).
   - **Upload an Excel file (.xlsx)** — for lists you already have. Needs email, first name, and property address columns (city optional); column names are matched loosely.
2. **Review & finalize contacts** (PDF path) — editable table of everything extracted. Missing first names and emails are highlighted; type corrections directly into any cell. "Finalize & load contacts" feeds the list straight into the generator — no file download or re-upload. Rows without an email are left out (with a count). "Download Excel file" exports the table *as edited*; "Start over" clears everything.
3. **Choose an email template** — generic industry templates (Office, Office-Medical, Retail, Retail-Medical, Retail-Restaurant, Industrial) with fill-in fields, an uploaded .docx, or pasted text. `NAME` and `ADDRESS` placeholders are replaced per contact (legacy `ADDRESS(ES)` also accepted).
4. **Choose a subject line** — the contact's property addresses, the same addresses behind a label you type (e.g. `Dallas - 123 Elm St. | 456 Lake Rd.` — a prefix, not a filter), or one custom subject used on every draft.
5. **Generate** — one draft per unique email address. "Open draft" launches the default mail client (Outlook) via `mailto:`; "Copy body" is the fallback for clients that truncate long `mailto:` bodies.

A finalized list is saved in the browser's local storage, so refreshing or returning to the page restores it automatically (with the finalize timestamp shown). Generated drafts survive a reload the same way: the drafts, their green "✓ Sent" badges, and the current project are restored, so a half-finished send session resumes where it left off — and a regenerate after a reload updates the same saved project instead of creating a duplicate. "Start over" (or "Reset all") clears both.

## Privacy

Everything runs in the browser. PDFs, contact lists, and templates are never uploaded to any server. There is no API. The saved finalized list lives only in that browser's local storage.

## Projects (saved sends)

Adding a **project name** in step 5 before generating saves the send — contact emails, subject lines, and date — to Azure Table Storage via the managed Functions API. Clicking "Open draft" marks that contact as opened.

The **Saved projects** card on the Project Follow-up page loads itself the first time that page is opened, and shows the **5 most recent** projects with a **View all** toggle for the rest. The search box filters the full list by project name, owner, or saved date; results stay capped at 5 until "View all" is clicked. Each row has a **Delete** button (click once to arm, again to confirm). The Response report's project picker always lists every project, searched or not.

Regenerating drafts does **not** create a second project: as long as the project name is unchanged, a re-generate updates the project saved earlier (drafts, subjects, and count are replaced; contacts that already opened a draft keep that status) — including after a page reload, since the current project travels with the restored drafts. Changing the project name starts a new project, and anything left over can be removed with Delete.

API routes: `GET /api/projects` (optionally `?owner=email`), `GET /api/projects/{id}`, `POST /api/projects`, `PUT /api/projects/{id}` (replace on regenerate), `PATCH /api/projects/{id}` (incremental: `openedEmails`, `addCompleted`/`removeCompleted`, `notes`), `DELETE /api/projects/{id}`.

## Response report

On the Project Follow-up page: pick a saved project, sign in with a work Microsoft account, and "Check for replies" pulls that project's replies from the signed-in mailbox. Each reply row has:

- **A note box** — type availability, rate, terms, anything; notes save automatically as you type (with a "Saved ✓" indicator) **onto the project record**, so they're still there when the report is reopened later or on another machine. These notes are what goes to the Monday board's **Notes** column — Claude does not write notes.
- **Mark completed** — also saved on the project record, so completed replies stay marked across sessions. Processed replies are auto-marked. "Mark all completed" does the whole list at once, and "Hide completed replies" collapses finished rows out of view.

"Process replies & update Monday" sends each pending reply to the board: your note in Notes, Square footage and Flyer Link extracted from the reply by Claude (best-effort — if `ANTHROPIC_API_KEY` isn't configured, the run still completes and those two columns are left blank), Email Status "*Email Received", Elimination Reason "Pending", attachments uploaded to the item's File column. Data Status and Affirmatives are left for manual review.

Replies upload in **batches** — at most 4 replies, or roughly 20 MB of request body, per request. A single POST carrying every pending reply and its attachments overran both the Static Web Apps request-body limit (~28 MB, answered with a plain-text 413 page) and the managed API's 45-second timeout, which the page could only report as `Unexpected token 'T', "The page w"... is not valid JSON`. Each batch is now marked completed as soon as it lands, so when a later batch fails the status line says how many replies already went up and clicking the button again continues with the rest instead of re-uploading them. Attachments over 10 MB, or beyond a per-reply 18 MB budget, are left in the mailbox and listed on the reply row as "Too large to upload (kept in Outlook)".

### Board columns and permissions

Columns are **only created on boards this tool creates**. Updating an existing board never alters its structure, because `create_column` requires board-owner rights: a board whose edit permission is set to "owners" rejected that call with **"User unauthorized to perform action"**, and since it ran before the first row, the entire run aborted and nothing was written. Boards cloned from the "Market Research Emails Board Template" hit this on every run — their file column is titled "Flyer Attachment" rather than "File", so it never matched the schema by title and the tool tried to add a "File" column each time.

Schema columns are matched by title first (aliases included), then by column type, so "Flyer Attachment" maps to the schema's file column. A column the board genuinely doesn't have is left unmapped and its value skipped rather than created. Values follow the column's real type as well: "Flyer Link" is a link column on boards this tool creates and a plain text column on the template-cloned boards, and each is written in the shape it expects.

Board *sharing* is a visibility setting and is unrelated to any of this — making a board shareable does not grant edit rights. What the `MONDAY_API_TOKEN` user does still need is permission to **add and update items** on the target board; without it, individual rows fail even though no structural change is attempted.

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
  src/functions/respond.js
  src/shared/store.js
  src/shared/monday-client.js
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

The `OutreachProjects` table auto-creates on first save. Round-trip test: generate with a project name → "Project saved" → open one draft → Project Follow-up lists it with opened = 1. Monday test: extract a small PDF → Sync to Monday.com → new board → link appears → board shows the properties.

## External resources (reflected in the CSP)

- `cdnjs.cloudflare.com` — SheetJS (xlsx), mammoth (docx text extraction), pdf.js (PDF parsing + worker)
- `raw.githubusercontent.com` — logo in the header
- `api.monday.com` — called server-side only (no CSP change needed)
