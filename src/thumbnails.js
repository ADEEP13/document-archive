/** Virtualised thumbnail strip: only a handful of thumbnails exist in the DOM and render lazily. */
const TW = 112; // thumbnail CSS width
const LABEL = 22;
const SPACING = 12;
const BUFFER = 3;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class Thumbnails {
  constructor(container, onSelect) {
    this.box = container;
    this.onSelect = onSelect;
    this.items = new Map();
    this.doc = null;
    this.current = 1;
    this.timer = 0;
    this.active = 0;
    this.spacer = document.createElement("div");
    this.spacer.className = "thumbs-spacer";
    this.box.append(this.spacer);
    this.box.addEventListener("scroll", () => this.update(), { passive: true });
    new ResizeObserver(() => this.update()).observe(this.box);
  }

  init(doc, pw, ph) {
    this.doc = doc;
    this.N = doc.numPages;
    this.thumbH = Math.round((TW * ph) / pw);
    this.itemH = this.thumbH + LABEL + SPACING;
    this.spacer.style.height = `${this.N * this.itemH + SPACING}px`;
    this.update();
  }

  setCurrent(n) {
    const prev = this.items.get(this.current);
    prev?.btn.removeAttribute("aria-current");
    this.current = n;
    this.items.get(n)?.btn.setAttribute("aria-current", "true");
  }

  /** Scroll the strip so the given page is visible (called when the sidebar is open). */
  reveal(n) {
    if (!this.doc || !this.box.clientHeight) return;
    const top = SPACING + (n - 1) * this.itemH;
    const st = this.box.scrollTop;
    if (top < st || top + this.itemH > st + this.box.clientHeight) {
      this.box.scrollTop = Math.max(0, top - this.box.clientHeight / 2 + this.itemH / 2);
    }
  }

  update() {
    if (!this.doc) return;
    const st = this.box.scrollTop;
    const ch = this.box.clientHeight;
    if (!ch) return;
    const idx = (y) => clamp(Math.floor((y - SPACING) / this.itemH) + 1, 1, this.N);
    const lo = Math.max(1, idx(st) - BUFFER);
    const hi = Math.min(this.N, idx(st + ch) + BUFFER);
    for (const [n, it] of [...this.items]) {
      if (n < lo || n > hi) this._remove(n, it);
    }
    for (let n = lo; n <= hi; n++) if (!this.items.has(n)) this._add(n);
    // Wait until scrolling settles before decoding anything.
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._pump(), 120);
  }

  _add(n) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "thumb";
    btn.style.top = `${SPACING + (n - 1) * this.itemH}px`;
    btn.setAttribute("aria-label", `Go to page ${n}`);
    if (n === this.current) btn.setAttribute("aria-current", "true");
    const frame = document.createElement("span");
    frame.className = "thumb-box";
    frame.style.width = `${TW}px`;
    frame.style.height = `${this.thumbH}px`;
    const label = document.createElement("span");
    label.className = "thumb-label";
    label.textContent = n;
    btn.append(frame, label);
    btn.addEventListener("click", () => this.onSelect(n));
    this.spacer.append(btn);
    this.items.set(n, { btn, frame, state: "new", task: null, page: null, removed: false });
  }

  _remove(n, it) {
    it.removed = true;
    try { it.task?.cancel(); } catch {}
    it.page?.cleanup?.();
    it.btn.remove();
    this.items.delete(n);
  }

  _pump() {
    while (this.active < 2) {
      let best = null;
      for (const [n, it] of this.items) {
        if (it.state !== "new") continue;
        if (!best || Math.abs(n - this.current) < Math.abs(best.n - this.current)) best = { n, it };
      }
      if (!best) return;
      best.it.state = "rendering";
      this.active++;
      this._render(best.n, best.it).finally(() => { this.active--; this._pump(); });
    }
  }

  async _render(n, it) {
    try {
      const page = await this.doc.getPage(n);
      it.page = page;
      if (it.removed) { page.cleanup(); return; }
      const base = page.getViewport({ scale: 1 });
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      const vp = page.getViewport({ scale: (TW / base.width) * ratio });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      it.task = page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport: vp });
      await it.task.promise;
      if (it.removed) return;
      it.frame.replaceChildren(canvas);
      it.state = "done";
      page.cleanup();
    } catch (err) {
      if (!it.removed && err?.name !== "RenderingCancelledException") it.state = "error";
    }
  }
}
