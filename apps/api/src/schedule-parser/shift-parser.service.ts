import { Injectable } from '@nestjs/common';
import { ParseStatus } from '@jishi/contracts';

export interface ShiftTemplateInput {
  id: string;
  name: string;
  startTime: string | null;
  endTime: string | null;
  durationMinutes: number | null;
  crossesMidnight: boolean;
  bookable: boolean;
  confirmationRequired: boolean;
  aliases?: string[];
  segments?: Array<{
    startTime: string;
    endTime: string;
  }>;
}

export interface ParsedShiftSegment {
  startsAt: string;
  endsAt: string;
  bookable: boolean;
}

export interface ParsedShift {
  status: ParseStatus;
  startsAt?: string;
  endsAt?: string;
  isRest: boolean;
  isBookable: boolean;
  templateId?: string;
  segments?: ParsedShiftSegment[];
  message?: string;
}

@Injectable()
export class ShiftParserService {
  parse(
    scheduleDate: string,
    rawValue: unknown,
    templates: ShiftTemplateInput[]
  ): ParsedShift {
    const value =
      typeof rawValue === 'string' || typeof rawValue === 'number'
        ? String(rawValue).trim()
        : '';
    if (!value) {
      return {
        status: 'NEEDS_CONFIRMATION',
        isRest: false,
        isBookable: false,
        message: '排班单元格为空'
      };
    }
    if (/^(休|休息|请假|离职|停排)$/.test(value)) {
      return { status: 'SUCCESS', isRest: true, isBookable: false };
    }

    const normalizedValue = this.normalizeTemplateName(value);
    const template = templates.find((item) =>
      [item.name, ...(item.aliases ?? [])].some(
        (candidate) =>
          this.normalizeTemplateName(candidate) === normalizedValue
      )
    );
    if (template) {
      if (template.confirmationRequired || (!template.startTime && template.durationMinutes)) {
        return {
          status: 'NEEDS_CONFIRMATION',
          isRest: false,
          isBookable: false,
          templateId: template.id,
          message: '班次只有时长或要求人工确认，不能推定开始时间'
        };
      }
      if (!template.startTime || !template.endTime) {
        return {
          status: 'SUCCESS',
          isRest: !template.bookable,
          isBookable: false,
          templateId: template.id
        };
      }
      if (template.segments?.length) {
        const segments = template.segments.map((segment) =>
          this.segment(
            scheduleDate,
            segment.startTime,
            segment.endTime,
            segment.endTime <= segment.startTime,
            template.bookable
          )
        );
        return {
          status: 'SUCCESS',
          startsAt: segments[0]!.startsAt,
          endsAt: segments.at(-1)!.endsAt,
          isRest: false,
          isBookable: template.bookable,
          templateId: template.id,
          segments
        };
      }
      return this.fromTimes(
        scheduleDate,
        template.startTime,
        template.endTime,
        template.crossesMidnight,
        template.bookable,
        template.id
      );
    }

    const normalized = value
      .replace(/[：]/g, ':')
      .replace(/[—–~～至]/g, '-')
      .replace(/\s+/g, '');
    const match = normalized.match(
      /(?:^|[^\d])([01]?\d|2[0-3])(?::([0-5]\d))?-(24|[01]?\d|2[0-3])(?::([0-5]\d))?(?:$|[^\d])/
    );
    if (!match) {
      const duration = normalized.match(/自由[（(]?(\d+)\s*小时[）)]?/);
      return {
        status: duration ? 'NEEDS_CONFIRMATION' : 'FAILED',
        isRest: false,
        isBookable: false,
        message: duration
          ? `仅识别到${duration[1]}小时，缺少开始时间`
          : `无法识别班次“${value}”，请配置班次模板`
      };
    }
    const start = `${match[1]!.padStart(2, '0')}:${match[2] ?? '00'}:00`;
    if (match[3] === '24' && match[4] && match[4] !== '00') {
      return {
        status: 'FAILED',
        isRest: false,
        isBookable: false,
        message: `无法识别班次“${value}”，24点之后不能再填写分钟`
      };
    }
    const end =
      match[3] === '24'
        ? '00:00:00'
        : `${match[3]!.padStart(2, '0')}:${match[4] ?? '00'}:00`;
    return this.fromTimes(
      scheduleDate,
      start,
      end,
      match[3] === '24' || end <= start,
      true
    );
  }

  private fromTimes(
    date: string,
    start: string,
    end: string,
    crossesMidnight: boolean,
    bookable: boolean,
    templateId?: string
  ): ParsedShift {
    const segment = this.segment(date, start, end, crossesMidnight, bookable);
    return {
      status: 'SUCCESS',
      startsAt: segment.startsAt,
      endsAt: segment.endsAt,
      isRest: false,
      isBookable: bookable,
      segments: [segment],
      ...(templateId ? { templateId } : {})
    };
  }

  private segment(
    date: string,
    start: string,
    end: string,
    crossesMidnight: boolean,
    bookable: boolean
  ): ParsedShiftSegment {
    const nextDate = crossesMidnight ? this.addDay(date) : date;
    return {
      startsAt: `${date}T${start}+08:00`,
      endsAt: `${nextDate}T${end}+08:00`,
      bookable
    };
  }

  private addDay(date: string): string {
    const value = new Date(`${date}T00:00:00+08:00`);
    value.setUTCDate(value.getUTCDate() + 1);
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(value);
  }

  private normalizeTemplateName(value: string): string {
    return value
      .toLowerCase()
      .replace(/[\s（）()]/g, '');
  }
}
