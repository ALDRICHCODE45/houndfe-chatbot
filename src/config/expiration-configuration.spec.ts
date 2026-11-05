import configuration from './configuration';

// EXPIRATION is always on: HUMAN_DECISIONS_EXPIRATION_ENABLED is no longer
// projected, so even an explicit 'false' cannot switch it off.
const FLAG = 'HUMAN_DECISIONS_EXPIRATION_ENABLED';
const original = process.env[FLAG];
afterEach(() => {
  if (original === undefined) delete process.env[FLAG];
  else process.env[FLAG] = original;
});

it('does not project an EXPIRATION switch even when the old flag is false', () => {
  process.env[FLAG] = 'false';
  const agent = (
    configuration() as unknown as {
      minimalCatalogAgent: Record<string, unknown>;
    }
  ).minimalCatalogAgent;
  expect(agent).not.toHaveProperty('expirationEnabled');
});
