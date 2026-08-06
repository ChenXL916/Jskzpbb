import { BadRequestException } from '@nestjs/common';
import { CurrentUser } from '@jishi/contracts';
import { PasswordService } from '../auth/password.service';
import { DatabaseService } from '../database/database.service';
import { AdminController } from './workspace.controller';

const actor = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  personId: '11111111-1111-4111-8111-111111111111',
  displayName: '管理员',
  roles: ['ADMIN'],
  roomIds: []
} as CurrentUser;

describe('AdminController people lifecycle', () => {
  it('creates a person with roles and an audit log', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: '22222222-2222-4222-8222-222222222222' }]
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const db = {
      transaction: (work: (client: { query: typeof query }) => unknown) =>
        work({ query })
    } as unknown as DatabaseService;
    const controller = new AdminController(
      db,
      {} as PasswordService
    );

    await controller.createPerson(actor, {
      displayName: '新化妆师',
      employeeNo: 'M009',
      feishuOpenId: 'ou_artist009',
      roles: ['MAKEUP_ARTIST']
    });

    const calls = query.mock.calls as unknown as Array<[string, unknown[]]>;
    const sql = calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain('INSERT INTO people');
    expect(sql).toContain('INSERT INTO person_roles');
    expect(sql).toContain("'CREATE_PERSON'");
  });

  it('does not allow an administrator to archive their own account', async () => {
    const controller = new AdminController(
      {} as DatabaseService,
      {} as PasswordService
    );

    await expect(
      controller.archivePerson(actor, actor.personId)
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
