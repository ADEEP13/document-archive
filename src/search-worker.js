/* Full-document search worker: loads the static index once, then scans it off the main thread. */
const MAX_RESULTS = 1000;
const CONTEXT = 70;
let base = "";
let chunks = null; // [{start, orig: [], low: []}]
let loading = null;
let currentId = 0;

const sleep = () => new Promise((r) => setTimeout(r, 0));

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url.split("/").pop()} returned HTTP ${res.status}`);
  return res.json();
}

function loadIndex() {
  if (chunks) return Promise.resolve();
  if (loading) return loading;
  loading = (async () => {
    let manifest;
    try {
      manifest = await fetchJson(`${base}manifest.json`);
    } catch (err) {
      throw new Error(`The search index has not been published yet (${err.message}). Run scripts/extract_pdf_text.py and commit public/search-index/.`);
    }
    const v = encodeURIComponent(manifest.version || "");
    const out = new Array(manifest.chunks.length);
    let done = 0;
    let next = 0;
    const lane = async () => {
      while (next < manifest.chunks.length) {
        const i = next++;
        const c = manifest.chunks[i];
        const data = await fetchJson(`${base}${c.file}?v=${v}`);
        out[i] = { start: data.start, orig: data.pages, low: data.pages.map((t) => t.toLowerCase()) };
        postMessage({ type: "progress", loaded: ++done, total: manifest.chunks.length });
      }
    };
    await Promise.all([lane(), lane(), lane()]);
    chunks = out;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

function snippet(orig, low, i, len) {
  const src = orig.length === low.length ? orig : low;
  let a = Math.max(0, i - CONTEXT);
  let b = Math.min(src.length, i + len + CONTEXT);
  if (a > 0) { const sp = src.indexOf(" ", a); if (sp !== -1 && sp < i) a = sp + 1; }
  if (b < src.length) { const sp = src.lastIndexOf(" ", b); if (sp > i + len) b = sp; }
  return [(a > 0 ? "…" : "") + src.slice(a, i), src.slice(i, i + len), src.slice(i + len, b) + (b < src.length ? "…" : "")];
}

async function search(id, query) {
  const q = query.toLowerCase().replace(/\s+/g, " ").trim();
  let total = 0;
  let batch = [];
  let truncated = false;
  for (const c of chunks) {
    for (let k = 0; k < c.low.length; k++) {
      const low = c.low[k];
      let i = low.indexOf(q);
      if (i === -1) continue;
      if (total >= MAX_RESULTS) { truncated = true; break; }
      let count = 0;
      for (let j = i; j !== -1 && count < 99; j = low.indexOf(q, j + q.length)) count++;
      batch.push({ page: c.start + k, count, parts: snippet(c.orig[k], low, i, q.length) });
      total++;
    }
    if (truncated) break;
    postMessage({ type: "results", id, items: batch });
    batch = [];
    await sleep(); // lets a newer search message arrive
    if (currentId !== id) return;
  }
  if (batch.length) postMessage({ type: "results", id, items: batch });
  postMessage({ type: "done", id, total, truncated });
}

onmessage = async (e) => {
  const m = e.data;
  if (m.type === "init") { base = m.base; return; }
  if (m.type === "search") {
    currentId = m.id;
    try {
      await loadIndex();
      if (currentId === m.id) await search(m.id, m.query);
    } catch (err) {
      postMessage({ type: "error", id: m.id, message: err.message });
    }
  }
};
