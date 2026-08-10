import type { MetadataRoute } from 'next';
import { primaryNavigation } from '@/content/site';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://alfanumrik.com';

export default function sitemap(): MetadataRoute.Sitemap {
  return primaryNavigation.map(({ href }) => ({
    url: new URL(href, siteUrl).toString(),
    changeFrequency: href === '/' ? 'weekly' : 'monthly',
    priority: href === '/' ? 1 : 0.8,
  }));
}
