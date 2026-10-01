import { toString as qrToString } from 'qrcode';

/**
 * The QR code as an `<img>` source. The SVG comes back as text and goes into a `data:` URL,
 * never into the DOM as markup, so nothing in it can run (ADR-0013). `qrcode` calls back
 * synchronously, which lets a component compute it during render.
 */
export function qrDataUrl(text: string): string | null {
  let svg = null as string | null;
  try {
    qrToString(
      text,
      {
        type: 'svg',
        margin: 2,
        errorCorrectionLevel: 'M',
        // Dark modules on a white tile in both themes: scanners expect dark on light.
        color: { dark: '#0b1020', light: '#ffffff' },
      },
      (err, out) => {
        if (!err) svg = out;
      },
    );
  } catch {
    return null;
  }
  return svg === null ? null : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
