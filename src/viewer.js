/**
 * Virtualised PDF.js viewer.
 * Every page gets the same reserved "slot" (sized from page 1) inside one tall spacer, but only
 * pages near the viewport exist in the DOM. Pages that scroll away are cancelled and cleaned up.
 */
const GAP = 16;
const BUFFER = 2; // pages rendered beyond the visible range
const MAX_SCALE = 5;
const MIN_SCALE = 0.15;
const MAX_CANVAS_PIXELS = 12_000_000;
const CONCURRENCY = 2;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class Viewer {
  constructor(scroller, spacer, handlers = {}) {
    this.scroller = scroller;
    this.spacer = spacer;
    this.h = handlers; // onPageChange(n, source), onZoom(scale), onFirstRender(), onFindCount(count, term)
    this.doc = null;
    this.numPages = 0;
    this.pw = 612;
    this.ph = 792;
    this.scale = 1;
    this.fitMode = true;
    this.current = 1;
    this.lockTop = null;
    this.findTerm = "";
    this.entries = new Map();
    this.active = 0;
    this.raf = 0;
    this.lastWidth = 0;
    this.firstRendered = false;

    scroller.addEventListener("scroll", () => this._queueUpdate(), { passive: true });
    new ResizeObserver(() => this._onResize()).observe(scroller);
  }

  async load(url, onProgress) {
    const task = pdfjsLib.getDocument({
      url,
      rangeChunkSize: 512 * 1024, // fetch the file in 512 KB ranges
      disableAutoFetch: true, // never download the rest of the file in the background
      enableXfa: false,
      isEvalSupported: false,
    });
    task.onProgress = ({ loaded, total }) => onProgress?.(loaded, total);
    this.task = task;
    this.doc = await task.promise;
    this.numPages = this.doc.numPages;
    const first = await this.doc.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    this.pw = vp.width;
    this.ph = vp.height;
    first.cleanup();
    this.lastWidth = this.scroller.clientWidth;
    this._layout();
    this._update();
  }

  /* ---------- public API ---------- */
  goTo(n) {
    n = clamp(Math.round(n), 1, this.numPages);
    this.scroller.scrollTop = Math.max(0, this._top(n) - GAP / 2);
    this.lockTop = this.scroller.scrollTop;
    this.current = n;
    this._update();
    this.h.onPageChange?.(n, "jump");
  }
  next() { if (this.current < this.numPages) this.goTo(this.current + 1); }
  prev() { if (this.current > 1) this.goTo(this.current - 1); }
  zoomIn() { this._setScale(this.scale * 1.2, false); }
  zoomOut() { this._setScale(this.scale / 1.2, false); }
  resetZoom() { this._setScale(1, false); }
  fitWidth() { this._setScale(this.scale, true); }
  canScrollX() { return this.scroller.scrollWidth > this.scroller.clientWidth + 1; }

  setFindTerm(term) {
    this.findTerm = (term || "").trim().toLowerCase().replace(/\s+/g, " ");
    for (const e of this.entries.values()) this._highlight(e);
    this._emitFind();
  }

  /* ---------- layout ---------- */
  _top(n) { return GAP + (n - 1) * this.pitch; }

  _layout() {
    const cw = this.scroller.clientWidth;
    if (this.fitMode) this.scale = clamp((cw - 2 * GAP) / this.pw, MIN_SCALE, MAX_SCALE);
    this.slotW = this.pw * this.scale;
    this.slotH = this.ph * this.scale;
    this.pitch = this.slotH + GAP;
    this.spacerW = Math.max(cw, this.slotW + 2 * GAP);
    this.spacer.style.width = `${this.spacerW}px`;
    this.spacer.style.height = `${GAP + this.numPages * this.pitch}px`;
    for (const e of this.entries.values()) this._place(e);
    this.h.onZoom?.(this.scale);
  }

  _place(e) {
    const s = e.el.style;
    s.left = `${(this.spacerW - this.slotW) / 2}px`;
    s.top = `${this._top(e.n)}px`;
    s.width = `${this.slotW}px`;
    s.height = `${this.slotH}px`;
  }

  _setScale(scale, fit) {
    if (!this.doc) return;
    const st = this.scroller.scrollTop;
    const cur = this.current;
    const frac = (st - this._top(cur)) / this.pitch;
    const xr = (this.scroller.scrollLeft + this.scroller.clientWidth / 2) / this.spacerW;
    this.fitMode = fit;
    if (!fit) this.scale = clamp(scale, MIN_SCALE, MAX_SCALE);
    this._clearEntries();
    this._layout();
    this.scroller.scrollTop = this._top(cur) + frac * this.pitch;
    this.scroller.scrollLeft = Math.max(0, xr * this.spacerW - this.scroller.clientWidth / 2);
    this.lockTop = null;
    this._update();
  }

  _onResize() {
    if (!this.doc) return;
    const w = this.scroller.clientWidth;
    if (w !== this.lastWidth) {
      this.lastWidth = w;
      if (this.fitMode) { this._setScale(this.scale, true); return; }
      this._layout();
    }
    this._queueUpdate();
  }

  /* ---------- virtualisation ---------- */
  _queueUpdate() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this._update(); });
  }

  _update() {
    if (!this.doc) return;
    const N = this.numPages;
    const st = this.scroller.scrollTop;
    const ch = this.scroller.clientHeight;
    const idx = (y) => clamp(Math.floor((y - GAP) / this.pitch) + 1, 1, N);
    const first = idx(st);
    const last = idx(st + ch);
    const lo = Math.max(1, first - BUFFER);
    const hi = Math.min(N, last + BUFFER);

    for (const e of [...this.entries.values()]) {
      if (e.n < lo - 1 || e.n > hi + 1) this._removeEntry(e);
    }
    for (let n = lo; n <= hi; n++) if (!this.entries.has(n)) this._createEntry(n);

    this._detectCurrent(st, ch);
    this._pump();
  }

  _detectCurrent(st, ch) {
    if (this.lockTop !== null && Math.abs(st - this.lockTop) < 2) return;
    this.lockTop = null;
    const probe = st + Math.min(ch * 0.3, this.pitch * 0.4);
    let n = clamp(Math.floor((probe - GAP) / this.pitch) + 1, 1, this.numPages);
    const atBottom = st + ch >= this.scroller.scrollHeight - 2;
    if (atBottom && this.slotH <= ch) n = this.numPages;
    if (n !== this.current) {
      this.current = n;
      this._emitFind();
      this.h.onPageChange?.(n, "scroll");
    }
  }

  _createEntry(n) {
    const el = document.createElement("div");
    el.className = "page";
    el.dataset.page = n;
    const label = document.createElement("span");
    label.className = "page-label";
    label.textContent = `Page ${n}`;
    el.append(label);
    this.spacer.append(el);
    const e = { n, el, state: "new", removed: false, task: null, ttask: null, page: null, textDivs: [], matches: 0, hl: null, inner: null };
    this.entries.set(n, e);
    this._place(e);
  }

  _removeEntry(e) {
    e.removed = true;
    try { e.task?.cancel(); } catch {}
    try { e.ttask?.cancel(); } catch {}
    e.page?.cleanup?.();
    e.el.remove();
    this.entries.delete(e.n);
  }

  _clearEntries() {
    for (const e of [...this.entries.values()]) this._removeEntry(e);
  }

  _pump() {
    while (this.active < CONCURRENCY) {
      const center = this.current;
      let best = null;
      for (const e of this.entries.values()) {
        if (e.state !== "new") continue;
        if (!best || Math.abs(e.n - center) < Math.abs(best.n - center)) best = e;
      }
      if (!best) return;
      best.state = "rendering";
      this.active++;
      this._renderEntry(best).finally(() => { this.active--; this._pump(); });
    }
  }

  async _renderEntry(e) {
    try {
      const page = await this.doc.getPage(e.n);
      e.page = page;
      if (e.removed) { page.cleanup(); return; }
      const v0 = page.getViewport({ scale: 1 });
      const s = Math.min(this.slotW / v0.width, this.slotH / v0.height);
      const vp = page.getViewport({ scale: s });
      let ratio = Math.min(window.devicePixelRatio || 1, 2);
      while (ratio > 1 && vp.width * vp.height * ratio * ratio > MAX_CANVAS_PIXELS) ratio -= 0.25;
      ratio = Math.max(1, ratio);

      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width * ratio);
      canvas.height = Math.floor(vp.height * ratio);
      canvas.style.width = `${vp.width}px`;
      canvas.style.height = `${vp.height}px`;
      const ctx = canvas.getContext("2d", { alpha: false });
      e.task = page.render({ canvasContext: ctx, viewport: vp, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] });
      await e.task.promise;
      if (e.removed) return;

      const inner = document.createElement("div");
      inner.className = "page-inner";
      inner.style.width = `${vp.width}px`;
      inner.style.height = `${vp.height}px`;
      inner.style.left = `${(this.slotW - vp.width) / 2}px`;
      const hl = document.createElement("div");
      hl.className = "hl-layer";
      const tl = document.createElement("div");
      tl.className = "textLayer";
      inner.append(canvas, hl, tl);
      e.el.replaceChildren(inner);
      e.inner = inner;
      e.hl = hl;
      e.state = "done";
      if (!this.firstRendered) { this.firstRendered = true; this.h.onFirstRender?.(); }

      try {
        e.ttask = pdfjsLib.renderTextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp, textDivs: e.textDivs });
        await e.ttask.promise;
        if (!e.removed) this._highlight(e);
      } catch (err) {
        if (!e.removed && err?.name !== "AbortException" && err?.name !== "RenderingCancelledException") console.warn("Text layer failed", e.n, err);
      }
    } catch (err) {
      if (e.removed || err?.name === "RenderingCancelledException") return;
      console.error(`Page ${e.n} failed`, err);
      e.state = "error";
      this._showPageError(e);
    }
  }

  _showPageError(e) {
    const box = document.createElement("div");
    box.className = "page-error";
    const p = document.createElement("p");
    p.textContent = `Page ${e.n} could not be loaded.`;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn btn-small";
    b.textContent = "Retry";
    b.addEventListener("click", () => {
      e.state = "new";
      const label = document.createElement("span");
      label.className = "page-label";
      label.textContent = `Page ${e.n}`;
      e.el.replaceChildren(label);
      this._pump();
    });
    box.append(p, b);
    e.el.replaceChildren(box);
  }

  /* ---------- in-page find (highlights drawn from the PDF.js text layer) ---------- */
  _highlight(e) {
    if (!e.hl) return;
    e.hl.replaceChildren();
    e.matches = 0;
    const q = this.findTerm;
    if (q && e.textDivs.length) {
      const base = e.inner.getBoundingClientRect();
      const frag = document.createDocumentFragment();
      const range = document.createRange();
      for (const d of e.textDivs) {
        const node = d.firstChild;
        if (!node || node.nodeType !== 3) continue;
        const t = node.data.toLowerCase();
        let i = t.indexOf(q);
        while (i !== -1 && e.matches < 300) {
          range.setStart(node, i);
          range.setEnd(node, i + q.length);
          e.matches++;
          for (const r of range.getClientRects()) {
            const m = document.createElement("div");
            m.className = "mark";
            m.style.cssText = `left:${r.left - base.left}px;top:${r.top - base.top}px;width:${r.width}px;height:${r.height}px`;
            frag.append(m);
          }
          i = t.indexOf(q, i + q.length);
        }
      }
      e.hl.append(frag);
    }
    if (e.n === this.current) this._emitFind();
  }

  _emitFind() {
    const e = this.entries.get(this.current);
    this.h.onFindCount?.(e && e.state === "done" ? e.matches : null, this.findTerm);
  }
}
