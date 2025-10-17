import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { errorFormater, SwaggerBuildFactory } from '@app/common';
import { BadRequestException, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('NestApplication');
  const config_service = app.get(ConfigService);
  const prefix = config_service.getOrThrow('PREFIX_NAME');
  const port = config_service.getOrThrow('PORT');

  app.setGlobalPrefix(prefix);
  
  app.useGlobalPipes(
    new ValidationPipe({
      exceptionFactory: (errors) => {
        const detailError = errorFormater(errors);
        return new BadRequestException({message: 'Invalid input', detailError});
      },
      whitelist: true,
      forbidUnknownValues: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  app.enableCors();
  app.enableShutdownHooks();
  
  SwaggerBuildFactory(app);
  
  await app.listen(port, async () => {
    logger.warn(`Swagger is running on: ${await app.getUrl()}/${prefix}/docs`);
    logger.warn(
      `Application (HTTP) is running on: ${await app.getUrl()}/${prefix}`,
    );
  });
}
bootstrap();
