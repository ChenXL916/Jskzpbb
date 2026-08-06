import { Injectable } from '@nestjs/common';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';
const KEY_LENGTH = 64;

@Injectable()
export class PasswordService {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await this.derive(password, salt);
    return [
      'scrypt',
      VERSION,
      salt.toString('base64url'),
      derived.toString('base64url')
    ].join('$');
  }

  async verify(password: string, encoded: string): Promise<boolean> {
    const [algorithm, version, saltValue, hashValue] = encoded.split('$');
    if (
      algorithm !== 'scrypt' ||
      version !== VERSION ||
      !saltValue ||
      !hashValue
    ) {
      return false;
    }
    try {
      const salt = Buffer.from(saltValue, 'base64url');
      const expected = Buffer.from(hashValue, 'base64url');
      const actual = await this.derive(password, salt);
      return (
        actual.length === expected.length &&
        timingSafeEqual(actual, expected)
      );
    } catch {
      return false;
    }
  }

  async performDummyCheck(password: string): Promise<void> {
    await this.derive(password, Buffer.alloc(16));
  }

  private derive(password: string, salt: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      scrypt(password, salt, KEY_LENGTH, (error, key) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(key);
      });
    });
  }
}
