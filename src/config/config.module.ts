import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './configuration';
import { envValidationSchema } from './env.validation';

/**
 * Global config module.
 *
 * Exposes a static `forRoot()` factory so the module can be initialised
 * at runtime (either in app bootstrap or in tests), AFTER the environment
 * variables are in place. This prevents `ConfigModule.forRoot()` from
 * executing at class-definition time (which would throw in tests that
 * haven't set env vars yet).
 *
 * Usage in app.module.ts:
 *   imports: [AppConfigModule.forRoot()]
 *
 * Usage in tests:
 *   imports: [AppConfigModule.forRoot()]  ← called after process.env is set
 */
@Module({})
export class AppConfigModule {
  static forRoot(): DynamicModule {
    return {
      module: AppConfigModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [configuration],
          validationSchema: envValidationSchema,
          validationOptions: {
            abortEarly: false,
          },
        }),
      ],
      exports: [ConfigModule],
    };
  }
}
