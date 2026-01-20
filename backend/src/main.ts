import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { CustomLoggerService } from './common/logging/custom-logger.service';
import { SystemEventType } from './entities/system-log.entity';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  // Get custom logger
  const logger = app.get(CustomLoggerService);
  app.useLogger(logger);

  // Enable CORS for frontend
  app.enableCors({
    origin: [
      'http://localhost:3000',
      'http://localhost:3030',
      process.env.FRONTEND_URL,
    ].filter(Boolean),
    credentials: true,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Start server
  const port = process.env.PORT || 3001;
  await app.listen(port);

  // Log system start
  await logger.logSystem({
    level: 'info',
    eventType: SystemEventType.SYSTEM_START,
    message: `Dual Strategy Trading System started on port ${port}`,
    component: 'Main',
    metadata: {
      port,
      nodeEnv: process.env.NODE_ENV,
    },
  });

  logger.log(`Application is running on: http://localhost:${port}`, 'Bootstrap');
}

bootstrap();
