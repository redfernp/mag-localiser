/**
 * WPGraphQL queries.
 *
 * Assumes the following plugins are active:
 *  - WPGraphQL (wp-graphql)
 *  - Polylang for WPGraphQL (valu/wp-graphql-polylang)
 *  - WPGraphQL Yoast SEO (ashhitch/wp-graphql-yoast-seo)
 *
 * If your Polylang integration uses different field names, adjust the
 * `language`, `translations`, and `where: { language: ... }` references below.
 */

/** Fetch a page of posts for brand voice profiling (any language). */
export const GET_POSTS_FOR_PROFILING = /* GraphQL */ `
  query GetPostsForProfiling($first: Int!, $after: String, $language: LanguageCodeFilterEnum!) {
    posts(
      first: $first
      after: $after
      where: { language: $language, status: PUBLISH }
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        slug
        title
        content(format: RENDERED)
        excerpt(format: RENDERED)
        lead { lead }
        date
        seo {
          title
          metaDesc
          focuskw
        }
      }
    }
  }
`;

/** Fetch a single EN post by slug, including all its Polylang translations. */
export const GET_POST_WITH_TRANSLATIONS = /* GraphQL */ `
  query GetPostWithTranslations($slug: String!) {
    postBy(slug: $slug) {
      id
      slug
      title
      content(format: RENDERED)
      excerpt(format: RENDERED)
      lead { lead }
      date
      language {
        code
        locale
        name
      }
      translations {
        id
        slug
        language {
          code
          locale
        }
      }
      seo {
        title
        metaDesc
        focuskw
        opengraphTitle
        opengraphDescription
        twitterTitle
        twitterDescription
        canonical
      }
    }
  }
`;

/** Fetch all published EN posts (slugs only) for batch operations. */
export const GET_ALL_POST_SLUGS = /* GraphQL */ `
  query GetAllPostSlugs($first: Int!, $after: String) {
    posts(
      first: $first
      after: $after
      where: { language: EN, status: PUBLISH }
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        slug
        translations {
          language {
            code
          }
        }
      }
    }
  }
`;
