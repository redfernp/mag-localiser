import type { BrandKey, LocaleCode } from '../types/index.js';

export interface BrandConfig {
  name: string;
  endpoint: string;
  locales: LocaleCode[];
  /** WP Application Password auth — optional, for private GraphQL endpoints */
  auth?: { user: string; pass: string };
  /**
   * Prescriptive CMO-authored brand voice guide.
   * Injected into both the localizer and editor as a cached system block.
   * Takes precedence over empirically-derived profiler output when they conflict.
   */
  voiceGuide?: string;
}

export const DOPE_SNOW_VOICE_GUIDE = `
## Dope Snow Brand Voice Guide (CMO-authored)

### Brand essence
One-word proposition: Fun. North star: "Enjoy the mountains together."
Dope is a welcoming community, not an elite club. Write like one friend helping another.

### Three core tone traits
1. FRIENDLY — warm, approachable, conversational, human. NOT corporate, cold, stiff, distant.
2. PLAYFUL — light, lively, full of momentum. NOT try-hard, cringe, slang-heavy, sarcastic.
3. POSITIVE — optimistic, encouraging, stoked. NOT cynical, intimidating, overly dramatic.

### Voice priority order (apply in this sequence)
1. Clarity — if a line is clever but less clear, simplify it
2. Brand feel
3. Energy
4. Persuasion

### Writing style rules
- Short sentences. Tight phrasing. Simple vocabulary. Active voice.
- Show emotion; don't name it: "Cold air. Fresh tracks. Big grin." NOT "an amazing experience"
- Address the reader as you/your. Use we/our for shared brand identity.
- Keep it accessible — write for beginners and experienced riders alike.
- Sentence rhythm patterns to use:
  • Punchy triad: "Ride. Laugh. Repeat."
  • Question hook: "Ready for winter?"
  • Moment opener: "Bluebird day? Do it in style."
  • Stacked lines: "Cold mornings. Fresh snow. First chair."

### Language to use
good times, crew, mountain, slopes, park, fresh, fit, style, comfy, cosy, stoked,
express yourself, your way, best day ever, built for mountains, ready for winter,
gear up, find your fit, build your look, chase lines, cruise the slopes

### Language to NEVER use
Corporate / generic: innovative solution, cutting-edge, industry-leading, best-in-class,
premium quality, state-of-the-art, next-generation, world-class, unmatched performance,
revolutionizing, advanced material technology, our mission is to deliver,
we strive to provide, our commitment to excellence, game-changing, the future of

Overhyped adjectives: perfect, ultimate, unbeatable, revolutionary (in marketing contexts),
insane (as praise), world-class

Macho / aggressive: dominate the mountain, conquer anything, crush every run,
no days off, built for warriors

Robotic CTAs: purchase now, order today, click here to buy
Prefer: Gear up. / Get ready for the next storm. / Find your setup. / Build your look.

### Final test — ask before approving any copy
- Does this sound human?
- Does it feel upbeat and inclusive?
- Is it clear in one read?
- Could a newer rider understand it?
- Does it sound like Dope Snow, not generic snow gear copy?
- Does it read like a rider talking to another rider, not a company talking to a customer?
`.trim();

export const BRANDS: Record<BrandKey, BrandConfig> = {
  'dope-snow': {
    name: 'Dope Snow',
    endpoint: process.env.DOPE_SNOW_GRAPHQL_URL ?? '',
    locales: ['sv', 'fr', 'de', 'nl', 'it', 'fi'],
    voiceGuide: DOPE_SNOW_VOICE_GUIDE,
    auth: process.env.DOPE_SNOW_WP_USER
      ? { user: process.env.DOPE_SNOW_WP_USER, pass: process.env.DOPE_SNOW_WP_PASS ?? '' }
      : undefined,
  },
  montecwear: {
    name: 'Montecwear',
    endpoint: process.env.MONTECWEAR_GRAPHQL_URL ?? '',
    locales: ['sv', 'fr', 'de', 'nl', 'it', 'fi'],
    auth: process.env.MONTECWEAR_WP_USER
      ? { user: process.env.MONTECWEAR_WP_USER, pass: process.env.MONTECWEAR_WP_PASS ?? '' }
      : undefined,
  },
  ridestore: {
    name: 'Ridestore',
    endpoint: process.env.RIDESTORE_GRAPHQL_URL ?? '',
    locales: ['sv', 'fr', 'de', 'nl', 'es', 'it', 'fi', 'da'],
    auth: process.env.RIDESTORE_WP_USER
      ? { user: process.env.RIDESTORE_WP_USER, pass: process.env.RIDESTORE_WP_PASS ?? '' }
      : undefined,
  },
};

export interface LocaleMeta {
  name: string;
  nativeName: string;
  /** Polylang uppercase language code used in GraphQL queries */
  polylangCode: string;
  /** Cultural localisation notes for the AI */
  culturalNotes: string;
  /**
   * When true, the localizer applies a hard vocabulary override block that
   * prohibits banned terms regardless of what the brand profile says.
   * Set to true for locales with no human reviewer assigned — the editor will
   * still flag violations for review, but the localizer won't produce them in
   * the first place. Set to false when a human reviewer is in the loop and can
   * make the final call on borderline language.
   */
  strictMode: boolean;
}

export const LOCALE_META: Record<LocaleCode, LocaleMeta> = {
  sv: {
    name: 'Swedish',
    nativeName: 'Svenska',
    polylangCode: 'SV',
    strictMode: false, // human reviewer assigned
    culturalNotes:
      'Swedish readers value directness and simplicity (lagom). Avoid over-the-top superlatives. Sustainability and outdoor lifestyle resonate strongly. Use informal "du" form.',
  },
  fr: {
    name: 'French',
    nativeName: 'Français',
    polylangCode: 'FR',
    strictMode: true, // no human reviewer yet
    culturalNotes:
      'French readers appreciate elegance and style. Use "vous" for brand communications unless the brand is explicitly youth-oriented. Avoid anglicisms where a good French equivalent exists.',
  },
  de: {
    name: 'German',
    nativeName: 'Deutsch',
    polylangCode: 'DE',
    strictMode: true, // no human reviewer yet
    culturalNotes:
      'German readers value precision, quality, and technical accuracy. Be specific about product features. Use "Sie" form for formal tone. Compound nouns are fine but avoid overly long sentences.',
  },
  nl: {
    name: 'Dutch',
    nativeName: 'Nederlands',
    polylangCode: 'NL',
    strictMode: true, // no human reviewer yet
    culturalNotes:
      'Dutch readers appreciate directness and a no-nonsense approach. Informal "je/jij" is common in marketing. Humour and self-deprecation can work well.',
  },
  es: {
    name: 'Spanish',
    nativeName: 'Español',
    polylangCode: 'ES',
    strictMode: true, // no human reviewer yet
    culturalNotes:
      'Use European Spanish (Spain). Informal "tú" is fine for sports/outdoor brands. Passion and energy resonate well. Avoid Latin American idioms.',
  },
  it: {
    name: 'Italian',
    nativeName: 'Italiano',
    polylangCode: 'IT',
    strictMode: false, // human reviewer assigned
    culturalNotes:
      'Italian readers respond to style, passion, and quality craftsmanship. Use "tu" for youth/sports brands. Italians appreciate warmth and expressiveness.',
  },
  fi: {
    name: 'Finnish',
    nativeName: 'Suomi',
    polylangCode: 'FI',
    strictMode: false, // human reviewer assigned
    culturalNotes:
      'Finnish readers value authenticity, understatement, and practicality. Avoid hype and exaggeration. Nature and outdoor life are strong cultural touchstones. Use "sinä" (informal).',
  },
  da: {
    name: 'Danish',
    nativeName: 'Dansk',
    polylangCode: 'DA',
    strictMode: true, // no human reviewer yet
    culturalNotes:
      'Danish readers value simplicity, hygge, and unpretentious quality. Informal "du" throughout. Scandinavian design sensibility — clean and purposeful.',
  },
};

export function getBrand(key: string): BrandConfig {
  if (!(key in BRANDS)) {
    throw new Error(`Unknown brand "${key}". Valid brands: ${Object.keys(BRANDS).join(', ')}`);
  }
  return BRANDS[key as BrandKey];
}
