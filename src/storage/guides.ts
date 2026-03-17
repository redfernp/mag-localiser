import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { BrandKey } from '../types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUIDES_DIR = join(__dirname, '../../guides');

function guidePath(brand: BrandKey): string {
  return join(GUIDES_DIR, `${brand}.txt`);
}

export function loadGuide(brand: BrandKey): string | null {
  const path = guidePath(brand);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf-8').trim();
  return text || null;
}

export function saveGuide(brand: BrandKey, text: string): void {
  mkdirSync(GUIDES_DIR, { recursive: true });
  writeFileSync(guidePath(brand), text.trim(), 'utf-8');
}

export function guideExists(brand: BrandKey): boolean {
  return existsSync(guidePath(brand));
}
