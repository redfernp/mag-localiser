/**
 * Blog Localizer CLI
 *
 * Commands:
 *   profile  --brand <brand>                     Build/refresh brand voice profile
 *   localize --brand <brand> --slug <slug>        Localize one article (all locales)
 *            [--locale <code>]                    ...or a specific locale
 *   batch    --brand <brand>                      Localize all untranslated articles
 *            [--locale <code>]                    ...for a specific locale only
 */

import 'dotenv/config';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { BRANDS, LOCALE_META } from './config/brands.js';
import { fetchPostsForProfiling, fetchPostBySlug, fetchAllSlugs } from './graphql/client.js';
import { buildBrandVoiceProfile } from './agents/profiler.js';
import { localiseArticle } from './agents/localizer.js';
import { loadProfile, profileExists } from './storage/profiles.js';
import type { BrandKey, LocaleCode, LocalisedArticle } from './types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, '../output');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validateBrand(brand: string): BrandKey {
  if (!(brand in BRANDS)) {
    console.error(chalk.red(`Unknown brand "${brand}". Valid: ${Object.keys(BRANDS).join(', ')}`));
    process.exit(1);
  }
  return brand as BrandKey;
}

function validateLocale(locale: string): LocaleCode {
  if (!(locale in LOCALE_META)) {
    console.error(chalk.red(`Unknown locale "${locale}". Valid: ${Object.keys(LOCALE_META).join(', ')}`));
    process.exit(1);
  }
  return locale as LocaleCode;
}

function saveOutput(article: LocalisedArticle): string {
  const dir = join(OUTPUT_DIR, article.brand, article.sourceSlug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${article.targetLocale}.json`);
  writeFileSync(path, JSON.stringify(article, null, 2), 'utf-8');

  // Also write a human-readable text file
  const txtPath = join(dir, `${article.targetLocale}.txt`);
  writeFileSync(txtPath, buildTextExport(article), 'utf-8');

  return path;
}

function stripHtmlForExport(html: string): string {
  return html
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '  • ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildTextExport(article: LocalisedArticle): string {
  const r = article.editorReview;
  const approvedLabel = r.approved ? '✓ APPROVED' : '✗ NEEDS REVIEW';
  const severityIcon = (s: string) => s === 'error' ? '[ERROR]' : s === 'warning' ? '[WARN]' : '[INFO]';

  const lines: string[] = [];

  lines.push('═'.repeat(72));
  lines.push(`BRAND:   ${article.brand.toUpperCase()}`);
  lines.push(`LOCALE:  ${article.targetLocale.toUpperCase()}`);
  lines.push(`SOURCE:  ${article.sourceSlug}`);
  lines.push(`GENERATED: ${article.generatedAt}`);
  lines.push('═'.repeat(72));

  lines.push('');
  lines.push('── ARTICLE ──────────────────────────────────────────────────────────');
  lines.push('');
  lines.push(`TITLE`);
  lines.push(article.title);
  lines.push('');
  lines.push(`SLUG`);
  lines.push(article.slug);
  lines.push('');
  lines.push(`EXCERPT`);
  lines.push(article.excerpt);
  lines.push('');
  lines.push(`CONTENT`);
  lines.push(stripHtmlForExport(article.content));

  lines.push('');
  lines.push('── SEO ──────────────────────────────────────────────────────────────');
  lines.push('');
  lines.push(`Meta Title:        ${article.seo.title}`);
  lines.push(`Meta Description:  ${article.seo.metaDesc}`);
  lines.push(`Focus Keyword:     ${article.seo.focuskw}`);
  lines.push(`OG Title:          ${article.seo.opengraphTitle}`);
  lines.push(`OG Description:    ${article.seo.opengraphDescription}`);
  lines.push(`Twitter Title:     ${article.seo.twitterTitle}`);
  lines.push(`Twitter Desc:      ${article.seo.twitterDescription}`);

  lines.push('');
  lines.push('── EDITOR REVIEW ────────────────────────────────────────────────────');
  lines.push('');
  lines.push(`Overall Score:     ${r.overallScore}/100  ${approvedLabel}`);
  lines.push(`Brand Voice:       ${r.scores.brandVoiceAdherence}/100`);
  lines.push(`Translation:       ${r.scores.translationAccuracy}/100`);
  lines.push(`Cultural Fit:      ${r.scores.culturalFit}/100`);
  lines.push(`SEO:               ${r.scores.seoOptimisation}/100`);
  lines.push(`Readability:       ${r.scores.readability}/100`);

  lines.push('');
  lines.push(`Summary: ${r.summary}`);

  if (r.flags.length) {
    lines.push('');
    lines.push('Flags:');
    r.flags.forEach((f) => {
      lines.push(`  ${severityIcon(f.severity)} [${f.category}] ${f.description}`);
      if (f.sourceText) lines.push(`    Source:     ${f.sourceText}`);
      if (f.translatedText) lines.push(`    Translated: ${f.translatedText}`);
      if (f.suggestion) lines.push(`    Fix:        ${f.suggestion}`);
    });
  }

  if (r.inlineComments.length) {
    lines.push('');
    lines.push('Inline Comments:');
    r.inlineComments.forEach((c) => {
      lines.push(`  [${c.section}] "${c.originalText.slice(0, 80)}${c.originalText.length > 80 ? '…' : ''}"`);
      lines.push(`    ${c.comment}`);
      if (c.revisedSuggestion) lines.push(`    → ${c.revisedSuggestion}`);
    });
  }

  lines.push('');
  lines.push('═'.repeat(72));

  return lines.join('\n');
}

function printReviewSummary(article: LocalisedArticle): void {
  const r = article.editorReview;
  const scoreColour = r.overallScore >= 75 ? chalk.green : r.overallScore >= 50 ? chalk.yellow : chalk.red;
  const approvedLabel = r.approved ? chalk.green('✓ APPROVED') : chalk.red('✗ NEEDS REVIEW');

  console.log();
  console.log(chalk.bold('  Editor Review'));
  console.log(`  Overall score:  ${scoreColour(r.overallScore + '/100')}  ${approvedLabel}`);
  console.log(`  Brand voice:    ${r.scores.brandVoiceAdherence}/100`);
  console.log(`  Translation:    ${r.scores.translationAccuracy}/100`);
  console.log(`  Cultural fit:   ${r.scores.culturalFit}/100`);
  console.log(`  SEO:            ${r.scores.seoOptimisation}/100`);
  console.log(`  Readability:    ${r.scores.readability}/100`);

  if (r.flags.length) {
    console.log();
    console.log(chalk.bold('  Flags'));
    r.flags.forEach((f) => {
      const icon = f.severity === 'error' ? chalk.red('✗') : f.severity === 'warning' ? chalk.yellow('⚠') : chalk.blue('›');
      console.log(`  ${icon} [${f.category}] ${f.description}`);
      if (f.suggestion) console.log(`    ${chalk.dim('→')} ${chalk.dim(f.suggestion)}`);
    });
  }

  if (r.inlineComments.length) {
    console.log();
    console.log(chalk.bold('  Inline Comments'));
    r.inlineComments.slice(0, 5).forEach((c) => {
      console.log(`  [${c.section}] ${chalk.dim(c.originalText.slice(0, 60))}…`);
      console.log(`    ${c.comment}`);
      if (c.revisedSuggestion) console.log(`    ${chalk.dim('→')} ${chalk.italic(c.revisedSuggestion.slice(0, 80))}`);
    });
    if (r.inlineComments.length > 5) {
      console.log(chalk.dim(`  + ${r.inlineComments.length - 5} more inline comments in output file`));
    }
  }

  console.log();
  console.log(chalk.dim(`  "${r.summary}"`));
  console.log();
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const program = new Command();
program.name('blog-localizer').version('1.0.0');

// profile ──────────────────────────────────────────────────────────────────────
program
  .command('profile')
  .description('Build or refresh the brand voice profile from existing articles')
  .requiredOption('--brand <brand>', 'Brand key: dope-snow | montecwear | ridestore')
  .requiredOption('--locale <code>', 'Locale to profile: en | it | sv | fr | de | nl | fi | da')
  .option('--articles <n>', 'Number of articles to analyse', '25')
  .option('--force', 'Rebuild even if a profile already exists')
  .action(async (opts) => {
    const brand = validateBrand(opts.brand);
    const brandConfig = BRANDS[brand];
    const locale = opts.locale.toLowerCase();
    const limit = parseInt(opts.articles, 10);

    // Resolve the Polylang uppercase code for the GraphQL query
    const polylangCode = locale === 'en'
      ? 'EN'
      : (LOCALE_META[locale as LocaleCode]?.polylangCode ?? locale.toUpperCase());

    if (profileExists(brand, locale) && !opts.force) {
      console.log(chalk.yellow(`Profile for ${brandConfig.name} (${locale}) already exists. Use --force to rebuild.`));
      process.exit(0);
    }

    if (!brandConfig.endpoint) {
      console.error(chalk.red(`No GraphQL endpoint configured for ${brandConfig.name}. Check your .env file.`));
      process.exit(1);
    }

    const spinner = ora(`Fetching ${limit} ${locale.toUpperCase()} articles from ${brandConfig.name}…`).start();

    try {
      const posts = await fetchPostsForProfiling(brandConfig, limit, polylangCode);
      spinner.succeed(`Fetched ${posts.length} articles`);

      if (posts.length === 0) {
        spinner.fail(`No ${locale.toUpperCase()} articles found — check the locale code and that Polylang is active`);
        process.exit(1);
      }

      const profile = await buildBrandVoiceProfile(brand, brandConfig, posts, locale, (msg) => {
        spinner.text = msg;
        spinner.start();
      });

      spinner.succeed(`Brand voice profile built for ${chalk.bold(brandConfig.name)} (${chalk.bold(locale)})`);
      console.log(chalk.dim(`  Articles analysed: ${profile.articleCount}`));
      console.log(chalk.dim(`  Formality: ${profile.tone.formality}`));
      console.log(chalk.dim(`  Personality: ${profile.tone.personality.join(', ')}`));
      console.log(chalk.dim(`  Profile saved to profiles/${brand}-${locale}.json`));
    } catch (err) {
      spinner.fail();
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

// localize ─────────────────────────────────────────────────────────────────────
program
  .command('localize')
  .description('Localise a single article (all locales or one specific locale)')
  .requiredOption('--brand <brand>', 'Brand key: dope-snow | montecwear | ridestore')
  .requiredOption('--slug <slug>', 'WordPress post slug of the English source article')
  .option('--locale <code>', 'Target locale (omit to run all brand locales)')
  .action(async (opts) => {
    const brand = validateBrand(opts.brand);
    const brandConfig = BRANDS[brand];
    const targetLocales: LocaleCode[] = opts.locale
      ? [validateLocale(opts.locale)]
      : brandConfig.locales;

    const enProfile = loadProfile(brand, 'en');
    if (!enProfile) {
      console.error(chalk.red(`No EN profile found for ${brandConfig.name}. Run: npm run profile -- --brand ${brand} --locale en`));
      process.exit(1);
    }

    const spinner = ora(`Fetching "${opts.slug}" from ${brandConfig.name}…`).start();
    let post;
    try {
      post = await fetchPostBySlug(brandConfig, opts.slug);
      spinner.succeed(`Fetched "${post.title}"`);
    } catch (err) {
      spinner.fail();
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }

    // Check which locales already have translations
    const existingLocaleCodes = (post.translations ?? []).map((t) =>
      t.language.code.toLowerCase(),
    );

    for (const locale of targetLocales) {
      const meta = LOCALE_META[locale];

      if (existingLocaleCodes.includes(meta.polylangCode.toLowerCase())) {
        console.log(chalk.dim(`  ${meta.name} — already translated, skipping`));
        continue;
      }

      const spinner2 = ora(`  Localising to ${chalk.bold(meta.name)}…`).start();

      try {
        // Load the target locale profile if one has been built — gives the editor
        // real examples of approved translations to compare against
        const targetProfile = loadProfile(brand, locale) ?? undefined;
        const article = await localiseArticle(brand, post, locale, meta, enProfile, targetProfile, undefined, brandConfig.voiceGuide);
        const outputPath = saveOutput(article);
        spinner2.succeed(`  ${meta.name} — done`);
        printReviewSummary(article);
        console.log(chalk.dim(`  Output: ${outputPath}`));
      } catch (err) {
        spinner2.fail(`  ${meta.name} — failed`);
        console.error(chalk.red(`  ${(err as Error).message}`));
      }
    }
  });

// batch ────────────────────────────────────────────────────────────────────────
program
  .command('batch')
  .description('Localise all untranslated EN articles for a brand')
  .requiredOption('--brand <brand>', 'Brand key: dope-snow | montecwear | ridestore')
  .option('--locale <code>', 'Target locale (omit for all brand locales)')
  .option('--limit <n>', 'Max articles to process (default: all)')
  .action(async (opts) => {
    const brand = validateBrand(opts.brand);
    const brandConfig = BRANDS[brand];
    const targetLocales: LocaleCode[] = opts.locale
      ? [validateLocale(opts.locale)]
      : brandConfig.locales;

    const enProfile = loadProfile(brand, 'en');
    if (!enProfile) {
      console.error(chalk.red(`No EN profile found for ${brandConfig.name}. Run: npm run profile -- --brand ${brand} --locale en`));
      process.exit(1);
    }

    const spinner = ora(`Fetching all slugs from ${brandConfig.name}…`).start();
    let slugNodes;
    try {
      slugNodes = await fetchAllSlugs(brandConfig);
      spinner.succeed(`Found ${slugNodes.length} EN articles`);
    } catch (err) {
      spinner.fail();
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }

    const limit = opts.limit ? parseInt(opts.limit, 10) : Infinity;
    let processed = 0;

    for (const node of slugNodes) {
      if (processed >= limit) break;

      const existingCodes = node.translations.map((t) => t.language.code.toLowerCase());
      const pendingLocales = targetLocales.filter(
        (l) => !existingCodes.includes(LOCALE_META[l].polylangCode.toLowerCase()),
      );

      if (pendingLocales.length === 0) continue;

      console.log(chalk.bold(`\n[${processed + 1}] ${node.slug}`));

      let post;
      try {
        post = await fetchPostBySlug(brandConfig, node.slug);
      } catch (err) {
        console.error(chalk.red(`  Fetch failed: ${(err as Error).message}`));
        continue;
      }

      for (const locale of pendingLocales) {
        const meta = LOCALE_META[locale];
        const spinner2 = ora(`  ${meta.name}…`).start();

        try {
          const targetProfile = loadProfile(brand, locale) ?? undefined;
          const article = await localiseArticle(brand, post, locale, meta, enProfile, targetProfile, undefined, brandConfig.voiceGuide);
          saveOutput(article);
          const r = article.editorReview;
          const status = r.approved ? chalk.green(`✓ ${r.overallScore}/100`) : chalk.yellow(`⚠ ${r.overallScore}/100`);
          spinner2.succeed(`  ${meta.name} ${status}`);
        } catch (err) {
          spinner2.fail(`  ${meta.name} — ${(err as Error).message}`);
        }
      }

      processed++;
    }

    console.log(chalk.green(`\nBatch complete. Processed ${processed} article(s).`));
  });

program.parse();
