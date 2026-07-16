import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import type { BalanceBookStore, ProfileSummary } from './store';

const KEY_LENGTH = 32;
const LOCK_AFTER_ATTEMPTS = 5;
const LOCK_DURATION_MS = 30_000;

const deriveKey = (password: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      KEY_LENGTH,
      { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });

const validatePassword = (password: string): void => {
  if (password.length < 12 || password.length > 128) {
    throw new Error('Password must be between 12 and 128 characters');
  }
};

export class LocalAuthService {
  constructor(private readonly store: BalanceBookStore) {}

  async createPassword(
    profileId: string,
    password: string,
    identity?: { displayName: string; username: string },
  ): Promise<ProfileSummary> {
    validatePassword(password);
    const profile = this.store.getCredentialsById(profileId);
    if (!profile) throw new Error('Profile not found');
    if (profile.passwordSet) throw new Error('Password already set');
    const salt = randomBytes(16);
    const key = await deriveKey(password, salt);
    this.store.setPassword(profileId, salt.toString('base64'), key.toString('base64'), identity);
    return this.store.getCredentialsById(profileId)!;
  }

  async login(username: string, password: string): Promise<ProfileSummary> {
    const profile = this.store.getCredentialsByUsername(username);
    if (!profile?.passwordSet || !profile.passwordSalt || !profile.passwordHash) {
      throw new Error('Invalid username or password');
    }
    if (profile.lockedUntil && Date.parse(profile.lockedUntil) > Date.now()) {
      throw new Error('Too many attempts. Try again shortly.');
    }
    const actual = await deriveKey(password, Buffer.from(profile.passwordSalt, 'base64'));
    const expected = Buffer.from(profile.passwordHash, 'base64');
    const valid = actual.length === expected.length && timingSafeEqual(actual, expected);
    if (!valid) {
      const attempts = profile.failedLoginAttempts + 1;
      const lockedUntil =
        attempts >= LOCK_AFTER_ATTEMPTS
          ? new Date(Date.now() + LOCK_DURATION_MS).toISOString()
          : null;
      this.store.recordFailedLogin(profile.id, attempts, lockedUntil);
      throw new Error(
        lockedUntil ? 'Too many attempts. Try again shortly.' : 'Invalid username or password',
      );
    }
    this.store.clearFailedLogins(profile.id);
    return this.store.getCredentialsById(profile.id)!;
  }
}
