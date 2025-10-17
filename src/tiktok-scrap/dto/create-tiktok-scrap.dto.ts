import { IsBoolean, IsNotEmpty, IsOptional, IsString, IsUrl } from 'class-validator';

export class CreateTiktokScrapDto {
    @IsNotEmpty()
    search: string; 
    
    @IsNotEmpty()
    keyword: string; 
    
    @IsOptional()
    maxCount?: number = 10; 
    
    @IsOptional()
    @IsBoolean()
    showVideoOnlyWithMatchKeyword?: boolean = false; 
    
    @IsOptional()
    @IsBoolean()
    forceRefresh?: boolean = false;
}
