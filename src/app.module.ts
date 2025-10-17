import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { ConfigModule } from '@nestjs/config';
import * as Joi from 'joi';
import { APP_INTERCEPTOR } from '@nestjs/core';
import {
  AppResponseInterceptor,
  PrismaModule,
} from '@app/common';
import { TiktokScrapModule } from './tiktok-scrap/tiktok-scrap.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validationSchema: Joi.object({
        PORT: Joi.string().required(),
        APP_NAME: Joi.string().required(),
        PREFIX_NAME: Joi.string().required(),
        JWT_EXPIRATION: Joi.string().required(),
        HEADLESS: Joi.string().required(),
        KEEP_BROWSER_OPEN: Joi.string().required(),
        SCRAPER_CACHE_TTL_MS: Joi.number().required(),
        SCRAPER_CACHE_MAX_ENTRIES: Joi.number().required()
      }),
    }),
    PrismaModule,
    TiktokScrapModule,
  ],
  controllers: [AppController],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: AppResponseInterceptor,
    },
  ],
})
export class AppModule { }
