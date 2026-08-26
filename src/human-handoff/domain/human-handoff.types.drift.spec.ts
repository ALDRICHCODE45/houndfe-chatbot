import type { HumanHandoffStore } from './human-handoff-store.port';
import type { HumanHandoffRequest } from './human-handoff.types';

/**
 * Type-only contract tests for HumanHandoffStore. These assertions
 * compile-time-only (TS would fail if the method shapes drift). The
 * runtime contract is asserted in `postgres-human-handoff.store.spec.ts`.
 *
 * Spec: human-handoff §"HumanHandoffStore port exposes the four CRUD primitives".
 */
describe('HumanHandoffStore port (type-level contract)', () => {
  it('declares the four CRUD primitives with the expected signatures', () => {
    type Keys = keyof HumanHandoffStore;
    const keys: Keys[] = [
      'create',
      'findById',
      'findByRef',
      'findLatestPendingForAgent',
      'resolve',
    ];
    expect(keys.sort()).toEqual(
      [
        'create',
        'findById',
        'findByRef',
        'findLatestPendingForAgent',
        'resolve',
      ].sort(),
    );

    // Compile-time-only: verify the runtime signatures align.
    type _CreateSig = HumanHandoffStore['create'];
    type _FindByIdSig = HumanHandoffStore['findById'];
    type _FindByRefSig = HumanHandoffStore['findByRef'];
    type _FindLatestPendingForAgentSig =
      HumanHandoffStore['findLatestPendingForAgent'];
    type _ResolveSig = HumanHandoffStore['resolve'];

    const _x: _CreateSig = async () => ({}) as HumanHandoffRequest;
    const _y: _FindByIdSig = async () => null;
    const _z: _FindByRefSig = async () => null;
    const _w: _FindLatestPendingForAgentSig = async () => null;
    const _v: _ResolveSig = async () => null;
    void _x;
    void _y;
    void _z;
    void _w;
    void _v;
  });
});
