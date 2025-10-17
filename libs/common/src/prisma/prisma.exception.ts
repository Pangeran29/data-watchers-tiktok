import {
  BadRequestException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';

export class PrismaException extends InternalServerErrorException {
  private readonly logger = new Logger(PrismaException.name);

  constructor(error?: PrismaClientKnownRequestError) {
    let msg: any = 'Fail to do DB operation';

    if (error.code === 'P2002') {
      throw new BadRequestException(
        `Unique constraint exception at field ${error?.meta?.target}.`,
      );
    }

    if (error.code === 'P2003') {
      throw new NotFoundException(`${error?.meta?.field_name} not found.`);
    }

    if (error.code === 'P2025') {
      msg = `Record not found. Please check the id and make sure the record exist.`;
    }

    super({ message: msg, error: error.message || error });
    this.logger.error(error);
  }
}
