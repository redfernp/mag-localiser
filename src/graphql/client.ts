import type { BrandConfig } from '../config/brands.js';
import type { WPPost, WPPostsResponse, WPSinglePostResponse } from '../types/index.js';
import {
  GET_POSTS_FOR_PROFILING,
  GET_POST_WITH_TRANSLATIONS,
  GET_ALL_POST_SLUGS,
} from './queries.js';

/** Minimal GraphQL client — avoids a heavy dependency for a simple fetch wrapper. */
async function gql<T>(
  endpoint: string,
  query: string,
  variables: Record<string, unknown> = {},
  auth?: { user: string; pass: string },
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (auth) {
    const token = Buffer.from(`${auth.user}:${auth.pass}`).toString('base64');
    headers['Authorization'] = `Basic ${token}`;
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`GraphQL request failed: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };

  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join(', ')}`);
  }

  if (!json.data) {
    throw new Error('GraphQL response contained no data');
  }

  return json.data;
}

/** Fetch up to `limit` posts in the given language for brand voice profiling. */
export async function fetchPostsForProfiling(
  brand: BrandConfig,
  limit = 30,
  languageCode = 'EN',
): Promise<WPPost[]> {
  const posts: WPPost[] = [];
  let after: string | null = null;
  const pageSize = Math.min(limit, 10);

  while (posts.length < limit) {
    const data: WPPostsResponse = await gql<WPPostsResponse>(
      brand.endpoint,
      GET_POSTS_FOR_PROFILING,
      { first: pageSize, after, language: languageCode },
      brand.auth,
    );

    posts.push(...data.posts.nodes);

    if (!data.posts.pageInfo.hasNextPage) break;
    after = data.posts.pageInfo.endCursor;
  }

  return posts.slice(0, limit);
}

/** Fetch a single EN post by slug, including its existing translations list. */
export async function fetchPostBySlug(
  brand: BrandConfig,
  slug: string,
): Promise<WPPost> {
  const data = await gql<WPSinglePostResponse>(
    brand.endpoint,
    GET_POST_WITH_TRANSLATIONS,
    { slug },
    brand.auth,
  );

  if (!data.postBy) {
    throw new Error(`Post not found: "${slug}"`);
  }

  return data.postBy;
}

interface SlugNode {
  slug: string;
  translations: Array<{ language: { code: string } }>;
}

interface SlugPageResponse {
  posts: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: SlugNode[];
  };
}

/** Fetch all EN post slugs, annotated with which locales already have translations. */
export async function fetchAllSlugs(brand: BrandConfig): Promise<SlugNode[]> {
  const all: SlugNode[] = [];
  let after: string | null = null;

  while (true) {
    const data: SlugPageResponse = await gql<SlugPageResponse>(
      brand.endpoint,
      GET_ALL_POST_SLUGS,
      { first: 100, after },
      brand.auth,
    );

    all.push(...data.posts.nodes);

    if (!data.posts.pageInfo.hasNextPage) break;
    after = data.posts.pageInfo.endCursor;
  }

  return all;
}
