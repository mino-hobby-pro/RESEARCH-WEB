import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import morgan from 'morgan';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// Performance & security
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "script-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:"],
      "connect-src": ["'self'"]
    }
  }
}));
app.use(compression());
app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(morgan('tiny'));
app.use(express.static('public', { maxAge: '7d', etag: true }));

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY || "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";
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

// Simple in-memory cache for 10 minutes
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

function setCache(key, value) {
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}
function getCache(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() > v.expires) {
    cache.delete(key);
    return null;
  }
  return v.value;
}

function normalizeUrl(input) {
  try {
    const hasProto = /^https?:\/\//i.test(input);
    const url = new URL(hasProto ? input : `https://${input}`);
    return url.toString();
  } catch {
    return null;
  }
}

function isAllowedUrl(url) {
  // Basic safeguard: avoid local/internal addresses
  try {
    const u = new URL(url);
    const hostname = u.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0'
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function fetchSiteHTML(targetUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout
  try {
    const res = await fetch(targetUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 RESEARCH-WEB/1.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    if (!res.ok) {
      throw new Error(`Upstream fetch failed: ${res.status} ${res.statusText}`);
    }
    const html = await res.text();
    // Clip overly large HTML to protect prompt size
    const MAX_HTML_LENGTH = 800_000; // ~800KB
    return html.length > MAX_HTML_LENGTH ? html.slice(0, MAX_HTML_LENGTH) : html;
  } finally {
    clearTimeout(timeout);
  }
}

function buildPrompt(url, html) {
  return [
    {
      role: "system",
      content:
        "You are RESEARCH-WEB, an expert web intelligence analyst. Return ONLY strict JSON. Do not include markdown, prose, or code fences."
    },
    {
      role: "user",
      content: `Analyze the following website using its URL and raw HTML.
URL: ${url}

Return a strict JSON object with this schema:

{
  "site": {
    "url": "string",
    "title": "string",
    "description": "string",
    "language": "string",
    "frameworks": ["string"],
    "libraries": ["string"],
    "cms": "string | null",
    "runtime": "string | null",
    "hosting": "string | null",
    "cdn": "string | null",
    "analytics": ["string"],
    "tag_managers": ["string"],
    "seo": {
      "meta_title": "string",
      "meta_description": "string",
      "h1": "string | null",
      "canonical": "string | null",
      "schema_org": ["string"]
    },
    "performance": {
      "page_weight_kb": "number",
      "image_optimization": "string",
      "lazy_loading": "boolean",
      "script_count": "number",
      "notable_third_parties": ["string"]
    },
    "ads": {
      "has_ads": "boolean",
      "ad_networks": ["string"],
      "placements": ["string"]
    },
    "monetization": {
      "models": ["string"], 
      "subscriptions": "boolean",
      "affiliate": "boolean",
      "ecommerce": "boolean"
    },
    "privacy_security": {
      "cookie_banner": "boolean",
      "gdpr_ccpa_mentions": ["string"],
      "security_headers": ["string"]
    },
    "audience": {
      "target_segments": ["string"],
      "regions": ["string"]
    },
    "competitors": ["string"],
    "traffic_estimate": {
      "confidence": "low | medium | high",
      "monthly_visits_range": "string"
    },
    "contact": {
      "emails": ["string"],
      "phones": ["string"],
      "socials": ["string"]
    },
    "key_features": ["string"],
    "summary": "string",
    "recommendations": ["string"]
  }
}

Rules:
- Base findings ONLY on provided HTML and URL; infer cautiously and mark confidence via 'traffic_estimate.confidence'.
- Populate arrays with distinct items; avoid duplicates.
- If unknown, use null or empty array appropriately.
- Keep descriptions concise and concrete.
- Ensure valid JSON and correct types.

HTML BEGIN
${html}
HTML END`
    }
  ];
}

async function callGroq(prompt) {
  const res = await fetch(GROQ_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: "llama-3.1-70b-versatile",
      temperature: 0.2,
      max_tokens: 2000,
      response_format: { type: "json_object" },
      messages: prompt
    })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Groq API error: ${res.status} ${res.statusText} ${text}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Groq API returned no content");
  const parsed = JSON.parse(content);
  return parsed;
}

// Analyze endpoint
app.post('/analyze', async (req, res) => {
  try {
    const rawUrl = (req.body?.url || '').trim();
    const url = normalizeUrl(rawUrl);
    if (!url) {
      return res.status(400).json({ error: 'Invalid URL' });
    }
    if (!isAllowedUrl(url)) {
      return res.status(400).json({ error: 'URL not allowed' });
    }

    const cached = getCache(url);
    if (cached) {
      return res.json({ cached: true, data: cached });
    }

    const html = await fetchSiteHTML(url);
    const prompt = buildPrompt(url, html);
    const analysis = await callGroq(prompt);

    setCache(url, analysis);
    res.json({ cached: false, data: analysis });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Analysis failed' });
  }
});

// Health check
app.get('/health', (_, res) => res.json({ ok: true }));

// Fallback to index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(process.cwd() + '/public/index.html');
});

app.listen(PORT, () => {
  console.log(`RESEARCH-WEB server running on http://localhost:${PORT}`);
});
