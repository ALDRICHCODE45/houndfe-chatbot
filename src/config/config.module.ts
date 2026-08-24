import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './configuration';
import { envValidationSchema } from './env.validation';

/**
 * Options accepted by `AppConfigModule.forRoot()`.
 *
 * `ignoreEnvFile` is intended for tests that want a *process.env-only*
 * environment (the working directory `.env` file in this repo masks
 * `delete process.env.X` because @nestjs/config auto-loads it). Production
 * callers should leave this default `false` so the `.env` file is read on
 * boot as designed.
 */
export interface AppConfigModuleOptions {
  ignoreEnvFile?: boolean;
}

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
 *   imports: [AppConfigModule.forRoot({ ignoreEnvFile: true })] ← process.env only
 */
@Module({})
export class AppConfigModule {
  static forRoot(options: AppConfigModuleOptions = {}): DynamicModule {
    return {
      module: AppConfigModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: options.ignoreEnvFile ?? false,
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
