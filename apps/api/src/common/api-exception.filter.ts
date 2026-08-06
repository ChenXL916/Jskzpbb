import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger
} from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    const requestId = request.header('x-request-id') ?? randomUUID();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const value =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    const message =
      typeof value === 'string'
        ? value
        : typeof value === 'object' && value && 'message' in value
          ? value.message
          : '服务器处理请求失败';

    if (status === 500) {
      const details = exception instanceof Error
        ? exception.stack ?? exception.message
        : String(exception);
      this.logger.error(
        `${request.method} ${request.path} requestId=${requestId}`,
        details
      );
    }

    response.status(status).json({
      code: status === 500 ? 'INTERNAL_ERROR' : `HTTP_${status}`,
      message,
      requestId,
      path: request.path,
      timestamp: new Date().toISOString()
    });
  }
}
