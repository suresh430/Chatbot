#!/usr/bin/env python3
"""
Cloudify chatbot knowledge-base builder.

Crawls the Framer sitemap, extracts page text, removes site-wide
boilerplate (nav/footer repeated on every page), chunks the content,
and writes a kb.json file the chatbot widget reads at runtime.

Stdlib only — no pip packages needed, so it runs anywhere
(including a plain cron job or GitHub Action).

Usage:
    python3 build_kb.py --site https://cloudify.biz --out kb.json
    python3 build_kb.py --site https://cloudify.biz --out kb.json --limit 50
    python3 build_kb.py --site https://cloudify.biz --out kb.json --workers 8

Re-run it any time the site changes; the widget picks up the new
kb.json automatically (cache-busted fetch).
"""

import argparse
import concurrent.futures
import datetime
import html
import json
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET

USER_AGENT = "CloudifyChatbotKB/1.0 (+https://cloudify.biz)"
TIMEOUT = 25

# Skip binary / non-content pages
SKIP_EXT = (".pdf", ".xml", ".jpg", ".jpeg", ".png", ".gif", ".svg",
            ".webp", ".ico", ".css", ".js", ".zip", ".mp4", ".webm")

STOPWORDS = frozenset("""
a about above after again against all am an and any are as at be because been
before being below between both but by can did do does doing down during each
few for from further had has have having he her here hers herself him himself
his how i if in into is it its itself me more most my myself no nor not of off
on once only or other ought our ours ourselves out over own same she should so
some such than that the their theirs them themselves then there these they this
those through to too under until up very was we were what when where which
while who whom why with you your yours yourself yourselves
""".split())


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        ctype = resp.headers.get("Content-Type", "")
        if "html" not in ctype and "xml" not in ctype and "text" not in ctype:
            return None
        raw = resp.read()
    # Framer pages can be ~1MB; decode leniently
    for enc in ("utf-8", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def get_sitemap_urls(site):
    base = site.rstrip("/")
    data = fetch(base + "/sitemap.xml")
    if not data:
        print("ERROR: could not fetch sitemap.xml", file=sys.stderr)
        sys.exit(1)
    urls = []
    try:
        root = ET.fromstring(data)
        for url in root.iter():
            if url.tag.endswith("loc") and url.text:
                loc = url.text.strip()
                if loc.startswith(base) and not loc.lower().endswith(SKIP_EXT):
                    urls.append(loc)
    except ET.ParseError:
        urls = re.findall(r"<loc>\s*([^<]+?)\s*</loc>", data)
        urls = [u for u in urls if u.startswith(base)]
    # de-dupe, keep order
    seen, out = set(), []
    for u in urls:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


def clean_text(page_html):
    """Extract readable text from page HTML (Framer or Mintlify docs)."""
    text = page_html
    # drop scripts, styles, svg, noscript, head and nav blocks (sidebars, TOCs, breadcrumbs)
    text = re.sub(r"(?is)<(script|style|noscript|svg|nav|head)[^>]*>.*?</\1>", " ", text)
    # Mintlify docs: keep only the article container (excludes top navbar + footer)
    m = re.search(r'(?is)<main[^>]*id="content-container"[^>]*>(.*)</main\s*>', text)
    if m:
        text = m.group(1)
    # keep heading hierarchy as separators
    text = re.sub(r"(?i)</(h[1-6]|p|li|div|section|article|tr)[^>]*>", "\n", text)
    text = re.sub(r"(?i)<br[^>]*>", "\n", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = html.unescape(text)
    # normalise whitespace, keep paragraph breaks
    text = re.sub(r"[ \t\xa0]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text)
    return text.strip()


def page_meta(page_html):
    def meta(prop):
        m = re.search(r'(?i)<meta[^>]+(?:property|name)=["\']%s["\'][^>]+content=["\']([^"\']+)' % prop, page_html)
        return html.unescape(m.group(1)).strip() if m else ""
    title = meta("og:title")
    if not title:
        m = re.search(r"(?is)<title[^>]*>(.*?)</title>", page_html)
        title = html.unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip() if m else ""
    # Framer sites reuse one generic <title>/og:title everywhere —
    # the first H1 is the real page heading, so prefer it.
    h1 = re.search(r"(?is)<h1[^>]*>(.*?)</h1>", page_html)
    if h1:
        h1_text = html.unescape(re.sub(r"<[^>]+>", " ", h1.group(1)))
        h1_text = re.sub(r"\s+", " ", h1_text).strip()
        if len(h1_text) >= 8:
            title = h1_text
    desc = meta("og:description") or meta("description")
    return title, desc


def chunk_page(text, max_chars=600):
    """Split page text into paragraph-ish chunks, merging tiny fragments."""
    paras = [p.strip() for p in text.split("\n") if p.strip()]
    chunks, buf = [], ""
    for p in paras:
        if len(p) < 25:  # tiny labels / buttons — merge, don't drop yet
            buf = (buf + " " + p).strip() if buf else p
            continue
        if buf:
            p = buf + " " + p
            buf = ""
        while len(p) > max_chars:
            cut = p.rfind(" ", 0, max_chars)
            cut = cut if cut > 200 else max_chars
            chunks.append(p[:cut].strip())
            p = p[cut:].strip()
        if p:
            chunks.append(p)
    if buf:
        chunks.append(buf)
    return chunks


def tokenize(s):
    return [t for t in re.findall(r"[a-z0-9']+", s.lower()) if t not in STOPWORDS and len(t) > 1]


def collapse_repeats(text):
    """Collapse consecutive repeated phrases inside a chunk.

    Framer pages often render the same label twice in a row
    ("Book a free consultation Book a free consultation",
    "Integration Challenges Integration Challenges").
    """
    words = text.split()
    for n in range(2, 9):  # phrase lengths to check (each pass independent)
        i, res = 0, []
        while i < len(words):
            phrase = [w.lower() for w in words[i:i + n]]
            if len(phrase) < n:
                res.extend(words[i:])
                break
            k = 1
            while ([w.lower() for w in words[i + k * n:i + (k + 1) * n]] == phrase):
                k += 1
            if k >= 2:  # repeated: keep one copy
                res.extend(words[i:i + n])
                i += n * k
            else:
                res.append(words[i])
                i += 1
        words = res
    return " ".join(words)


def build(site, out, limit=None, workers=8):
    t0 = time.time()
    urls = get_sitemap_urls(site)
    if limit:
        urls = urls[:limit]
    print(f"Crawling {len(urls)} pages from {site} ...")

    pages = []

    def crawl(url):
        try:
            page_html = fetch(url)
        except Exception as e:
            return (url, None, f"fetch failed: {e}")
        if not page_html:
            return (url, None, "non-html or empty")
        title, desc = page_meta(page_html)
        chunks = chunk_page(clean_text(page_html))
        return (url, {"url": url, "title": title, "description": desc,
                      "chunks": chunks}, None)

    done, failed = 0, 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(crawl, u): u for u in urls}
        for fut in concurrent.futures.as_completed(futs):
            url, page, err = fut.result()
            done += 1
            if page and page["chunks"]:
                pages.append(page)
            else:
                failed += 1
                if err:
                    print(f"  skip {url}: {err}", file=sys.stderr)
            if done % 50 == 0 or done == len(urls):
                print(f"  ... {done}/{len(urls)} pages", flush=True)

    # ---- boilerplate removal: drop chunks identical across many pages ----
    # (Framer nav/footer/CTAs repeat verbatim on every page)
    from collections import Counter
    norm = Counter()
    for p in pages:
        for c in set(c.strip().lower() for c in p["chunks"]):
            norm[c] += 1
    n_pages = max(len(pages), 1)
    boilerplate = {c for c, n in norm.items() if n > max(5, n_pages * 0.15)}

    flat = []
    dropped = 0
    for p in pages:
        seen_here = set()
        for c in p["chunks"]:
            c = collapse_repeats(c)
            key = c.strip().lower()
            if key in boilerplate or key in seen_here:  # site-wide nav/footer + in-page repeats
                dropped += 1
                continue
            seen_here.add(key)
            if len(c) < 40:  # lone button labels etc.
                dropped += 1
                continue
            if c.count("|") >= 4 and len(c) < 250:  # pipe-joined nav labels, poor answers
                dropped += 1
                continue
            flat.append({"url": p["url"], "title": p["title"], "text": c})

    kb = {
        "site": site.rstrip("/"),
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "page_count": len(pages),
        "chunk_count": len(flat),
        "chunks": flat,
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(kb, f, ensure_ascii=False)
    secs = time.time() - t0
    print(f"Done in {secs:.0f}s: {len(pages)} pages ok, {failed} skipped, "
          f"{dropped} boilerplate chunks removed, {len(flat)} chunks -> {out}")


def main():
    ap = argparse.ArgumentParser(description="Build chatbot knowledge base from a Framer site.")
    ap.add_argument("--site", required=True, help="Site root, e.g. https://cloudify.biz")
    ap.add_argument("--out", default="kb.json", help="Output JSON path")
    ap.add_argument("--limit", type=int, default=None, help="Crawl at most N pages (for testing)")
    ap.add_argument("--workers", type=int, default=8, help="Parallel fetch workers")
    args = ap.parse_args()
    build(args.site, args.out, args.limit, args.workers)


if __name__ == "__main__":
    main()
