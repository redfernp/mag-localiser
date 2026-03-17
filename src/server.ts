/**
 * Mag Localiser — Web Server
 *
 * Exposes the localisation engine as a web app.
 * Uses Server-Sent Events (SSE) for streaming so the browser stays live
 * during the 3–5 minute localisation process without timing out.
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import express from 'express';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { BRANDS, LOCALE_META } from './config/brands.js';
import { fetchAllSlugs, fetchPostBySlug, fetchPostsForProfiling } from './graphql/client.js';
import { loadProfile, profileExists, saveProfile, backupProfile } from './storage/profiles.js';
import { loadGuide, saveGuide } from './storage/guides.js';
import { localiseArticle } from './agents/localizer.js';
import { buildBrandVoiceProfile } from './agents/profiler.js';
import { saveOutput, OUTPUT_DIR } from './utils/output.js';
import type { BrandKey, LocaleCode } from './types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const client = new Anthropic();
const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

// ─── GET /api/articles?brand=dope-snow ────────────────────────────────────────
// Returns the full article list with per-locale translation status.

app.get('/api/articles', async (req, res) => {
  const brandKey = req.query.brand as string;
  const brandConfig = BRANDS[brandKey as BrandKey];

  if (!brandConfig) {
    res.status(400).json({ error: `Unknown brand "${brandKey}"` });
    return;
  }

  try {
    const slugNodes = await fetchAllSlugs(brandConfig);
    const articles = slugNodes.map((s) => ({
      slug: s.slug,
      translated: s.translations
        .filter((t) => t && t.language)
        .map((t) => t.language.code.toLowerCase()),
    }));
    res.json({
      articles,
      locales: brandConfig.locales,
      localeMeta: Object.fromEntries(
        brandConfig.locales.map((l) => [
          l,
          { name: LOCALE_META[l].name, strictMode: LOCALE_META[l].strictMode },
        ]),
      ),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── GET /api/localise?brand=…&slug=…&locale=… (SSE) ─────────────────────────
// Streams the localisation to the browser token by token.

app.get('/api/localise', async (req, res) => {
  const { brand, slug, locale } = req.query as {
    brand: string;
    slug: string;
    locale: string;
  };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const brandConfig = BRANDS[brand as BrandKey];
    const localeMeta = LOCALE_META[locale as LocaleCode];

    if (!brandConfig || !localeMeta) {
      send('error', { message: 'Invalid brand or locale' });
      res.end();
      return;
    }

    const enProfile = loadProfile(brand as BrandKey, 'en');
    if (!enProfile) {
      send('error', { message: `No EN profile found for ${brandConfig.name}. Run: npm run profile -- --brand ${brand} --locale en` });
      res.end();
      return;
    }

    send('status', { message: `Fetching "${slug}"…` });
    const post = await fetchPostBySlug(brandConfig, slug);
    send('status', { message: `Localising to ${localeMeta.name}…` });

    const targetProfile = loadProfile(brand as BrandKey, locale) ?? undefined;

    // Profile strict mode override takes precedence over the LOCALE_META default
    const effectiveLocaleMeta = targetProfile?.strictModeOverride !== undefined
      ? { ...localeMeta, strictMode: targetProfile.strictModeOverride }
      : localeMeta;

    const article = await localiseArticle(
      brand as BrandKey,
      post,
      locale as LocaleCode,
      effectiveLocaleMeta,
      enProfile,
      targetProfile,
      (token) => send('token', { token }),
      loadGuide(brand as BrandKey) ?? brandConfig.voiceGuide,
    );

    saveOutput(article);
    send('done', { article });
  } catch (err) {
    send('error', { message: (err as Error).message });
  }

  res.end();
});

// ─── GET /api/output/:brand/:slug/:locale ─────────────────────────────────────
// Serves the .txt file for download.

app.get('/api/output/:brand/:slug/:locale', (req, res) => {
  const { brand, slug, locale } = req.params;
  const txtPath = join(OUTPUT_DIR, brand, slug, `${locale}.txt`);

  if (!existsSync(txtPath)) {
    res.status(404).json({ error: 'Output not found' });
    return;
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${slug}-${locale}.txt"`,
  );
  res.send(readFileSync(txtPath, 'utf-8'));
});

// ─── GET /api/output/:brand/:slug/:locale/preview ─────────────────────────────
// Serves a styled HTML blog-preview page for the localised article.

app.get('/api/output/:brand/:slug/:locale/preview', (req, res) => {
  const { brand, slug, locale } = req.params;
  const jsonPath = join(OUTPUT_DIR, brand, slug, `${locale}.json`);

  if (!existsSync(jsonPath)) {
    res.status(404).send('<p>Output not found. Run the localisation first.</p>');
    return;
  }

  const article = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  const r = article.editorReview;
  const scoreColor = r.overallScore >= 75 ? '#16a34a' : r.overallScore >= 50 ? '#d97706' : '#dc2626';
  const approvedBadge = r.approved
    ? `<span style="background:#dcfce7;color:#166534;padding:2px 10px;border-radius:99px;font-size:13px;font-weight:600;">✓ Approved</span>`
    : `<span style="background:#fef9c3;color:#854d0e;padding:2px 10px;border-radius:99px;font-size:13px;font-weight:600;">⚠ Needs Review</span>`;

  const flagsHtml = r.flags.length ? `
    <div class="section">
      <h3>Editor Flags</h3>
      ${r.flags.map((f: {severity:string;category:string;description:string;suggestion?:string}) => `
        <div class="flag flag-${f.severity}">
          <strong>[${f.category}]</strong> ${f.description}
          ${f.suggestion ? `<div class="suggestion">→ ${f.suggestion}</div>` : ''}
        </div>`).join('')}
    </div>` : '';

  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${article.title}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Georgia', serif; background: #f9f9f7; color: #1a1a1a; line-height: 1.75; }
    .topbar { background: #fff; border-bottom: 1px solid #e5e5e5; padding: 12px 24px; display: flex; align-items: center; gap: 16px; font-family: sans-serif; font-size: 13px; color: #666; position: sticky; top: 0; z-index: 10; }
    .topbar strong { color: #111; }
    .topbar .score { font-weight: 700; color: ${scoreColor}; }
    .topbar a { margin-left: auto; background: #111; color: #fff; text-decoration: none; padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 600; }
    .topbar a:hover { background: #333; }
    .article { max-width: 740px; margin: 48px auto 80px; padding: 0 24px; }
    .meta { font-family: sans-serif; font-size: 13px; color: #888; margin-bottom: 24px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    h1 { font-size: clamp(1.6rem, 4vw, 2.2rem); line-height: 1.25; font-weight: 700; margin-bottom: 20px; }
    .excerpt { font-size: 1.15rem; color: #444; border-left: 3px solid #ddd; padding-left: 16px; margin-bottom: 32px; font-style: italic; line-height: 1.6; }
    .content h2 { font-size: 1.4rem; font-weight: 700; margin: 36px 0 12px; }
    .content h3 { font-size: 1.15rem; font-weight: 700; margin: 28px 0 10px; }
    .content p { margin-bottom: 18px; }
    .content ul, .content ol { margin: 0 0 18px 24px; }
    .content li { margin-bottom: 6px; }
    .content a { color: #2563eb; }
    .content img { max-width: 100%; border-radius: 8px; margin: 8px 0; }
    .divider { border: none; border-top: 1px solid #e5e5e5; margin: 48px 0; }
    .section { font-family: sans-serif; margin-bottom: 32px; }
    .section h3 { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #888; margin-bottom: 12px; }
    .seo-grid { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; font-size: 14px; }
    .seo-grid .lbl { color: #888; font-size: 12px; padding-top: 2px; }
    .seo-grid .val { color: #111; }
    .scores { display: flex; gap: 12px; flex-wrap: wrap; }
    .score-pill { background: #f3f4f6; border-radius: 8px; padding: 10px 16px; text-align: center; min-width: 80px; }
    .score-pill .n { font-size: 1.3rem; font-weight: 700; color: #111; }
    .score-pill .l { font-size: 11px; color: #888; margin-top: 2px; }
    .flag { padding: 10px 14px; border-radius: 6px; margin-bottom: 8px; font-size: 14px; }
    .flag-error { background: #fef2f2; border-left: 3px solid #dc2626; }
    .flag-warning { background: #fffbeb; border-left: 3px solid #f59e0b; }
    .flag-suggestion { background: #eff6ff; border-left: 3px solid #3b82f6; }
    .suggestion { margin-top: 6px; color: #555; font-size: 13px; }
    .summary-box { background: #f3f4f6; border-radius: 8px; padding: 14px 18px; font-size: 14px; color: #444; font-style: italic; }
  </style>
</head>
<body>
  <div class="topbar">
    <strong>${brand.toUpperCase()}</strong>
    <span>·</span>
    <span>${locale.toUpperCase()}</span>
    <span>·</span>
    <span class="score">${r.overallScore}/100</span>
    ${approvedBadge}
    <a href="/api/output/${brand}/${slug}/${locale}" download="${slug}-${locale}.txt">↓ Download .txt</a>
  </div>

  <article class="article">
    <div class="meta">
      <span>Source: <strong>${slug}</strong></span>
      <span>·</span>
      <span>Generated: ${new Date(article.generatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
    </div>

    <h1>${article.title}</h1>

    ${article.excerpt ? `<div class="excerpt">${article.excerpt}</div>` : ''}

    <div class="content">${article.content}</div>

    <hr class="divider">

    <div class="section">
      <h3>SEO Fields</h3>
      <div class="seo-grid">
        <span class="lbl">Slug</span><span class="val">${article.slug}</span>
        <span class="lbl">Meta title</span><span class="val">${article.seo.title}</span>
        <span class="lbl">Meta description</span><span class="val">${article.seo.metaDesc}</span>
        <span class="lbl">Focus keyword</span><span class="val">${article.seo.focuskw}</span>
        <span class="lbl">OG title</span><span class="val">${article.seo.opengraphTitle}</span>
        <span class="lbl">OG description</span><span class="val">${article.seo.opengraphDescription}</span>
      </div>
    </div>

    <div class="section">
      <h3>Editor Review</h3>
      <div class="scores">
        <div class="score-pill"><div class="n">${r.overallScore}</div><div class="l">Overall</div></div>
        <div class="score-pill"><div class="n">${r.scores.brandVoiceAdherence}</div><div class="l">Brand</div></div>
        <div class="score-pill"><div class="n">${r.scores.translationAccuracy}</div><div class="l">Translation</div></div>
        <div class="score-pill"><div class="n">${r.scores.culturalFit}</div><div class="l">Cultural</div></div>
        <div class="score-pill"><div class="n">${r.scores.seoOptimisation}</div><div class="l">SEO</div></div>
        <div class="score-pill"><div class="n">${r.scores.readability}</div><div class="l">Readability</div></div>
      </div>
      <div class="summary-box" style="margin-top:16px;">${r.summary}</div>
    </div>

    ${flagsHtml}
  </article>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ─── GET /api/brands ──────────────────────────────────────────────────────────

app.get('/api/brands', (_req, res) => {
  res.json(
    Object.entries(BRANDS).map(([key, cfg]) => ({ key, name: cfg.name })),
  );
});

// ─── GET /api/profiles?brand=dope-snow ────────────────────────────────────────
// Returns profile status for every locale the brand supports.

app.get('/api/profiles', (req, res) => {
  const brandKey = req.query.brand as string;
  const brandConfig = BRANDS[brandKey as BrandKey];
  if (!brandConfig) { res.status(400).json({ error: 'Unknown brand' }); return; }

  // Always include EN + all brand locales
  const allLocales = ['en', ...brandConfig.locales];

  const profiles = allLocales.map((locale) => {
    const profile = loadProfile(brandKey as BrandKey, locale);
    const meta = locale === 'en'
      ? { name: 'English (source)', strictMode: false }
      : LOCALE_META[locale as LocaleCode] ?? { name: locale.toUpperCase(), strictMode: false };
    return {
      locale,
      name: meta.name,
      strictMode: profile?.strictModeOverride ?? (meta as { strictMode?: boolean }).strictMode ?? false,
      exists: !!profile,
      lastUpdated: profile?.lastUpdated ?? null,
      articleCount: profile?.articleCount ?? null,
      formality: profile?.tone?.formality ?? null,
      personality: profile?.tone?.personality ?? [],
    };
  });

  res.json({ profiles });
});

// ─── GET /api/brand/:brand/guide ──────────────────────────────────────────────
// Returns the saved CMO voice guide for a brand (or empty string if none saved).

app.get('/api/brand/:brand/guide', (req, res) => {
  const { brand } = req.params;
  const saved = loadGuide(brand as BrandKey);
  const fallback = BRANDS[brand as BrandKey]?.voiceGuide ?? null;
  res.json({ guide: saved ?? '', hasFallback: !saved && !!fallback });
});

// ─── PUT /api/brand/:brand/guide ───────────────────────────────────────────────
// Saves a CMO voice guide for a brand.

app.put('/api/brand/:brand/guide', (req, res) => {
  const { brand } = req.params;
  const { guide } = req.body as { guide: string };
  if (!BRANDS[brand as BrandKey]) { res.status(404).json({ error: 'Unknown brand' }); return; }
  saveGuide(brand as BrandKey, guide ?? '');
  res.json({ ok: true });
});

// ─── GET /api/profile/:brand/:locale/prompt ───────────────────────────────────
// Returns the current system prompt text for editing.

app.get('/api/profile/:brand/:locale/prompt', (req, res) => {
  const { brand, locale } = req.params;
  const profile = loadProfile(brand as BrandKey, locale);
  if (!profile) { res.status(404).json({ error: 'Profile not found' }); return; }
  res.json({ systemPrompt: profile.systemPrompt, lastUpdated: profile.lastUpdated });
});

// ─── PUT /api/profile/:brand/:locale/prompt ────────────────────────────────────
// Saves an edited system prompt, backing up the previous version first.

app.put('/api/profile/:brand/:locale/prompt', (req, res) => {
  const { brand, locale } = req.params;
  const { systemPrompt } = req.body as { systemPrompt: string };

  if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
    res.status(400).json({ error: 'systemPrompt must be a non-empty string' });
    return;
  }

  const profile = loadProfile(brand as BrandKey, locale);
  if (!profile) { res.status(404).json({ error: 'Profile not found' }); return; }

  backupProfile(brand as BrandKey, locale);
  profile.systemPrompt = systemPrompt.trim();
  profile.lastUpdated = new Date().toISOString();
  saveProfile(profile);

  res.json({ ok: true, lastUpdated: profile.lastUpdated });
});

// ─── PUT /api/profile/:brand/:locale/strict-mode ──────────────────────────────
// Toggles strict mode for a locale, overriding the LOCALE_META default.

app.put('/api/profile/:brand/:locale/strict-mode', (req, res) => {
  const { brand, locale } = req.params;
  const { strictMode } = req.body as { strictMode: boolean };

  if (typeof strictMode !== 'boolean') {
    res.status(400).json({ error: 'strictMode must be a boolean' });
    return;
  }

  const profile = loadProfile(brand as BrandKey, locale);
  if (!profile) { res.status(404).json({ error: 'Profile not found' }); return; }

  profile.strictModeOverride = strictMode;
  profile.lastUpdated = new Date().toISOString();
  saveProfile(profile);

  res.json({ ok: true, strictMode });
});

// ─── POST /api/profile/:brand/:locale/prompt/refine (SSE) ────────────────────
// Takes the current prompt + a plain-English instruction, streams a revised prompt.

app.post('/api/profile/:brand/:locale/prompt/refine', async (req, res) => {
  const { brand, locale } = req.params;
  const { systemPrompt, instruction } = req.body as { systemPrompt: string; instruction: string };

  if (!systemPrompt?.trim() || !instruction?.trim()) {
    res.status(400).json({ error: 'systemPrompt and instruction are required' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const stream = client.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 2048,
      system: `You are a prompt engineer helping refine AI system prompts for a blog localisation tool.
The user will give you a system prompt and a plain-English instruction describing a change they want.
Return ONLY the revised system prompt text — no explanation, no preamble, no markdown fences.
Preserve the overall structure and all existing rules unless the instruction explicitly changes them.
Make the minimum edit needed to satisfy the instruction.`,
      messages: [{
        role: 'user',
        content: `CURRENT SYSTEM PROMPT:\n${systemPrompt}\n\nINSTRUCTION: ${instruction}`,
      }],
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        send('token', { token: event.delta.text });
      }
    }

    send('done', {});
  } catch (err) {
    send('error', { message: (err as Error).message });
  }

  res.end();
});

// ─── GET /api/profile/build?brand=…&locale=… (SSE) ───────────────────────────
// Rebuilds a brand voice profile, streaming progress events.

app.get('/api/profile/build', async (req, res) => {
  const { brand, locale } = req.query as { brand: string; locale: string };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const brandConfig = BRANDS[brand as BrandKey];
    if (!brandConfig) { send('error', { message: `Unknown brand "${brand}"` }); res.end(); return; }

    const polylangCode = locale === 'en'
      ? 'EN'
      : (LOCALE_META[locale as LocaleCode]?.polylangCode ?? locale.toUpperCase());

    send('status', { message: `Fetching 25 ${locale.toUpperCase()} articles…` });
    const posts = await fetchPostsForProfiling(brandConfig, 25, polylangCode);

    if (posts.length === 0) {
      send('error', { message: `No ${locale.toUpperCase()} articles found` });
      res.end();
      return;
    }

    send('status', { message: `Analysing ${posts.length} articles with Claude…` });

    const profile = await buildBrandVoiceProfile(
      brand as BrandKey,
      brandConfig,
      posts,
      locale,
      (msg) => send('status', { message: msg }),
    );

    send('done', { profile: {
      locale,
      lastUpdated: profile.lastUpdated,
      articleCount: profile.articleCount,
      formality: profile.tone.formality,
      personality: profile.tone.personality,
    }});
  } catch (err) {
    send('error', { message: (err as Error).message });
  }

  res.end();
});

app.listen(PORT, () => {
  console.log(`\nMag Localiser running at http://localhost:${PORT}\n`);
});
