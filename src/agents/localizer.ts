/**
 * Localizer Agent
 *
 * Takes a source English article + brand voice profile and produces a fully
 * localised article. The brand voice system prompt is sent with cache_control
 * so it's only charged once per brand per session.
 *
 * Streaming is used throughout so long articles don't time out.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.js';
import type { BrandKey, BrandVoiceProfile, LocaleCode, LocalisedArticle, WPPost } from '../types/index.js';
import type { LocaleMeta } from '../config/brands.js';
import { runEditorReview } from './editor.js';

const client = new Anthropic();

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildLocalisationPrompt(
  post: WPPost,
  locale: LocaleMeta,
): string {
  const seo = post.seo;
  const lead = post.lead?.lead?.trim() ?? stripHtml(post.excerpt);

  return `Localise the following English blog article into ${locale.name} (${locale.nativeName}).

CULTURAL NOTES FOR ${locale.name.toUpperCase()}:
${locale.culturalNotes}

SOURCE ARTICLE:
TITLE: ${post.title}
SLUG: ${post.slug}
EXCERPT (the article lead — translate this text exactly, do not rewrite or replace it): ${lead}
META TITLE: ${seo?.title ?? post.title}
META DESCRIPTION: ${seo?.metaDesc ?? ''}
FOCUS KEYWORD: ${seo?.focuskw ?? ''}
OPENGRAPH TITLE: ${seo?.opengraphTitle ?? ''}
OPENGRAPH DESCRIPTION: ${seo?.opengraphDescription ?? ''}
TWITTER TITLE: ${seo?.twitterTitle ?? ''}
TWITTER DESCRIPTION: ${seo?.twitterDescription ?? ''}

CONTENT (HTML — preserve all HTML tags exactly, only translate text content):
${post.content}

---

Return a JSON object with EXACTLY this structure (no markdown, no prose, just the JSON):

{
  "title": "localised title",
  "slug": "url-safe-localised-slug",
  "excerpt": "localised excerpt as plain text (no HTML)",
  "content": "localised content preserving all original HTML tags",
  "seo": {
    "title": "localised SEO title (50–60 chars)",
    "metaDesc": "localised meta description (150–160 chars, naturally integrates focus keyword)",
    "focuskw": "primary focus keyword in ${locale.name}",
    "opengraphTitle": "localised OG title",
    "opengraphDescription": "localised OG description",
    "twitterTitle": "localised Twitter card title",
    "twitterDescription": "localised Twitter card description"
  }
}

IMPORTANT:
- HTML tags must be preserved exactly — only the text content inside tags should be translated.
- The slug must be lowercase, hyphenated, and URL-safe in ${locale.name}.
- SEO fields must be optimised for ${locale.name} search behaviour, not literal translations.
- Do NOT include the JSON in markdown code fences.`;
}

export async function localiseArticle(
  brand: BrandKey,
  post: WPPost,
  locale: LocaleCode,
  localeMeta: LocaleMeta,
  enProfile: BrandVoiceProfile,
  targetProfile?: BrandVoiceProfile,
  onToken?: (text: string) => void,
  voiceGuide?: string,
): Promise<LocalisedArticle> {
  const userPrompt = buildLocalisationPrompt(post, localeMeta);

  // Build system prompt blocks.
  // Block 1: EN profile — empirically derived brand voice (cached).
  // Block 2: CMO voice guide — prescriptive rules, words to avoid, rhythm patterns (cached).
  //           The guide takes priority over the profile when they conflict.
  // Block 3: Target locale profile (if built) — approved translation examples (cached).
  // All blocks are cached so batch runs cost ~90% less on the system prompt.
  const systemBlocks: TextBlockParam[] = [
    {
      type: 'text',
      text: enProfile.systemPrompt,
      cache_control: { type: 'ephemeral' },
    } satisfies TextBlockParam,
  ];

  if (voiceGuide) {
    systemBlocks.push({
      type: 'text',
      text: `PRESCRIPTIVE BRAND VOICE RULES (CMO-authored — these take priority over the profile above when they conflict):\n\n${voiceGuide}`,
      cache_control: { type: 'ephemeral' },
    } satisfies TextBlockParam);
  }

  if (localeMeta.strictMode) {
    systemBlocks.push({
      type: 'text',
      text: `STRICT MODE — NO HUMAN REVIEWER ASSIGNED FOR THIS LOCALE.

The following rules are NON-NEGOTIABLE and override any vocabulary or examples in the brand profile above. A human will not be reviewing this output before it is used, so apply these restrictions absolutely.

NEVER use the following words or their direct equivalents in the target language:
- ultimate / ultimat / ultimativ / ultime / definitief / ultimata / ultimainen
- perfect / perfekt / parfait / perfecte / perfetto / perfecta / täydellinen (in marketing praise contexts)
- unbeatable / unschlagbar / imbattable / onverslaanbaar / imbattibile / imbatible
- revolutionary / revolutionär / révolutionnaire / revolutionair / rivoluzionario / revolucionario
- world-class / weltklasse / de classe mondiale / wereldklasse / di classe mondiale
- innovative solution / cutting-edge / state-of-the-art / best-in-class / industry-leading / next-generation
- dominate / conquer / crush (in marketing contexts)
- insane (as praise)
- purchase now / order today / click here to buy (and direct translations)

If the source article contains any of these terms, replace them with grounded, specific, on-brand alternatives. Do not translate banned terms literally — rewrite the phrase.`,
      cache_control: { type: 'ephemeral' },
    } satisfies TextBlockParam);
  }

  if (targetProfile) {
    const targetBrief = `APPROVED ${localeMeta.name.toUpperCase()} VOICE EXAMPLES (learn from these real approved translations):
Formality in ${localeMeta.name}: ${targetProfile.tone.formality}
Personality traits observed: ${targetProfile.tone.personality.join(', ')}
Point of view: ${targetProfile.tone.pointOfView}
Preferred phrases: ${targetProfile.vocabulary.preferredPhrases.slice(0, 5).join('; ')}
Typical intro style: ${targetProfile.contentPatterns.introStyle}
Example approved headline: ${targetProfile.examples.headline}
Example approved intro: ${targetProfile.examples.intro}`;

    systemBlocks.push({
      type: 'text',
      text: targetBrief,
      cache_control: { type: 'ephemeral' },
    } satisfies TextBlockParam);
  }

  const stream = client.messages.stream({
    model: 'claude-opus-4-6',
    max_tokens: 8192,
    system: systemBlocks,
    messages: [{ role: 'user', content: userPrompt }],
  });

  let rawJson = '';

  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      rawJson += event.delta.text;
      onToken?.(event.delta.text);
    }
  }

  rawJson = rawJson.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();

  let parsed: {
    title: string;
    slug: string;
    excerpt: string;
    content: string;
    seo: LocalisedArticle['seo'];
  };

  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error(`Failed to parse localisation JSON from Claude:\n${rawJson.slice(0, 500)}`);
  }

  // Run editor review immediately after localisation
  const editorReview = await runEditorReview(post, parsed, locale, localeMeta, enProfile, targetProfile, voiceGuide);

  return {
    brand,
    sourceSlug: post.slug,
    sourceLocale: 'en',
    targetLocale: locale,
    generatedAt: new Date().toISOString(),
    title: parsed.title,
    slug: parsed.slug,
    content: parsed.content,
    excerpt: parsed.excerpt,
    seo: parsed.seo,
    editorReview,
  };
}
