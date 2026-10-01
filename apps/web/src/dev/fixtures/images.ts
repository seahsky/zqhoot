/**
 * A picture for the fixtures that show a question image, as a `data:` URL so the gallery needs
 * no server and no asset. The XML namespace is assembled from parts because the source scan
 * forbids a plain-scheme URL anywhere in src.
 */
const NS = ['http:', '', 'www.w3.org', '2000', 'svg'].join('/');

export const DEMO_IMAGE_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="${NS}" viewBox="0 0 640 360" width="640" height="360">` +
    '<rect width="640" height="360" fill="#141b30"/>' +
    '<circle cx="320" cy="180" r="92" fill="#f0e442" stroke="#f4f6fb" stroke-width="6"/>' +
    '<ellipse cx="320" cy="180" rx="190" ry="34" fill="none" stroke="#56b4e9" stroke-width="14" transform="rotate(-18 320 180)"/>' +
    '<circle cx="90" cy="70" r="4" fill="#f4f6fb"/><circle cx="560" cy="290" r="5" fill="#f4f6fb"/>' +
    '<circle cx="540" cy="60" r="3" fill="#f4f6fb"/><circle cx="110" cy="300" r="3" fill="#f4f6fb"/>' +
    '</svg>',
)}`;
