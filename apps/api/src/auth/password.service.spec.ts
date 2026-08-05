import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes without storing plaintext and verifies the password', async () => {
    const hash = await service.hash('safe-password-123');

    expect(hash).not.toContain('safe-password-123');
    await expect(service.verify('safe-password-123', hash)).resolves.toBe(true);
    await expect(service.verify('wrong-password', hash)).resolves.toBe(false);
  });

  it('rejects unsupported or malformed hashes', async () => {
    await expect(service.verify('password', 'plaintext')).resolves.toBe(false);
    await expect(
      service.verify('password', 'argon2$v1$invalid$invalid')
    ).resolves.toBe(false);
  });
});
