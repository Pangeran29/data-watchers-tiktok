import { Module } from '@nestjs/common';
import { TiktokScrapService } from './tiktok-scrap.service';
import { TiktokScrapController } from './tiktok-scrap.controller';

@Module({
  controllers: [TiktokScrapController],
  providers: [TiktokScrapService],
})
export class TiktokScrapModule {}
