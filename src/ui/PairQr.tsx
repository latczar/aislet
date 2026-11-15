// PC: a QR code of the pairing link, for the phone's camera to scan. Used only on the PC (a web page), so it can
// draw a plain <img>: React Native Web's Image doesn't show SVG data links.
import React, { useMemo } from 'react';
import { toQR } from 'toqr';

const QUIET = 4; // the blank border scanners need, in modules

/** The QR code as an SVG picture: dark squares on white, with its own background so it scans in dark mode too. */
function qrSvg(text: string): string {
  const modules = toQR(text, 0); // error correction M: still scans off a screen with some glare
  const n = Math.round(Math.sqrt(modules.length));
  const size = n + QUIET * 2;
  let path = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (modules[y * n + x]) path += `M${x + QUIET} ${y + QUIET}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`
    + `<rect width="${size}" height="${size}" fill="#FFFFFF"/><path d="${path}" fill="#18181B"/></svg>`;
}

export function PairQr({ link, size = 168 }: { link: string; size?: number }) {
  const src = useMemo(() => `data:image/svg+xml;utf8,${encodeURIComponent(qrSvg(link))}`, [link]);
  return React.createElement('img', {
    src,
    width: size,
    height: size,
    alt: "QR code: scan it with your phone's camera to pair",
    style: { borderRadius: 12, display: 'block', flexShrink: 0 },
  });
}
