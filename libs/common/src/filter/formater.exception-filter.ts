import { ValidationError } from '@nestjs/common';

export function errorFormater(
  errors: ValidationError[],
  parent_field?: string,
): any {
  const message: { property: string; message: string }[] = [];

  errors.forEach((error) => {
    const error_field = parent_field
      ? `${parent_field}.${error.property}`
      : error.property;

    if (!error.constraints && error.children.length) {
      const childErrors = errorFormater(error.children, error_field);
      message.push(...childErrors);
    } else {
      const validationsList = Object.values(error.constraints);
      const errorMessage =
        validationsList.length > 0 ? validationsList.pop() : 'Invalid value!';
      message.push({ property: error_field, message: errorMessage });
    }
  });

  return message;
}
