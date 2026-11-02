import { DOCUMENT_CONFIG as C } from "./config.js";
import { Viewer } from "./viewer.js";
import { Thumbnails } from "./thumbnails.js";
import { SearchController } from "./search.js";

const $ = (id) => document.getElementById(id);
const mobile = window.matchMedia("(max-width: 900px)");
const body = document.body;
let viewer, thumbs, search, total = C.totalPages, pushNext = false, urlTimer = 0;

/* ---------- static content from config ---------- */
function applyConfig() {
  document.title = C.title;
  $("doc-title").textContent = C.title;
  $("doc-desc").textContent = C.description;
  for (const id of ["btn-download", "info-download", "error-download"]) $(id).href = C.downloadUrl;
  $("page-total").textContent = total;
  const rows = [["Title", C.title], ["Description", C.description], ["Total pages", total.toLocaleString()],
    ["File size", C.fileSize], ["Source", C.source], ["Published", C.publicationDate]];
  const dl = $("info-list");
  for (const [k, v] of rows) {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    dl.append(dt, dd);
  }
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 4500);
}

/* ---------- panels ---------- */
function setSidebar(open) {
  body.classList.toggle("sidebar-open", open);
  $("btn-sidebar").setAttribute("aria-expanded", String(open));
  if (open) { if (mobile.matches) body.classList.remove("results-open"); requestAnimationFrame(() => { thumbs?.update(); thumbs?.reveal(viewer.current); }); }
}
function setResults(open) {
  body.classList.toggle("results-open", open);
  if (open && mobile.matches) setSidebar(false);
}
const anyDrawer = () => mobile.matches && (body.classList.contains("sidebar-open") || body.classList.contains("results-open"));

/* ---------- URL <-> page ---------- */
function readPageParam() {
  const raw = new URLSearchParams(location.search).get("page");
  if (raw === null || raw === "") return { page: 1 };
  const n = Number(raw);
  if (!Number.isInteger(n)) return { page: 1, error: `“${raw}” is not a valid page number.` };
  if (n < 1) return { page: 1, error: "Page numbers start at 1." };
  if (n > total) return { page: total, error: `This document has ${total.toLocaleString()} pages. Page ${n.toLocaleString()} does not exist.` };
  return { page: n };
}
function writeUrl(n, push) {
  const u = new URL(location.href);
  if (u.searchParams.get("page") === String(n)) return;
  u.searchParams.set("page", n);
  history[push ? "pushState" : "replaceState"]({ page: n }, "", u);
}
function navigate(n, { push = true } = {}) {
  pushNext = push;
  viewer.goTo(n);
}
function validate(raw) {
  const s = String(raw).trim().replace(/[, ]/g, "");
  const n = Number(s);
  if (!/^\d+$/.test(s)) { toast("Enter a page number, for example 847."); return null; }
  if (n < 1 || n > total) { toast(`Enter a page between 1 and ${total.toLocaleString()}.`); return null; }
  return n;
}

/* ---------- errors / loading ---------- */
function showError(err) {
  $("loading").hidden = true;
  const name = err?.name || "";
  let text = "The PDF could not be opened.";
  if (name === "MissingPDFException") text = "The PDF was not found at the configured address. Check pdfUrl in src/config.js and that the release asset exists.";
  else if (name === "InvalidPDFException") text = "The file at the configured address is not a valid PDF.";
  else if (name === "UnexpectedResponseException" || name === "ResponseException" || /fetch|network|status/i.test(err?.message || "")) {
    text = "The server did not return the PDF. This is usually a CORS or network problem: GitHub Release links cannot be read directly by a web page, so pdfUrl should point at the Cloudflare Worker proxy described in the README. If your connection is slow or offline, try again.";
  }
  $("error-text").textContent = text;
  $("error").hidden = false;
  console.error(err);
}

function bytes(n) { return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`; }

/* ---------- boot ---------- */
async function boot() {
  $("error").hidden = true;
  $("loading").hidden = false;
  if (typeof pdfjsLib === "undefined") return showError(new Error("PDF.js failed to load from the CDN. Check your connection and reload."));
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  viewer = new Viewer($("scroller"), $("spacer"), {
    onFirstRender: () => { $("loading").hidden = true; },
    onZoom: (s) => { $("zoom-label").textContent = `${Math.round(s * 100)}%`; },
    onFindCount: (count, term) => { $("find-count").textContent = !term ? "" : count === null ? "…" : `${count} on this page`; },
    onPageChange: (n, source) => {
      $("page-input").value = n;
      thumbs?.setCurrent(n);
      if (body.classList.contains("sidebar-open")) thumbs?.reveal(n);
      document.title = `Page ${n} – ${C.title}`;
      if (source === "jump") { writeUrl(n, pushNext); pushNext = false; }
      else { clearTimeout(urlTimer); urlTimer = setTimeout(() => writeUrl(n, false), 200); }
    },
  });

  try {
    await viewer.load(C.pdfUrl, (loaded, tot) => {
      const bar = $("loading-bar");
      if (tot) { bar.max = tot; bar.value = loaded; $("loading-detail").textContent = `${bytes(loaded)} of ${bytes(tot)} received`; }
      else $("loading-detail").textContent = `${bytes(loaded)} received`;
    });
  } catch (err) { return showError(err); }

  if (viewer.numPages !== total) {
    console.warn(`config.totalPages (${total}) differs from the PDF (${viewer.numPages}); using the PDF.`);
    total = viewer.numPages;
    $("page-total").textContent = total;
  }

  thumbs = new Thumbnails($("thumbs"), (n) => { navigate(n); if (mobile.matches) setSidebar(false); });
  thumbs.init(viewer.doc, viewer.pw, viewer.ph);

  const { page, error } = readPageParam();
  if (error) toast(error);
  navigate(page, { push: false });
  writeUrl(page, false);
  $("loading-text").textContent = "Rendering page…";
}

/* ---------- wiring ---------- */
function wire() {
  search = new SearchController({
    form: $("search-form"), input: $("search-input"), list: $("results-list"), statusEl: $("results-status"),
    indexBase: new URL(C.searchIndexPath, document.baseURI).href,
    onShowPanel: () => setResults(true),
    onOpen: (page, query) => {
      navigate(page);
      $("find-input").value = query;
      viewer.setFindTerm(query);
      if (mobile.matches) setResults(false);
    },
  });

  $("btn-sidebar").addEventListener("click", () => setSidebar(!body.classList.contains("sidebar-open")));
  $("results-close").addEventListener("click", () => setResults(false));
  $("scrim").addEventListener("click", () => { setSidebar(false); setResults(false); });
  $("btn-info").addEventListener("click", () => $("info").showModal());
  $("btn-prev").addEventListener("click", () => navigate(Math.max(1, viewer.current - 1)));
  $("btn-next").addEventListener("click", () => navigate(Math.min(total, viewer.current + 1)));
  $("zoom-in").addEventListener("click", () => viewer.zoomIn());
  $("zoom-out").addEventListener("click", () => viewer.zoomOut());
  $("zoom-reset").addEventListener("click", () => viewer.resetZoom());
  $("zoom-fit").addEventListener("click", () => viewer.fitWidth());
  $("error-retry").addEventListener("click", () => location.reload());

  const pi = $("page-input");
  pi.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const n = validate(pi.value);
    if (n) { navigate(n); $("scroller").focus(); } else pi.value = viewer.current;
  });
  pi.addEventListener("focus", () => pi.select());
  pi.addEventListener("blur", () => { if (viewer) pi.value = viewer.current; });

  let ft = 0;
  $("find-input").addEventListener("input", (e) => { clearTimeout(ft); ft = setTimeout(() => viewer.setFindTerm(e.target.value), 200); });

  window.addEventListener("popstate", () => { if (viewer?.doc) navigate(readPageParam().page, { push: false }); });

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      setResults(true);
      $("search-input").focus();
      $("search-input").select();
      return;
    }
    if (e.key === "Escape") {
      if ($("info").open) return; // dialog closes itself
      if (body.classList.contains("results-open")) { setResults(false); return; }
      if (anyDrawer()) { setSidebar(false); return; }
      return;
    }
    const t = e.target;
    if (t.matches?.("input, textarea, select, [contenteditable]") || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || $("info").open || !viewer?.doc) return;
    if (e.key === "ArrowLeft" && !viewer.canScrollX()) { e.preventDefault(); navigate(Math.max(1, viewer.current - 1)); }
    if (e.key === "ArrowRight" && !viewer.canScrollX()) { e.preventDefault(); navigate(Math.min(total, viewer.current + 1)); }
  });

  if (!mobile.matches) setSidebar(true);
}

applyConfig();
wire();
boot();
