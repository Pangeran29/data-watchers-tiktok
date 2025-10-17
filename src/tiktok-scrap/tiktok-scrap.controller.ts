import { Body, Controller, Post } from '@nestjs/common';
import { TiktokScrapService } from './tiktok-scrap.service';
import { ApiTags } from '@nestjs/swagger';
import { CreateTiktokScrapDto } from './dto/create-tiktok-scrap.dto';

@ApiTags('TikTok Scraper')
@Controller('tiktok-scraper')
export class TiktokScrapController {
  constructor(private readonly scraper: TiktokScrapService) { }

  @Post('filter/cached')
  async scrapeFilterCached(
    @Body() dto: CreateTiktokScrapDto
  ) {
    const { key, items, metrics, fromCache } = await this.scraper.scrapeAnnotateAndCache(
      dto.search,
      dto.keyword,
      dto.maxCount ?? 10,
      dto.showVideoOnlyWithMatchKeyword ?? false,
      dto.forceRefresh ?? false
    );
    return { message: 'OK', data: { keyword: dto.keyword, query: dto.search, fromCache, metrics: fromCache ? null : metrics, items } };
  }
}
