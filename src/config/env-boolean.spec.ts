import * as Joi from 'joi';
import { envBoolean } from './env-boolean';

describe('envBoolean', () => {
  it.each([undefined, '', '1', '0', 'yes', 'no', 'on', 'garbage'])(
    'falls back to the default for %p',
    (value) => {
      expect(envBoolean(value)).toBe(false);
      expect(envBoolean(value, true)).toBe(true);
    },
  );

  it.each([
    'true',
    'TRUE',
    'True',
    'tRuE',
    ' true',
    'true ',
    'false',
    'FALSE',
    'False',
    ' false ',
    '1',
    'yes',
    '',
  ])('agrees with Joi.boolean() for %p', (value) => {
    const { value: joiValue, error } = Joi.boolean().validate(value) as {
      value: boolean;
      error?: Joi.ValidationError;
    };
    if (error) {
      expect(envBoolean(value)).toBe(false);
    } else {
      expect(envBoolean(value)).toBe(joiValue);
    }
  });
});
