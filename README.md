# Cloudify docs chatbot — static hosting

Free, automatic hosting for the embeddable Cloudify support chatbot.

**Files**

| File | Purpose |
|---|---|
| `chatbot-widget.js` | The chat widget. Embed on any page with a `<script>` tag (see below). |
| `kb.json` | Knowledge base built from https://docs.cloudify.biz. Rebuilt automatically every night. |
| `build_kb_llms.py` / `build_kb.py` | KB builder scripts (used by the nightly workflow). |
| `.github/workflows/refresh-kb.yml` | Nightly rebuild: fetches the live docs, rebuilds `kb.json`, commits it. GitHub Pages redeploys automatically. |

**Setup (one time)**

1. Create a **public** repo and push these files to `main`. (Pages is free on public repos.)
2. Repo → Settings → Pages → Build and deployment → **Deploy from a branch** → `main` → `/(root)` → Save.
3. Settings → Pages → Custom domain → `chatbot-api.cloudify.biz` → Save. Tick **Enforce HTTPS** once the certificate is issued.
4. In your DNS: `chatbot-api.cloudify.biz` → CNAME → `<your-username>.github.io`.
5. Repo → Settings → Actions → General → Workflow permissions → **Read and write** (lets the bot commit the refreshed `kb.json`).

**Embed on your site** (paste before `</body>`):

```html
<script src="https://chatbot-api.cloudify.biz/chatbot-widget.js"
        data-kb="https://chatbot-api.cloudify.biz/kb.json"
        data-name="Cloudify"
        data-color="#1d4ed8"></script>
```

**Manual refresh:** Actions tab → "Refresh chatbot KB" → Run workflow.
