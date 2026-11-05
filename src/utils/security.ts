import { createHash, timingSafeEqual } from 'crypto';

/**
 * Compara dos strings en tiempo constante.
 * Se hashean ambos valores para que la comparación no dependa de su longitud.
 */
export function safeEqual(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}
