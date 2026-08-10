# Alfanumrik marketing website

Independent, indexable marketing application for the main domain. It has no runtime dependency on the product API, product frontend, CMS, or database.

## Commands

```bash
npm install
npm run dev
npm run typecheck
npm run lint
npm run build
```

Copy `.env.example` to `.env.local`, then set `NEXT_PUBLIC_SITE_URL` and `NEXT_PUBLIC_APP_URL` to the real production domains before a production build. The current illustrations are code-native placeholders and can be replaced independently in `src/components/brand-art.tsx` when approved brand artwork is available.
