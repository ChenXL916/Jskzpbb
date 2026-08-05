import { Injectable } from '@nestjs/common';
import { ParseStatus } from '@jishi/contracts';

export interface ParsedLiveCellEntry {
  rawName: string;
  normalizedName?: string;
  employmentType?: 'FULL_TIME' | 'PART_TIME';
  scheduleType: 'LIVE' | 'REHEARSAL';
  exceptionType?: 'POWER_OUTAGE' | 'NOT_STARTED' | 'INTERRUPTED';
  remarks: string[];
  extraMinutes: number;
  missingMinutes: number;
  parseStatus: ParseStatus;
}

@Injectable()
export class LiveCellParserService {
  normalizePersonName(rawName: string): string {
    return rawName
      .trim()
      .replace(/^@/, '')
      .replace(/^[QJ][-－]\s*/i, '')
      .trim();
  }

  parse(rawValue: unknown): ParsedLiveCellEntry[] {
    const raw =
      typeof rawValue === 'string' || typeof rawValue === 'number'
        ? String(rawValue).trim()
        : '';
    if (!raw) return [];
    const exception = this.detectException(raw);
    if (exception) {
      return [
        {
          rawName: raw,
          scheduleType: 'LIVE',
          exceptionType: exception,
          remarks: [raw],
          extraMinutes: this.minutes(raw, /多播\s*(\d+)/),
          missingMinutes: this.minutes(raw, /少播\s*(\d+)/),
          parseStatus: 'SUCCESS'
        }
      ];
    }

    const scheduleType = /彩排/.test(raw) ? 'REHEARSAL' : 'LIVE';
    const entries = raw
      .replace(/\r/g, '\n')
      .replace(/\s+(?=[QJ][-－])/gi, '\n')
      .split(/[\n+＋、，,/&＆]+/)
      .map((item) => item.trim())
      .filter(Boolean);

    return entries.map((entry) => {
      const remarks = [...entry.matchAll(/[（(]([^）)]+)[）)]/g)].map(
        (match) => match[1]!
      );
      const withoutRemark = entry.replace(/[（(][^）)]+[）)]/g, '').trim();
      const prefixMatch = withoutRemark.match(/^([QJ])[-－]\s*(.+)$/i);
      const normalizedName = this.normalizePersonName(prefixMatch?.[2] ?? withoutRemark)
        .replace(/彩排/g, '')
        .trim();
      const prefix = prefixMatch?.[1]?.toUpperCase();
      return {
        rawName: entry,
        ...(normalizedName ? { normalizedName } : {}),
        ...(prefix
          ? { employmentType: prefix === 'Q' ? ('FULL_TIME' as const) : ('PART_TIME' as const) }
          : {}),
        scheduleType,
        remarks,
        extraMinutes: this.minutes(entry, /多播\s*(\d+)/),
        missingMinutes: this.minutes(entry, /少播\s*(\d+)/),
        parseStatus: normalizedName ? ('SUCCESS' as const) : ('FAILED' as const)
      };
    });
  }

  private detectException(
    value: string
  ): ParsedLiveCellEntry['exceptionType'] | undefined {
    if (/停电/.test(value)) return 'POWER_OUTAGE';
    if (/未开播/.test(value)) return 'NOT_STARTED';
    if (/断播/.test(value)) return 'INTERRUPTED';
    return undefined;
  }

  private minutes(value: string, pattern: RegExp): number {
    return Number(value.match(pattern)?.[1] ?? 0);
  }
}
