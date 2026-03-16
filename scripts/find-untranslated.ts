import 'dotenv/config';
import { fetchAllSlugs } from '../src/graphql/client.js';
import { BRANDS } from '../src/config/brands.js';

const brand = BRANDS['dope-snow'];
const slugs = await fetchAllSlugs(brand);

console.log('Articles missing IT + SV + FI:\n');
let count = 0;
for (const s of slugs) {
  const codes = s.translations.filter((t: { language: { code: string } | null }) => t?.language).map((t: { language: { code: string } }) => t.language.code);
  if (!codes.includes('IT') && !codes.includes('SV') && !codes.includes('FI')) {
    const has = codes.length ? '[has: ' + codes.join(', ') + ']' : '[EN only]';
    console.log(`  ${s.slug.padEnd(60)} ${has}`);
    count++;
  }
}
console.log(`\n${count} articles of ${slugs.length} total`);
