import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { TResponseApi } from '../type/response-api.type';

@Injectable()
export class AppResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map((data: TResponseApi) => {
        const response = context.switchToHttp().getResponse();
        return {
          statusCode: response.statusCode,
          message: data.message,
          data: data.data,
        };
      }),
    );
  }
}
