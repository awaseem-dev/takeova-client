# Claude Advanced — Files, PDFs, Citations

Three new capabilities shipped in `claude-advanced.js` (auto-mounted on boot):

## 1. Files API — upload once, reference forever

Upload a file once, then reference it by `file_id` across any agent. Good for:
- Brand kit PDFs (one upload, every agent cites it)
- Past winning proposals (Proposal agent learns the pattern)
- Contract templates (Legal reuses them)
- Lead magnets (Sales attaches them automatically)

**HTTP endpoints (ready to use from dashboard):**
```
POST   /api/ai-employees/files/upload        — multipart file upload
                                                form fields: file, kind, description
GET    /api/ai-employees/files               — list all your uploaded files
DELETE /api/ai-employees/files/:fileId       — delete one
POST   /api/ai-employees/files/:fileId/ask   — ask a question about the file
                                                body: { prompt, system?, maxTokens? }
```

**From agent code:**
```js
const { uploadFile, callWithFile } = require("./claude-advanced");

// One-time upload (e.g. when user uploads brand guide)
const { fileId } = await uploadFile(buffer, "brand-guide.pdf", "application/pdf");
db.prepare("UPDATE users SET brand_guide_file_id = ? WHERE id = ?").run(fileId, userId);

// Every agent call can now reference it
const { text } = await callWithFile({
  fileId: user.brand_guide_file_id,
  prompt: "What's our brand voice for this email draft?",
});
```

## 2. PDF input — agents read PDFs natively

No OCR step, no text extraction. Claude handles PDFs directly — renders each page,
extracts text, understands layout. Best for:

**Bookkeeper reading an invoice:**
```js
const { text } = await callWithFile({
  pdfBase64: invoiceBase64,
  prompt: `Extract as JSON: {vendor, total, tax, due_date, line_items:[{desc, amount}]}`,
  maxTokens: 1000,
});
const parsed = JSON.parse(text);
```

**Legal reviewing a contract:**
```js
const { text } = await callWithFile({
  fileId: contract.file_id,
  prompt: "Flag any unusual clauses, missing protections, or red flags. Reply as JSON array.",
  system: "You are a legal reviewer for AU service agreements. Be thorough.",
});
```

**Proposal studying past winners:**
```js
// Upload past proposals once, then reference when drafting new ones
const result = await callWithFile({
  fileId: pastProposal.file_id,
  prompt: `Draft a new proposal for ${newClient.name} (${newClient.industry}) using the same structure and tone as this one.`,
  maxTokens: 2500,
});
```

## 3. Citations — ground responses in source documents

Agents can now cite specific passages from source material. Makes answers feel
factual and auditable instead of hallucinated.

**From agent code:**
```js
const { callWithCitations } = require("./claude-advanced");

const { text, citations } = await callWithCitations({
  documents: [
    { title: "Q3 Financial Report", content: q3ReportText },
    { title: "Monthly KPIs",        content: kpisText },
  ],
  prompt: "What should I focus on next quarter, based on the data?",
});

// text:      "Focus on reducing churn [1] and cutting ad spend [2]..."
// citations: [
//   { index: 1, source: "Q3 Financial Report", quote: "churn rate rose to 12%..." },
//   { index: 2, source: "Monthly KPIs",        quote: "CAC exceeded LTV in..." },
// ]
```

**HTTP endpoint (POST /api/ai-employees/citations/ask):**
```js
fetch("/api/ai-employees/citations/ask", {
  method: "POST",
  headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
  body: JSON.stringify({
    documents: [{ title: "Q3 Report", content: "..." }],
    prompt: "What was our revenue trend?",
  }),
}).then(r => r.json()).then(d => {
  // d.answer    — text with [1] [2] markers inline
  // d.citations — array of { index, source, quote }
  // Render as: "revenue grew 18% QoQ [1]" with [1] being a tooltip/link to the quote
});
```

**Best places to use citations:**
- AI Advisor answering business questions (cite your own reports)
- Support agent answering product questions (cite the product manual)
- Legal agent giving contract advice (cite the contract passage)
- Bookkeeper explaining discrepancies (cite the transaction log)

## Data model — `ai_files` table
Auto-migrated on boot:
```sql
CREATE TABLE ai_files (
  id TEXT PRIMARY KEY, user_id TEXT, file_id TEXT UNIQUE,
  filename TEXT, mime_type TEXT, size_bytes INTEGER,
  kind TEXT,           -- "brand-kit", "contract", "past-proposal", etc.
  description TEXT,
  created_at TEXT
);
```

## What this doesn't do

- **No dashboard UI** for the Files tab (upload button, file list, ask-this-file form).
  The endpoints are ready; the UI is per-feature work.
- **No agent auto-use of uploaded files.** You decide when Bookkeeper reads an
  invoice PDF — we don't inspect every transaction for an attached PDF.
- **No automatic citation display** in existing agent outputs. When an agent
  uses `callWithCitations`, the frontend needs to render the citation markers
  and attach tooltips — that's UI work, not bundled here.

These are per-feature integration decisions.

## Costs to know about

- **Files API**: Files are stored for 90 days then auto-delete. No storage cost.
- **PDF input**: Counted as input tokens at the usual rate — a 10-page PDF is
  roughly 1000-3000 tokens depending on content density.
- **Citations**: No extra cost vs a regular call with the same documents inline.
  Just adds structure.
