#!/usr/bin/env python3
"""
Build the chatbot knowledge base from a Mintlify docs site's llms-full.txt.

Mintlify publishes the entire documentation as clean markdown at
https://<docs-site>/llms-full.txt — one fetch, no HTML scraping, no nav
chrome. Re-run any time the docs change to refresh the chatbot's brain.

Usage:
    python3 build_kb_llms.py --site https://docs.cloudify.biz --out kb.json
"""
import argparse
import datetime
import html
import json
import re
import sys
import urllib.request
from collections import Counter

from build_kb import chunk_page, collapse_repeats

UA = {"User-Agent": "CloudifyChatbot/1.0 (+kb-builder)"}


def fetch_text(url, timeout=60):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="ignore")


def split_pages(full_txt):
    """Split llms-full.txt into (title, url, body) pages.

    Mintlify format:
        # Page Title
        Source: https://docs.site/some/page

        <markdown body>

        # Next Title
        ...
    """
    pages = []
    # find every "# Title\nSource: url" header
    pat = re.compile(r"(?m)^# (.+?)\r?\nSource: (\S+)\r?\n")
    matches = list(pat.finditer(full_txt))
    for i, m in enumerate(matches):
        title = m.group(1).strip()
        url = m.group(2).strip()
        body = full_txt[m.end():matches[i + 1].start() if i + 1 < len(matches) else len(full_txt)]
        pages.append((title, url, body))
    return pages


def clean_markdown(body):
    """Turn Mintlify markdown/MDX into plain readable text."""
    t = body
    # MDX components: keep meaningful attributes, drop the tags
    t = re.sub(r'(?i)<(?:Step|Card)[^>]*title="([^"]+)"[^>]*/>', r"\1", t)
    t = re.sub(r"(?is)<(Steps|Step|CardGroup|Card|Tabs|Tab|AccordionGroup|Accordion|Frame|Tip|Warning|Note|Info)[^>]*>(.*?)</\1>", r"\2", t)
    t = re.sub(r"(?i)<(Steps|Step|CardGroup|Card|Tabs|Tab|AccordionGroup|Accordion|Frame|Tip|Warning|Note|Info|img|iframe|br|hr|source)[^>]*/>", " ", t)
    # generic html: drop tags, keep inner text
    t = re.sub(r"(?s)<[^>]+>", " ", t)
    t = html.unescape(t)
    lines = []
    for ln in t.split("\n"):
        ln = ln.strip()
        if not ln:
            lines.append("")
            continue
        # drop markdown table separator rows: | - | :-: | - |
        if re.match(r"^\|?[\s:\-|]+\|?$", ln) and set(ln) <= set("|: -"):
            continue
        # table rows -> readable "a · b · c"
        if ln.startswith("|") and ln.endswith("|"):
            ln = " · ".join(c.strip() for c in ln.strip("|").split("|") if c.strip())
        # strip markdown syntax, keep the words
        ln = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", ln)          # images
        ln = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", ln)            # links -> text
        ln = re.sub(r"(\*\*|__)(.*?)\1", r"\2", ln)                 # bold
        ln = re.sub(r"(?<!\w)[*_]([^*_]+)[*_](?!\w)", r"\1", ln)    # italic
        ln = re.sub(r"`([^`]+)`", r"\1", ln)                       # code
        ln = re.sub(r"^#{1,6}\s+", "", ln)                         # headings
        ln = re.sub(r"^>\s?", "", ln)                              # quotes
        ln = re.sub(r"^(\*|-|\d+[.)])\s+", "", ln)                  # list markers
        ln = re.sub(r"[ \t\xa0]+", " ", ln).strip()
        if ln.lower() in ("copy page",):
            continue
        lines.append(ln)
    text = "\n".join(lines)
    text = re.sub(r"\n\s*\n+", "\n", text)
    return text.strip()


def build(site, out):
    site = site.rstrip("/")
    print(f"Fetching {site}/llms-full.txt ...")
    full_txt = fetch_text(site + "/llms-full.txt")
    raw_pages = split_pages(full_txt)
    print(f"  {len(raw_pages)} doc pages found")

    pages = []
    for title, url, body in raw_pages:
        text = clean_markdown(body)
        chunks = chunk_page(text)
        if chunks:
            pages.append({"url": url, "title": title, "chunks": chunks})

    # ---- dedup: repeated setup steps appear across many integration guides ----
    # keep the first copy, drop the rest (unlike nav boilerplate, one copy is useful)
    norm = Counter()
    first_seen = {}
    for p in pages:
        for c in set(c.strip().lower() for c in p["chunks"]):
            norm[c] += 1
            first_seen.setdefault(c, p["url"])
    n_pages = max(len(pages), 1)
    repeated = {c for c, n in norm.items() if n > max(5, n_pages * 0.15)}

    flat, dropped = [], 0
    for p in pages:
        seen_here = set()
        for c in p["chunks"]:
            c = collapse_repeats(c)
            key = c.strip().lower()
            if key in seen_here or len(c) < 40:
                dropped += 1
                continue
            seen_here.add(key)
            if key in repeated and first_seen[key] != p["url"]:
                dropped += 1  # keep only the first copy
                continue
            flat.append({"url": p["url"], "title": p["title"], "text": c})

    kb = {
        "site": site,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "page_count": len(pages),
        "chunk_count": len(flat),
        "chunks": flat,
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(kb, f, ensure_ascii=False)
    print(f"Done: {len(pages)} pages, {dropped} dup chunks removed, {len(flat)} chunks -> {out}")


def main():
    ap = argparse.ArgumentParser(description="Build chatbot KB from a Mintlify docs site (llms-full.txt).")
    ap.add_argument("--site", required=True, help="Docs site root, e.g. https://docs.cloudify.biz")
    ap.add_argument("--out", default="kb.json", help="Output JSON path")
    args = ap.parse_args()
    build(args.site, args.out)


if __name__ == "__main__":
    main()
