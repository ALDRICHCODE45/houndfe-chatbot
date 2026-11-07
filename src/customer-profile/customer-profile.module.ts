import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { CustomerProfileService } from './application/customer-profile.service';
import { CUSTOMER_PROFILE_STORE } from './domain/customer-profile';
import { PostgresCustomerProfileStore } from './infrastructure/postgres-customer-profile.store';

/**
 * CustomerProfileModule (S1 persistent customer memory)
 *
 *   - `CUSTOMER_PROFILE_STORE` → `customer_profiles` table (migration 3700).
 *   - `CustomerProfileService` → best-effort reads/writes for the agent, the
 *     order service and the background notices.
 */
@Module({
  imports: [DatabaseModule],
  providers: [
    { provide: CUSTOMER_PROFILE_STORE, useClass: PostgresCustomerProfileStore },
    CustomerProfileService,
  ],
  exports: [CUSTOMER_PROFILE_STORE, CustomerProfileService],
})
export class CustomerProfileModule {}
