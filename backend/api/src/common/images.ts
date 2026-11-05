import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';

const READABLE = new Set(['jpeg', 'png', 'webp', 'avif', 'heif']);

/**
 * Re-encodes an uploaded photo: applies the EXIF rotation, strips all metadata
 * (camera, GPS location), and caps the long side. Transparent PNGs stay PNG so
 * cut-out product shots keep their clean edges; everything else becomes JPEG.
 */
export async function normaliseImage(input: Buffer, maxSide = 2048) {
  let format: string | undefined;
  try {
    format = (await sharp(input).metadata()).format;
  } catch {
    format = undefined;
  }
  if (!format || !READABLE.has(format)) throw new BadRequestException('That file isn’t a photo we can read. Use a JPG, PNG or WebP image.');
  const img = sharp(input, { failOn: 'error' }).rotate().resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true });
  const alpha = format === 'png' && (await sharp(input).stats()).isOpaque === false;
  const { data, info } = alpha
    ? await img.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
    : await img.flatten({ background: '#ffffff' }).jpeg({ quality: 92, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  return { data, type: alpha ? 'image/png' : 'image/jpeg', ext: alpha ? 'png' : 'jpg', width: info.width, height: info.height };
}

export const dataUri = (data: Buffer, type: string) => `data:${type};base64,${data.toString('base64')}`;
