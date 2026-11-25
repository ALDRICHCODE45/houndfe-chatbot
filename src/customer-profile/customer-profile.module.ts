import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { CustomerProfileService } from './application/customer-profile.service';
import { LOCAL_PET_STORE } from './domain/customer-pets';
import { CUSTOMER_PROFILE_STORE } from './domain/customer-profile';
import { PostgresCustomerProfileStore } from './infrastructure/postgres-customer-profile.store';
import { PostgresLocalPetStore } from './infrastructure/postgres-local-pet.store';

/**
 * CustomerProfileModule (S1 persistent customer memory)
 *
 *   - `CUSTOMER_PROFILE_STORE` → `customer_profiles` table (migration 3700).
 *   - `CustomerProfileService` → best-effort reads/writes for the agent, the
 *     order service and the background notices.
 *   - `LOCAL_PET_STORE` → `customer_profiles.pets` (migration 5700): a
 *     prospect's local pets until they are uploaded (multi-pet T4b, S8).
 *     `CustomerPetsService` itself is provided by LlmAgentModule (it needs
 *     the chatbot-api clients).
 */
@Module({
  imports: [DatabaseModule],
  providers: [
    { provide: CUSTOMER_PROFILE_STORE, useClass: PostgresCustomerProfileStore },
    { provide: LOCAL_PET_STORE, useClass: PostgresLocalPetStore },
    CustomerProfileService,
  ],
  exports: [CUSTOMER_PROFILE_STORE, LOCAL_PET_STORE, CustomerProfileService],
})
export class CustomerProfileModule {}
