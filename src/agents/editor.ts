/**
 * Editor Review Agent
 *
 * Compares a localised article draft against the source and brand voice profile,
 * then returns structured feedback using Claude's structured outputs (Zod schema).
 *
 * The review is always run automatically after localisation — the internal
 * team sees scores, flags, and inline comments before deciding to publish.
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { BrandVoiceProfile, EditorReview, LocaleCode, WPPost } from '../types/index.js';
import type { LocaleMeta } from '../config/brands.js';

const client = new Anthropic();

// ─── Zod schema for the structured review output ──────────────────────────────

const EditorFlagSchema = z.object({
  severity: z.enum(['error', 'warning', 'suggestion']),
  category: z.enum(['brand-voice', 'translation', 'cultural', 'seo', 'readability']),
  description: z.string(),
  sourceText: z.string().nullish().transform(v => v ?? undefined),
  translatedText: z.string().nullish().transform(v => v ?? undefined),
  suggestion: z.string().nullish().transform(v => v ?? undefined),
});

const InlineCommentSchema = z.object({
  section: z.enum(['title', 'slug', 'content', 'excerpt', 'seo']),
  originalText: z.string(),
  comment: z.string(),
  revisedSuggestion: z.string().nullish().transform(v => v ?? undefined),
});

const EditorReviewSchema = z.object({
  overallScore: z.number().min(0).max(100),
  scores: z.object({
    brandVoiceAdherence: z.number().min(0).max(100),
    translationAccuracy: z.number().min(0).max(100),
    culturalFit: z.number().min(0).max(100),
    seoOptimisation: z.number().min(0).max(100),
    readability: z.number().min(0).max(100),
  }),
  flags: z.array(EditorFlagSchema),
  inlineComments: z.array(InlineCommentSchema),
  summary: z.string(),
  approved: z.boolean(),
});

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildEditorPrompt(
  source: WPPost,
  localised: { title: string; slug: string; excerpt: string; content: string; seo: Record<string, string> },
  localeName: string,
  culturalNotes: string,
  profile: BrandVoiceProfile,
  voiceGuide?: string,
): string {
  const vocabSummary = [
    `Brand terms to always use: ${profile.vocabulary.brandTerms.join(', ') || 'none specified'}`,
    `Terms to avoid: ${profile.vocabulary.avoidTerms.join(', ') || 'none specified'}`,
    `Preferred phrases: ${profile.vocabulary.preferredPhrases.slice(0, 5).join('; ')}`,
  ].join('\n');

  const voiceGuideSection = voiceGuide
    ? `\nCMO BRAND VOICE RULES (use these as primary scoring criteria for Brand Voice Adherence):\n${voiceGuide}\n`
    : '';

  return `You are a senior editor reviewing a ${localeName} localisation of a blog article for ${profile.brand}.

BRAND VOICE SUMMARY (empirically derived from published articles):
Formality: ${profile.tone.formality}
Personality: ${profile.tone.personality.join(', ')}
Point of view: ${profile.tone.pointOfView}
${vocabSummary}
${voiceGuideSection}
CULTURAL NOTES FOR ${localeName.toUpperCase()}:
${culturalNotes}

---

SOURCE ARTICLE (English):
TITLE: ${source.title}
EXCERPT/LEAD: ${(source.lead?.lead?.trim() ?? source.excerpt.replace(/<[^>]+>/g, ' ').trim())}
META DESC: ${source.seo?.metaDesc ?? ''}
FOCUS KW: ${source.seo?.focuskw ?? ''}
CONTENT (first 1000 chars): ${source.content.replace(/<[^>]+>/g, ' ').trim().slice(0, 1000)}

---

LOCALISED ARTICLE (${localeName}):
TITLE: ${localised.title}
SLUG: ${localised.slug}
EXCERPT: ${localised.excerpt}
META DESC: ${localised.seo.metaDesc ?? ''}
FOCUS KW: ${localised.seo.focuskw ?? ''}
CONTENT (first 1000 chars): ${localised.content.replace(/<[^>]+>/g, ' ').trim().slice(0, 1000)}

---

Review the localisation across these dimensions:
1. Brand Voice Adherence — Does it sound like ${profile.brand}? Are brand terms respected?
2. Translation Accuracy — Is the meaning faithfully preserved? Any mistranslations or omissions?
3. Cultural Fit — Are idioms adapted appropriately? Does it feel native to ${localeName} speakers?
4. SEO Optimisation — Are meta fields naturally optimised for ${localeName} search behaviour?
5. Readability — Is the text fluent and natural in ${localeName}?

Return a JSON object with EXACTLY this structure — no other keys, no nested objects inside scores:

{
  "overallScore": <weighted average 0-100>,
  "scores": {
    "brandVoiceAdherence": <0-100>,
    "translationAccuracy": <0-100>,
    "culturalFit": <0-100>,
    "seoOptimisation": <0-100>,
    "readability": <0-100>
  },
  "flags": [
    {
      "severity": "error" | "warning" | "suggestion",
      "category": "brand-voice" | "translation" | "cultural" | "seo" | "readability",
      "description": "specific description",
      "sourceText": "optional original text",
      "translatedText": "optional translated text",
      "suggestion": "optional fix"
    }
  ],
  "inlineComments": [
    {
      "section": "title" | "slug" | "content" | "excerpt" | "seo",
      "originalText": "the passage",
      "comment": "what the issue is",
      "revisedSuggestion": "optional improved version"
    }
  ],
  "summary": "2-3 sentence overall assessment",
  "approved": <true if overallScore >= 75 AND no error-severity flags, otherwise false>
}`;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runEditorReview(
  source: WPPost,
  localised: { title: string; slug: string; excerpt: string; content: string; seo: Record<string, string> },
  _locale: LocaleCode,
  localeMeta: LocaleMeta,
  profile: BrandVoiceProfile,
  targetProfile?: BrandVoiceProfile,
  voiceGuide?: string,
): Promise<EditorReview> {
  // Append real approved translation examples when available — makes
  // the editor's brand voice comparisons far more accurate.
  const targetExamples = targetProfile
    ? `\nAPPROVED ${localeMeta.name.toUpperCase()} EXAMPLES FROM REAL TRANSLATIONS:\nHeadline: ${targetProfile.examples.headline}\nIntro: ${targetProfile.examples.intro}\nMeta: ${targetProfile.examples.metaDescription}`
    : '';

  const prompt = buildEditorPrompt(
    source,
    localised,
    localeMeta.name,
    localeMeta.culturalNotes + targetExamples,
    profile,
    voiceGuide,
  );

  // Use structured JSON output so the review is always machine-readable.
  // We instruct Claude to return only JSON and validate with Zod.
  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 8192,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    thinking: { type: 'adaptive' } as any,
    system: `You are a professional localisation editor. Return ONLY a valid JSON object — no prose, no markdown fences. Be specific — generic feedback is not useful.`,
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  if (!textBlock) {
    throw new Error('Editor review returned no text content');
  }

  let rawJson = textBlock.text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();

  let raw: unknown;
  try {
    raw = JSON.parse(rawJson);
  } catch {
    throw new Error(`Failed to parse editor review JSON:\n${rawJson.slice(0, 500)}`);
  }

  return EditorReviewSchema.parse(raw);
}
