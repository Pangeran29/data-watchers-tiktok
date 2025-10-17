import { SetMetadata } from "@nestjs/common";

export const Role = (...roles: String[]) => SetMetadata("role", roles);
