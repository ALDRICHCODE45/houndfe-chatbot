/**
 * Human-handoff DI composition spec. Proves `HumanHandoffService` declares
 * reservations as its fifth (last) constructor dependency and that no
 * per-quote shipping-approval policy is wired any more (S2). Pure
 * metadata/Reflect inspection: no Nest application is bootstrapped.
 */
import { SHARED_RESERVATION } from '../human-decisions/domain/shared-reservation';
import { HumanHandoffService } from './application/human-handoff.service';
import { HumanHandoffModule } from './human-handoff.module';

interface ProviderEntry {
  provide?: unknown;
}

const providers = (): ProviderEntry[] =>
  (Reflect.getMetadata('providers', HumanHandoffModule) as
    | ProviderEntry[]
    | undefined) ?? [];

describe('HumanHandoffModule composition', () => {
  it('binds no shipping-approval policy token', () => {
    const names = providers().map((provider) =>
      typeof provider.provide === 'symbol'
        ? provider.provide.description
        : provider.provide,
    );
    expect(names).not.toContain('SHIPPING_APPROVAL_POLICY');
  });

  it('declares the required reservation dependency at index 4 and nothing after it', () => {
    const deps =
      (Reflect.getMetadata('self:paramtypes', HumanHandoffService) as
        | Array<{ index: number; param: unknown }>
        | undefined) ?? [];
    expect(deps).toContainEqual({ index: 4, param: SHARED_RESERVATION });
    expect(deps.some((dep) => dep.index > 4)).toBe(false);
  });
});
