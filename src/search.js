/** Search UI. All scanning happens in search-worker.js so the page never freezes. */
export class SearchController {
  constructor({ form, input, list, statusEl, indexBase, onOpen, onShowPanel }) {
    Object.assign(this, { form, input, list, statusEl, indexBase, onOpen, onShowPanel });
    this.worker = null;
    this.id = 0;
    this.query = "";
    this.found = 0;
    this.timer = 0;
    form.addEventListener("submit", (e) => { e.preventDefault(); clearTimeout(this.timer); this.run(input.value); });
    input.addEventListener("input", () => {
      clearTimeout(this.timer);
      if (input.value.trim().length >= 3) this.timer = setTimeout(() => this.run(input.value), 600);
    });
    list.addEventListener("click", (e) => {
      const btn = e.target.closest("button.result");
      if (!btn) return;
      list.querySelector("[aria-current]")?.removeAttribute("aria-current");
      btn.setAttribute("aria-current", "true");
      this.onOpen(Number(btn.dataset.page), this.query);
    });
  }

  _worker() {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL("./search-worker.js", import.meta.url));
    this.worker.postMessage({ type: "init", base: this.indexBase });
    this.worker.onmessage = (e) => this._onMessage(e.data);
    this.worker.onerror = () => this._fail("The search worker could not start. Reload the page and try again.");
    return this.worker;
  }

  run(raw) {
    const q = raw.replace(/\s+/g, " ").trim();
    this.onShowPanel();
    if (q.length < 2) {
      this.list.replaceChildren();
      this.statusEl.textContent = "Enter at least 2 characters to search.";
      return;
    }
    this.query = q;
    this.found = 0;
    this.id++;
    this.list.replaceChildren();
    this.statusEl.textContent = `Searching for “${q}”…`;
    this._worker().postMessage({ type: "search", id: this.id, query: q });
  }

  _onMessage(m) {
    if (m.type === "progress") {
      if (this.statusEl.dataset.busy !== "0") this.statusEl.textContent = `Loading search index (${m.loaded} of ${m.total})…`;
      return;
    }
    if (m.id !== this.id) return;
    if (m.type === "results") {
      const frag = document.createDocumentFragment();
      for (const r of m.items) frag.append(this._item(r));
      this.list.append(frag);
      this.found += m.items.length;
      this.statusEl.textContent = `Searching… ${this.found} page${this.found === 1 ? "" : "s"} so far`;
    } else if (m.type === "done") {
      if (m.total === 0) {
        const li = document.createElement("li");
        li.className = "empty";
        li.textContent = `No pages contain “${this.query}”. Check the spelling or try fewer words.`;
        this.list.replaceChildren(li);
        this.statusEl.textContent = "No results";
      } else {
        const n = m.total;
        this.statusEl.textContent = `${n}${m.truncated ? "+" : ""} page${n === 1 ? "" : "s"} contain “${this.query}”` + (m.truncated ? ` (showing the first ${n})` : "");
      }
    } else if (m.type === "error") {
      this._fail(m.message);
    }
  }

  _item(r) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "result";
    b.dataset.page = r.page;
    const head = document.createElement("span");
    head.className = "result-page";
    head.textContent = `Page ${r.page}`;
    if (r.count > 1) {
      const c = document.createElement("span");
      c.className = "result-count";
      c.textContent = `${r.count >= 99 ? "99+" : r.count} matches`;
      head.append(c);
    }
    const p = document.createElement("span");
    p.className = "result-snippet";
    const mark = document.createElement("mark");
    mark.textContent = r.parts[1];
    p.append(r.parts[0], mark, r.parts[2]);
    b.append(head, p);
    li.append(b);
    return li;
  }

  _fail(message) {
    this.statusEl.textContent = "Search is unavailable";
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = message;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn btn-small";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => { this.worker?.terminate(); this.worker = null; this.run(this.query); });
    li.append(document.createElement("br"), retry);
    this.list.replaceChildren(li);
  }
}
