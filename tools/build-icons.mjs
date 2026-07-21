// Generates the HMMM? app icons from two inline SVG masters.
// Claymation-era look: a chunky "?" with a thick ink outline and a solid offset
// drop-shadow on a teal clay card, matching the game's palette.
// Run: node tools/build-icons.mjs
import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = resolve(ROOT, 'icons');
mkdirSync(ICONS, { recursive: true });

// Game palette (from css/style.css)
const INK = '#2b1b44', TEAL = '#2fc7b5', CREAM = '#fff6e8',
      PINK = '#ff4fa3', YELLOW = '#ffd93d', PURPLE = '#7b5be6', LIME = '#7fe348';

// The big "?" — a solid ink drop-shadow, then a cream glyph with a thick ink
// outline (paint-order:stroke draws the stroke outside the fill = clay outline).
function question(cx, cy, size) {
  const common = `font-family="'DejaVu Sans','Liberation Sans',sans-serif" font-weight="900" ` +
                 `font-size="${size}" text-anchor="middle" dominant-baseline="middle"`;
  return `
    <text x="${cx + size * 0.045}" y="${cy + size * 0.055}" ${common} fill="${INK}">?</text>
    <text x="${cx}" y="${cy}" ${common} fill="${CREAM}"
          stroke="${INK}" stroke-width="${size * 0.06}" stroke-linejoin="round"
          paint-order="stroke" style="paint-order:stroke">?</text>`;
}

// A little clay confetti blob with an ink outline.
function blob(cx, cy, r, fill) {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${INK}" stroke-width="${r * 0.34}"/>`;
}

function card({ maskable }) {
  // maskable = full-bleed teal (launcher masks corners); standard = rounded clay card.
  const bg = maskable
    ? `<rect width="512" height="512" fill="${TEAL}"/>`
    : `<rect x="8" y="8" width="496" height="496" rx="104" fill="${TEAL}" stroke="${INK}" stroke-width="16"/>`;
  // confetti kept inside the safe zone on the maskable variant
  const inset = maskable ? 46 : 0;
  const confetti = `
    ${blob(120 + inset, 132 + inset * 0.7, 26, YELLOW)}
    ${blob(398 - inset, 150 + inset * 0.5, 20, PINK)}
    ${blob(128 + inset, 392 - inset * 0.6, 18, PURPLE)}
    ${blob(392 - inset, 388 - inset * 0.6, 24, LIME)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  ${bg}
  ${confetti}
  ${question(256, 262, 300)}
</svg>`;
}

const standardSVG = card({ maskable: false });
const maskableSVG = card({ maskable: true });

writeFileSync(resolve(ROOT, 'favicon.svg'), standardSVG);
writeFileSync(resolve(ICONS, 'icon.svg'), standardSVG);
writeFileSync(resolve(ICONS, 'icon-maskable.svg'), maskableSVG);

const jobs = [
  ['icon-192.png', standardSVG, 192],
  ['icon-512.png', standardSVG, 512],
  ['icon-maskable-512.png', maskableSVG, 512],
  ['apple-touch-icon.png', maskableSVG, 180],
  ['apple-touch-icon-152.png', maskableSVG, 152],
  ['apple-touch-icon-167.png', maskableSVG, 167],
  ['favicon-32.png', standardSVG, 32],
  ['favicon-16.png', standardSVG, 16],
];

for (const [name, svg, size] of jobs) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(resolve(ICONS, name));
  console.log('wrote icons/' + name + '  (' + size + 'px)');
}
console.log('wrote favicon.svg, icons/icon.svg, icons/icon-maskable.svg');
