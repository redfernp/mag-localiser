/**
 * Mag Localiser — Web Server
 *
 * Exposes the localisation engine as a web app.
 * Uses Server-Sent Events (SSE) for streaming so the browser stays live
 * during the 3–5 minute localisation process without timing out.
 */

import 'dotenv/config';
import express from 'express';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { BRANDS, LOCALE_META } from './config/brands.js';
import { fetchAllSlugs, fetchPostBySlug, fetchPostsForProfiling } from './graphql/client.js';
import { loadProfile, profileExists } from './storage/profiles.js';
import { localiseArticle } from './agents/localizer.js';
import { buildBrandVoiceProfile } from './agents/profiler.js';
import { saveOutput, OUTPUT_DIR } from './utils/output.js';
import type { BrandKey, LocaleCode } from './types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
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

    const article = await localiseArticle(
      brand as BrandKey,
      post,
      locale as LocaleCode,
      localeMeta,
      enProfile,
      targetProfile,
      (token) => send('token', { token }),
      brandConfig.voiceGuide,
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
      strictMode: (meta as { strictMode?: boolean }).strictMode ?? false,
      exists: !!profile,
      lastUpdated: profile?.lastUpdated ?? null,
      articleCount: profile?.articleCount ?? null,
      formality: profile?.tone?.formality ?? null,
      personality: profile?.tone?.personality ?? [],
    };
  });

  res.json({ profiles });
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
