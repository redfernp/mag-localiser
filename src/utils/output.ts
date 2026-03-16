import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { LOCALE_META } from '../config/brands.js';
import type { LocalisedArticle } from '../types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const OUTPUT_DIR = join(__dirname, '../../output');

export function stripHtmlForExport(html: string): string {
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

export function buildTextExport(article: LocalisedArticle): string {
  const r = article.editorReview;
  const approvedLabel = r.approved ? '✓ APPROVED' : '✗ NEEDS REVIEW';
  const severityIcon = (s: string) =>
    s === 'error' ? '[ERROR]' : s === 'warning' ? '[WARN]' : '[INFO]';
  const strictMeta = LOCALE_META[article.targetLocale];

  const lines: string[] = [];

  lines.push('═'.repeat(72));
  lines.push(`BRAND:   ${article.brand.toUpperCase()}`);
  lines.push(`LOCALE:  ${article.targetLocale.toUpperCase()}`);
  lines.push(`SOURCE:  ${article.sourceSlug}`);
  lines.push(`GENERATED: ${article.generatedAt}`);
  lines.push(
    `STRICT MODE: ${strictMeta?.strictMode ? 'ON (no human reviewer — vocabulary overrides applied)' : 'OFF (human reviewer assigned)'}`,
  );
  lines.push('═'.repeat(72));

  lines.push('');
  lines.push('── ARTICLE ──────────────────────────────────────────────────────────');
  lines.push('');
  lines.push('TITLE');
  lines.push(article.title);
  lines.push('');
  lines.push('SLUG');
  lines.push(article.slug);
  lines.push('');
  lines.push('EXCERPT');
  lines.push(article.excerpt);
  lines.push('');
  lines.push('CONTENT');
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
      lines.push(
        `  [${c.section}] "${c.originalText.slice(0, 80)}${c.originalText.length > 80 ? '…' : ''}"`,
      );
      lines.push(`    ${c.comment}`);
      if (c.revisedSuggestion) lines.push(`    → ${c.revisedSuggestion}`);
    });
  }

  lines.push('');
  lines.push('═'.repeat(72));

  return lines.join('\n');
}

export function saveOutput(article: LocalisedArticle): string {
  const dir = join(OUTPUT_DIR, article.brand, article.sourceSlug);
  mkdirSync(dir, { recursive: true });
  const jsonPath = join(dir, `${article.targetLocale}.json`);
  const txtPath = join(dir, `${article.targetLocale}.txt`);
  writeFileSync(jsonPath, JSON.stringify(article, null, 2), 'utf-8');
  writeFileSync(txtPath, buildTextExport(article), 'utf-8');
  return jsonPath;
}
