/**
 * Brand Voice Profiler
 *
 * Fetches existing English articles from WordPress and uses Claude Opus to
 * extract a detailed, structured brand voice profile. The profile is cached to
 * disk and used as a prompt-cached system prompt by the localizer and editor.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { BrandKey, BrandVoiceProfile, WPPost } from '../types/index.js';
import type { BrandConfig } from '../config/brands.js';
import { saveProfile } from '../storage/profiles.js';

const client = new Anthropic();

/**
 * Fix unescaped double-quotes inside JSON string values.
 * Claude sometimes uses "word" as quotation marks in German/French prose, breaking JSON.parse.
 * Strategy: scan char-by-char; when inside a string, a " is a closing quote only if the next
 * non-whitespace char is a JSON structural character (:  ,  }  ]).  Otherwise escape it.
 */
function repairInnerQuotes(json: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < json.length; i++) {
    const char = json[i];

    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      result += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      if (!inString) {
        inString = true;
        result += char;
      } else {
        // Peek ahead past whitespace to see what follows
        let j = i + 1;
        while (j < json.length && ' \t\n\r'.includes(json[j])) j++;
        const next = json[j];
        if (next === ':' || next === ',' || next === '}' || next === ']' || j >= json.length) {
          // Structural closing quote
          inString = false;
          result += char;
        } else {
          // Inner content quote — escape it
          result += '\\"';
        }
      }
      continue;
    }

    result += char;
  }

  return result;
}

/** Strip HTML tags for cleaner analysis. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildAnalysisPrompt(brandName: string, posts: WPPost[]): string {
  const articlesText = posts
    .map(
      (p, i) => `
--- ARTICLE ${i + 1} ---
TITLE: ${p.title}
META DESCRIPTION: ${p.seo?.metaDesc ?? '(none)'}
FOCUS KEYWORD: ${p.seo?.focuskw ?? '(none)'}

EXCERPT:
${stripHtml(p.excerpt)}

CONTENT:
${stripHtml(p.content).slice(0, 1500)}
`.trim(),
    )
    .join('\n\n');

  return `You are a senior brand strategist and copywriter. Analyse the following ${posts.length} blog articles from ${brandName} and extract a comprehensive brand voice profile.

${articlesText}

---

Return a JSON object with EXACTLY this structure (no markdown, no prose, just the JSON).

CRITICAL JSON RULES:
- All array values must be plain quoted strings — no parenthetical notes, no annotations, no extra text outside the quotes
- Wrong: ["Anfänger" (stattdessen 'jedes Level')]
- Right: ["Anfänger", "jedes Level"]
- Never add explanatory text after a closing quote inside an array
- All string values must be valid JSON — use only straight ASCII double quotes for JSON structure

{
  "tone": {
    "formality": "casual" | "semi-formal" | "formal",
    "personality": ["trait1", "trait2", "trait3"],
    "emotionalRegister": "description of emotional quality",
    "pointOfView": "e.g. second-person direct address / third-person / first-person plural"
  },
  "style": {
    "sentenceLength": "short" | "medium" | "long" | "mixed",
    "paragraphLength": "description",
    "headingStyle": "description of how headings are written",
    "useOfLists": "description",
    "useOfEmoji": true | false,
    "punctuationNotes": "any distinctive punctuation habits",
    "activeVsPassive": "predominantly active / passive / mixed"
  },
  "vocabulary": {
    "brandTerms": ["term1", "term2"],
    "avoidTerms": ["term1", "term2"],
    "preferredPhrases": ["phrase1", "phrase2", "phrase3"],
    "ctaPatterns": ["pattern1", "pattern2"]
  },
  "contentPatterns": {
    "introStyle": "description of how articles typically open",
    "outroStyle": "description of how articles typically close",
    "headlineFormula": "description of headline patterns",
    "metaDescriptionStyle": "description of meta description patterns",
    "excerptStyle": "description of excerpt patterns"
  },
  "examples": {
    "headline": "best example headline from the articles",
    "intro": "best example opening paragraph",
    "bodyParagraph": "best example body paragraph",
    "metaDescription": "best example meta description"
  },
  "systemPromptInstructions": "A concise paragraph (150–200 words) that a translator can use as a writing brief. Describe the brand voice as if instructing a new copywriter. Include tone, vocabulary rules, what to avoid, and what makes this brand distinctive."
}`;
}

function buildSystemPrompt(brandName: string, instructions: string): string {
  return `You are an expert localisation specialist working exclusively for ${brandName}.

BRAND VOICE BRIEF:
${instructions}

CORE RULES:
1. Always write in the target language — never mix languages.
2. Preserve the brand's personality and tone exactly as described in the brief above.
3. Adapt idioms and cultural references for the target locale — do not translate them literally.
4. Maintain all brand terms exactly as specified; do not translate brand names or product names unless an official localised version exists.
5. Keep the same structural rhythm as the source — if the original is punchy and short, the translation must be too.
6. SEO fields (meta title, meta description, focus keyword) must be naturally optimised for the target locale's search behaviour, not just translated word-for-word.
7. The slug should be a clean, lowercase, hyphenated URL-safe string in the target language.`;
}

export async function buildBrandVoiceProfile(
  brand: BrandKey,
  brandConfig: BrandConfig,
  posts: WPPost[],
  locale: string,
  onProgress?: (msg: string) => void,
): Promise<BrandVoiceProfile> {
  onProgress?.(`Analysing ${posts.length} articles with Claude Opus…`);

  const prompt = buildAnalysisPrompt(brandConfig.name, posts);

  const stream = client.messages.stream({
    model: 'claude-opus-4-6',
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }],
  });

  let rawJson = '';
  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      rawJson += event.delta.text;
    }
  }

  // Strip any accidental markdown fences
  rawJson = rawJson.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();

  // Replace typographic/curly quotation marks with straight ASCII equivalents
  // so they don't break JSON.parse (common in DE/FR: „text", «text»)
  rawJson = rawJson
    .replace(/„/g, "'")   // German lower-9 open quote → single quote
    .replace(/\u201C/g, "'")  // Left double quotation mark → single quote
    .replace(/\u201D/g, "'")  // Right double quotation mark → single quote
    .replace(/«/g, "'")   // French guillemet open → single quote
    .replace(/»/g, "'");  // French guillemet close → single quote

  // Remove parenthetical annotations that Claude sometimes adds after quoted array items,
  // e.g. "Anfänger" (stattdessen 'jedes Level') → "Anfänger"
  // These appear as: "someterm" (annotation text) followed by , or ]
  rawJson = rawJson.replace(/"([^"]*?)"\s*\([^)]*\)\s*(?=[,\]])/g, '"$1"');

  // Fix unescaped double-quotes inside JSON string values.
  // Claude sometimes uses "word" or "phrase" as quotation marks within German/French prose,
  // which breaks JSON.parse. We scan the raw text and escape any " that isn't a structural
  // JSON quote (i.e. followed by whitespace+colon, comma, } or ]).
  rawJson = repairInnerQuotes(rawJson);

  let parsed: {
    tone: BrandVoiceProfile['tone'];
    style: BrandVoiceProfile['style'];
    vocabulary: BrandVoiceProfile['vocabulary'];
    contentPatterns: BrandVoiceProfile['contentPatterns'];
    examples: BrandVoiceProfile['examples'];
    systemPromptInstructions: string;
  };

  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    // Write full output to a temp file for debugging
    const { writeFileSync } = await import('fs');
    writeFileSync('profiler-debug.json', rawJson, 'utf-8');
    throw new Error(`Failed to parse brand voice JSON from Claude (full output written to profiler-debug.json):\n${rawJson.slice(0, 800)}`);
  }

  const profile: BrandVoiceProfile = {
    brand,
    locale,
    lastUpdated: new Date().toISOString(),
    articleCount: posts.length,
    tone: parsed.tone,
    style: parsed.style,
    vocabulary: parsed.vocabulary,
    contentPatterns: parsed.contentPatterns,
    examples: parsed.examples,
    systemPrompt: buildSystemPrompt(brandConfig.name, parsed.systemPromptInstructions),
  };

  saveProfile(profile);
  onProgress?.(`Profile saved for ${brandConfig.name}`);

  return profile;
}
