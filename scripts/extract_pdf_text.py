#!/usr/bin/env python3
"""
Build the static, chunked full-text search index for the archive.

Usage:
    python scripts/extract_pdf_text.py document.pdf
    python scripts/extract_pdf_text.py document.pdf --out public/search-index --chunk-size 100

Output (default: public/search-index/):
    manifest.json        page count, chunk list, content version (used for cache busting)
    index-001.json ...   {"start": 1, "pages": ["text of page 1", "text of page 2", ...]}
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:
    sys.exit("PyMuPDF is not installed. Run: pip install -r scripts/requirements.txt")

REPO_ROOT = Path(__file__).resolve().parent.parent


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024


def clean(text: str) -> str:
    text = text.replace("\x00", " ")
    return re.sub(r"\s+", " ", text).strip()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf", type=Path, help="path to the original PDF")
    ap.add_argument("--out", type=Path, default=REPO_ROOT / "public" / "search-index", help="output folder")
    ap.add_argument("--chunk-size", type=int, default=100, help="pages per chunk file (default 100)")
    args = ap.parse_args()

    if not args.pdf.is_file():
        sys.exit(f"File not found: {args.pdf}")
    if args.chunk_size < 1:
        sys.exit("--chunk-size must be at least 1")

    doc = fitz.open(args.pdf)
    total = doc.page_count
    args.out.mkdir(parents=True, exist_ok=True)
    for old in args.out.glob("index-*.json"):
        old.unlink()

    digest = hashlib.sha1()
    chunks, empty, chars = [], 0, 0
    for start in range(0, total, args.chunk_size):
        end = min(start + args.chunk_size, total)
        pages = []
        for i in range(start, end):
            text = clean(doc.load_page(i).get_text("text"))
            if not text:
                empty += 1
            chars += len(text)
            pages.append(text)
            if (i + 1) % 100 == 0 or i + 1 == total:
                print(f"\r  extracted {i + 1}/{total} pages", end="", flush=True)
        name = f"index-{len(chunks) + 1:03d}.json"
        payload = json.dumps({"start": start + 1, "pages": pages}, ensure_ascii=False, separators=(",", ":"))
        data = payload.encode("utf-8")
        digest.update(data)
        (args.out / name).write_bytes(data)
        chunks.append({"file": name, "start": start + 1, "end": end})
    print()

    manifest = {
        "version": digest.hexdigest()[:10],
        "totalPages": total,
        "chunkSize": args.chunk_size,
        "emptyPages": empty,
        "chunks": chunks,
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")

    size = sum(p.stat().st_size for p in args.out.glob("*.json"))
    print(f"Done: {total} pages, {chars:,} characters, {len(chunks)} chunk files, {human(size)} on disk")
    print("(GitHub Pages compresses JSON automatically, so visitors download roughly a quarter of that.)")
    if empty:
        print(f"Warning: {empty} page(s) had no extractable text.")
    if empty > total * 0.3:
        print("Most pages have no text layer, so the PDF is probably scanned. Run OCR first, e.g.:\n"
              "  ocrmypdf --skip-text input.pdf searchable.pdf\nthen run this script on searchable.pdf.")
    print("\nUpdate src/config.js with:")
    print(f"  totalPages: {total},")
    print(f"  fileSize: \"{human(args.pdf.stat().st_size)}\",")


if __name__ == "__main__":
    main()
