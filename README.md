# marketresearchoutreach
Single-page tool covering the full Market Research outreach process: extract contacts from a property PDF, review and finalize the list, then generate one Outlook draft per contact.
Workflow
Get your contact list — two sources:
Extract from a PDF report (default) — upload a CoStar-style property PDF and the expected property count. The parser pulls Property Address, Property Name, Leasing Company, First Name, Last Name, Contact Email, City, State, and Zip — one contact per property, falling back Primary Leasing Company → Property Manager → True Owner.
Upload an Excel file (.xlsx) — for lists you already have. Needs email, first name, and property address columns (city optional); column names are matched loosely.
Review & finalize contacts (PDF path) — editable table of everything extracted. Missing first names and emails are highlighted; type corrections directly into any cell. "Finalize & load contacts" feeds the list straight into the generator — no file download or re-upload. Rows without an email are left out (with a count). "Download Excel file" exports the table as edited; "Start over" clears everything.
Choose an email template — generic industry templates (Office, Office-Medical, Retail, Retail-Medical, Retail-Restaurant, Industrial) with fill-in fields, an uploaded .docx, or pasted text. `NAME` and `ADDRESS` placeholders are replaced per contact (legacy `ADDRESS(ES)` also accepted).
Choose a subject line — property addresses, addresses filtered by city, or one custom subject.
Generate — one draft per unique email address. "Open draft" launches the default mail client (Outlook) via `mailto:`; "Copy body" is the fallback for clients that truncate long `mailto:` bodies.
A finalized list is saved in the browser's local storage, so refreshing or returning to the page restores it automatically (with the finalize timestamp shown). "Start over" clears the saved list.
Privacy
Everything runs in the browser. PDFs, contact lists, and templates are never uploaded to any server. There is no API. The saved finalized list lives only in that browser's local storage.
Repo layout
```
src/
  index.html
  staticwebapp.config.json
README.md
```
Deploy to Azure Static Web Apps
Push this repo to GitHub.
Azure Portal → Create → Static Web App → connect the GitHub repo.
Build settings: App location `src`, Api location (leave empty), Output location (leave empty).
Azure creates the GitHub Actions workflow; every push to main redeploys.
No environment variables or app settings are required.
External resources (reflected in the CSP)
`cdnjs.cloudflare.com` — SheetJS (xlsx), mammoth (docx text extraction), pdf.js (PDF parsing + worker)
`raw.githubusercontent.com` — TSG white logo in the header
