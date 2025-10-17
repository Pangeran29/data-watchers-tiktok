import { Reflector } from '@nestjs/core';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { TCurrentUser } from '../type';

@Injectable()
export class RoleGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const role = this.reflector.getAllAndOverride('role', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!role) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user: TCurrentUser = request.user;

    return role.includes(user);
  }
}
