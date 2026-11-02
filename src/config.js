/**
 * Single place to edit everything about the document.
 * Change the PDF later by editing this file only (and re-running the index script).
 */
export const DOCUMENT_CONFIG = {
  title: "Public Document Archive",
  description: "Searchable public release. Browse, search and share any page.",
  totalPages: 2103, // Verified against the PDF at load time; a mismatch is only logged.
  fileSize: "160.5 MB",
  source: "Source information goes here (agency, release name, URL).",
  publicationDate: "2026-01-01",

  // URL PDF.js loads from. It MUST send CORS headers and support Range requests.
  // GitHub Release URLs usually do not send CORS headers, so the recommended value is
  // the free Cloudflare Worker proxy in /workers (see README, step 7).
  pdfUrl: "https://rough-heart-a313.adeepag13.workers.dev/document.pdf",

  // Plain link shown on the "Download Original PDF" button (no CORS needed).
  downloadUrl: "https://github.com/ADEEP13/document-archive/releases/download/V1/document.pdf",

  // Folder produced by scripts/extract_pdf_text.py, relative to index.html.
  searchIndexPath: "public/search-index/",
};
