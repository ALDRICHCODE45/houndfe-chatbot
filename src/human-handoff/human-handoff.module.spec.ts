/**
 * SQ-5C2c2a human-handoff DI composition spec. Proves `HumanHandoffModule`
 * binds the domain-owned `SHIPPING_APPROVAL_POLICY` token to the frozen
 * `shippingApprovalPolicyAdapter` by identity through `useValue`, and that
 * `HumanHandoffService` declares that exact token as its fifth constructor
 * dependency. Pure metadata/Reflect inspection: the module is imported, but
 * no Nest application is bootstrapped and no provider, I/O, or network call
 * runs.
 */
import { shippingApprovalPolicyAdapter } from '../shipping/application/shipping-approval-policy.adapter';
import { HumanHandoffService } from './application/human-handoff.service';
import { SHIPPING_APPROVAL_POLICY } from './domain/shipping-approval-policy.port';
import { HumanHandoffModule } from './human-handoff.module';

interface ProviderEntry {
  provide?: unknown;
  useValue?: unknown;
  useClass?: unknown;
  useFactory?: unknown;
  useExisting?: unknown;
}

const providers = (): ProviderEntry[] =>
  (Reflect.getMetadata('providers', HumanHandoffModule) as
    | ProviderEntry[]
    | undefined) ?? [];

const exportsMetadata = (): unknown[] =>
  (Reflect.getMetadata('exports', HumanHandoffModule) as
    | unknown[]
    | undefined) ?? [];

const policyBinding = (): ProviderEntry | undefined =>
  providers().find((provider) => provider.provide === SHIPPING_APPROVAL_POLICY);

describe('HumanHandoffModule shipping-approval composition', () => {
  it('binds SHIPPING_APPROVAL_POLICY to the frozen adapter by identity', () => {
    const binding = policyBinding();
    expect(binding).toBeDefined();
    expect(binding?.useValue).toBe(shippingApprovalPolicyAdapter);
    expect(Object.isFrozen(binding?.useValue)).toBe(true);
  });

  it('binds the token with useValue only, with no indirection', () => {
    const binding = policyBinding();
    expect(binding?.useClass).toBeUndefined();
    expect(binding?.useFactory).toBeUndefined();
    expect(binding?.useExisting).toBeUndefined();
  });

  it('keeps the domain token private to the module', () => {
    expect(exportsMetadata()).not.toContain(SHIPPING_APPROVAL_POLICY);
  });

  it('declares the token as the fifth HumanHandoffService dependency', () => {
    const deps =
      (Reflect.getMetadata('self:paramtypes', HumanHandoffService) as
        | Array<{ index: number; param: unknown }>
        | undefined) ?? [];
    expect(deps).toContainEqual({ index: 4, param: SHIPPING_APPROVAL_POLICY });
  });
});
