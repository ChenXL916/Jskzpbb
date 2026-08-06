import { LiveCellParserService } from './live-cell-parser.service';

describe('LiveCellParserService', () => {
  const parser = new LiveCellParserService();

  it('separates Q prefix, name and opening-time remark', () => {
    expect(parser.parse('Q-陈莹（17.30开播）')).toEqual([
      expect.objectContaining({
        normalizedName: '陈莹',
        employmentType: 'FULL_TIME',
        scheduleType: 'LIVE',
        remarks: ['17.30开播']
      })
    ]);
  });

  it('splits dual-host and newline cells', () => {
    const rows = parser.parse('J-梦丽+菜菜\nQ-陈莹');
    expect(rows.map((row) => row.normalizedName)).toEqual(['梦丽', '菜菜', '陈莹']);
    expect(rows[0]?.employmentType).toBe('PART_TIME');
    expect(rows[2]?.employmentType).toBe('FULL_TIME');
  });

  it('splits an embedded prefixed host separated by whitespace', () => {
    const rows = parser.parse('儿儿 J-刘瑶');
    expect(rows.map((row) => row.normalizedName)).toEqual(['儿儿', '刘瑶']);
    expect(rows[1]?.employmentType).toBe('PART_TIME');
  });

  it.each([
    ['停电', 'POWER_OUTAGE'],
    ['未开播', 'NOT_STARTED'],
    ['断播', 'INTERRUPTED']
  ])('treats %s as an exception, never a person', (value, exceptionType) => {
    const result = parser.parse(value);
    expect(result).toEqual([expect.objectContaining({ exceptionType })]);
    expect(result[0]).not.toHaveProperty('normalizedName');
  });

  it('keeps rehearsal as schedule type', () => {
    expect(parser.parse('Q-陈莹（彩排）')[0]).toMatchObject({
      normalizedName: '陈莹',
      scheduleType: 'REHEARSAL'
    });
  });

  it.each([
    ['@陈莹', '陈莹'],
    ['Q-陈莹', '陈莹'],
    ['J－陈莹', '陈莹']
  ])('normalizes schedule person name %s', (value, expected) => {
    expect(parser.normalizePersonName(value)).toBe(expected);
  });
});
