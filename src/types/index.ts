export type BrandKey = 'dope-snow' | 'montecwear' | 'ridestore';

export type LocaleCode = 'sv' | 'fr' | 'de' | 'nl' | 'es' | 'it' | 'fi' | 'da';

// ─── WPGraphQL raw types ──────────────────────────────────────────────────────

export interface WPPost {
  id: string;
  slug: string;
  title: string;
  content: string;
  excerpt: string;
  lead?: { lead: string };
  date: string;
  language?: {
    code: string;
    locale: string;
    name: string;
  };
  translations?: Array<{
    id: string;
    slug: string;
    language: { code: string; locale: string };
  }>;
  seo?: {
    title: string;
    metaDesc: string;
    focuskw: string;
    opengraphTitle: string;
    opengraphDescription: string;
    twitterTitle: string;
    twitterDescription: string;
    canonical: string;
  };
}

export interface WPPostsResponse {
  posts: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: WPPost[];
  };
}

export interface WPSinglePostResponse {
  postBy: WPPost | null;
}

// ─── Brand voice profile ──────────────────────────────────────────────────────

export interface BrandVoiceProfile {
  brand: BrandKey;
  /** ISO locale code this profile was built from: 'en', 'it', 'sv', etc. */
  locale: string;
  lastUpdated: string;
  articleCount: number;
  /**
   * Per-profile strict mode override. When set, takes precedence over LOCALE_META.strictMode.
   * Undefined means fall back to the LOCALE_META default.
   */
  strictModeOverride?: boolean;

  tone: {
    formality: 'casual' | 'semi-formal' | 'formal';
    personality: string[];        // e.g. ['adventurous', 'technical', 'inspiring']
    emotionalRegister: string;    // e.g. 'enthusiastic but grounded'
    pointOfView: string;          // e.g. 'second-person direct address'
  };

  style: {
    sentenceLength: 'short' | 'medium' | 'long' | 'mixed';
    paragraphLength: string;
    headingStyle: string;
    useOfLists: string;
    useOfEmoji: boolean;
    punctuationNotes: string;
    activeVsPassive: string;
  };

  vocabulary: {
    brandTerms: string[];         // Must always use these exact terms
    avoidTerms: string[];         // Never use these
    preferredPhrases: string[];   // Common expressions the brand favours
    ctaPatterns: string[];        // Call-to-action patterns
  };

  contentPatterns: {
    introStyle: string;
    outroStyle: string;
    headlineFormula: string;
    metaDescriptionStyle: string;
    excerptStyle: string;
  };

  /** Representative examples pulled from real articles for use in prompts */
  examples: {
    headline: string;
    intro: string;
    bodyParagraph: string;
    metaDescription: string;
  };

  /** Full system prompt — pre-built for fast injection + caching */
  systemPrompt: string;
}

// ─── Localised article ────────────────────────────────────────────────────────

export interface LocalisedArticle {
  brand: BrandKey;
  sourceSlug: string;
  sourceLocale: 'en';
  targetLocale: LocaleCode;
  generatedAt: string;

  title: string;
  slug: string;
  content: string;
  excerpt: string;

  seo: {
    title: string;
    metaDesc: string;
    focuskw: string;
    opengraphTitle: string;
    opengraphDescription: string;
    twitterTitle: string;
    twitterDescription: string;
  };

  editorReview: EditorReview;
}

// ─── Editor review ────────────────────────────────────────────────────────────

export interface EditorFlag {
  severity: 'error' | 'warning' | 'suggestion';
  category: 'brand-voice' | 'translation' | 'cultural' | 'seo' | 'readability';
  description: string;
  sourceText?: string;
  translatedText?: string;
  suggestion?: string;
}

export interface InlineComment {
  section: 'title' | 'slug' | 'content' | 'excerpt' | 'seo';
  originalText: string;
  comment: string;
  revisedSuggestion?: string;
}

export interface EditorReview {
  overallScore: number;         // 0–100
  scores: {
    brandVoiceAdherence: number;
    translationAccuracy: number;
    culturalFit: number;
    seoOptimisation: number;
    readability: number;
  };
  flags: EditorFlag[];
  inlineComments: InlineComment[];
  summary: string;
  approved: boolean;            // true when overallScore ≥ 75 and no error flags
}
