import { ProductOperationsService } from './product-operations.service';

describe('ProductOperationsService management dashboard', () => {
  it('counts active live sessions once even when appointment history exists', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const service = new ProductOperationsService({ query } as never);

    await service.managementDashboard();

    const roomQuery = query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('current_session_count'));

    expect(roomQuery).toContain('count(DISTINCT session.id)');
    expect(roomQuery).toContain("session.status='SCHEDULED'");
    expect(roomQuery).toContain('session.cancelled_at IS NULL');
    expect(roomQuery).toContain('count(DISTINCT appointment.id)');
  });
});
