/**
 * The gallery and its fixtures ship only in dev and in builds made with
 * `VITE_ENABLE_GALLERY=1` (the Playwright web server). Both operands are static, so a
 * plain production build drops the dynamic import and the chunk behind it entirely;
 * test/build.test.ts greps the output to keep it that way.
 */
export const galleryEnabled: boolean =
  import.meta.env.DEV || import.meta.env.VITE_ENABLE_GALLERY === '1';

export const loadGallery = galleryEnabled ? () => import('../dev/Gallery.tsx') : null;
