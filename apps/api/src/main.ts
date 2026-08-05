import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { cors: false });
  const config = app.get(ConfigService);
  const configuredWebOrigin = config.getOrThrow<string>('WEB_ORIGIN');
  const allowedWebOrigins = new Set([configuredWebOrigin]);
  const configuredWebUrl = new URL(configuredWebOrigin);
  if (configuredWebUrl.hostname === 'localhost') {
    configuredWebUrl.hostname = '127.0.0.1';
    allowedWebOrigins.add(configuredWebUrl.origin);
  } else if (configuredWebUrl.hostname === '127.0.0.1') {
    configuredWebUrl.hostname = 'localhost';
    allowedWebOrigins.add(configuredWebUrl.origin);
  }
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: [...allowedWebOrigins],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-request-id', 'idempotency-key']
  });
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true
    })
  );
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  await app.listen(config.get<number>('PORT') ?? 3001, '0.0.0.0');
}

void bootstrap();
