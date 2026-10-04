import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

let pendingDerivations = 0;
const derive = (password: string, salt: string): Promise<Buffer> => {
  if (pendingDerivations >= 16)
    return Promise.reject(
      Object.assign(new Error('Password service is busy; try again shortly'), {
        statusCode: 429,
        code: 'rate_limited',
      }),
    );
  pendingDerivations++;
  return new Promise((resolve, reject) => {
    try {
      scrypt(
        password,
        salt,
        64,
        { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
        (error, key) => {
          pendingDerivations--;
          if (error) reject(error);
          else resolve(key);
        },
      );
    } catch (error) {
      pendingDerivations--;
      reject(error);
    }
  });
};

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  return `scrypt-v1$${salt}$${(await derive(password, salt)).toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [version, salt, digest] = encoded.split('$');
  if (version !== 'scrypt-v1' || !salt || !digest || !/^[a-f0-9]{128}$/.test(digest)) return false;
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, Buffer.from(digest, 'hex'));
}

/** Bounded local defense; deploy a shared edge rate limit for multiple API replicas. */
export class LoginThrottle {
  private readonly attempts = new Map<string, { count: number; until: number }>();
  take(key: string, maximum = 10): boolean {
    const now = Date.now();
    for (const [id, value] of this.attempts) if (value.until <= now) this.attempts.delete(id);
    let entry = this.attempts.get(key);
    if (!entry) {
      if (this.attempts.size >= 10_000) return false;
      entry = { count: 0, until: now + 60_000 };
      this.attempts.set(key, entry);
    }
    return ++entry.count <= maximum;
  }
}
