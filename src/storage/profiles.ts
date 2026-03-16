import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { BrandKey, BrandVoiceProfile } from '../types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = join(__dirname, '../../profiles');

/** Profiles are keyed by brand + locale: e.g. dope-snow-en.json, dope-snow-it.json */
function profilePath(brand: BrandKey, locale: string): string {
  return join(PROFILES_DIR, `${brand}-${locale}.json`);
}

export function loadProfile(brand: BrandKey, locale: string): BrandVoiceProfile | null {
  const path = profilePath(brand, locale);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8')) as BrandVoiceProfile;
}

export function saveProfile(profile: BrandVoiceProfile): void {
  mkdirSync(PROFILES_DIR, { recursive: true });
  writeFileSync(profilePath(profile.brand, profile.locale), JSON.stringify(profile, null, 2), 'utf-8');
}

export function profileExists(brand: BrandKey, locale: string): boolean {
  return existsSync(profilePath(brand, locale));
}

export function profileAge(brand: BrandKey, locale: string): number | null {
  const profile = loadProfile(brand, locale);
  if (!profile) return null;
  return Date.now() - new Date(profile.lastUpdated).getTime();
}
