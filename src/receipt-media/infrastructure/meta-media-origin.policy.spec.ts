/** WU4B1A spec: reusable HTTPS origin and pinned public-DNS policy proofs. */
import type { LookupOptions } from 'node:dns';
import { MetaMediaError } from '../domain/meta-media.port';
import {
  isPublicAddress,
  pinnedLookup,
  validateMetaMediaOrigin,
  type MetaDnsResolver,
  type MetaMediaOriginPolicyConfig,
} from './meta-media-origin.policy';

const HOST = 'graph.facebook.com';
const config: MetaMediaOriginPolicyConfig = { allowedHosts: [HOST] };
const addr = (address: string, family: 4 | 6 = 4) => ({ address, family });
const PINNED = [addr('8.8.8.8')];
const publicDns: MetaDnsResolver = () => Promise.resolve(PINNED);

const accepts = (url: string, cfg = config, resolve = publicDns) =>
  expect(validateMetaMediaOrigin(url, cfg, resolve)).resolves.toEqual(PINNED);

const rejects = async (url: string, cfg = config, resolve = publicDns) => {
  const err: unknown = await validateMetaMediaOrigin(url, cfg, resolve).catch(
    (error: unknown) => error,
  );
  expect(err).toBeInstanceOf(MetaMediaError);
  expect(err).toMatchObject({
    category: 'META_TRANSPORT',
    code: 'NETWORK_FAILURE',
    message: 'receipt-media:META_TRANSPORT/NETWORK_FAILURE',
  });
};

describe('validateMetaMediaOrigin', () => {
  it.each([
    ['not-a-url'],
    ['http://graph.facebook.com/media'],
    ['https://user:pass@graph.facebook.com/media'],
    ['https://graph.facebook.com/media?truncate=true'],
    ['https://graph.facebook.com/media#fragment'],
    ['https://graph.facebook.com?'],
    ['https://graph.facebook.com#'],
    ['https://graph.facebook.com/media?#'],
    ['https://graph.facebook.com:8443/media'],
    ['https://evil.example.com/media'],
    ['https://notgraph.facebook.com/media'],
    ['https://graph.facebook.com.media.evil.example/x'],
  ])('rejects unsafe origin %s', rejects);

  it('accepts exact, explicit-443, subdomain, and explicit test-seam origins', async () => {
    await accepts(`https://${HOST}/v21.0/media`);
    await accepts(`https://${HOST}:443/media`);
    await accepts('https://lookaside.graph.facebook.com/media');
    const seam = { allowedHosts: [HOST], testPort: 8443 };
    await accepts('https://graph.facebook.com:8443/media', seam);
    await rejects('https://graph.facebook.com:443/media', seam);
  });

  it('normalizes allowed-host case and leading dots at label boundaries', async () => {
    const loose = { allowedHosts: ['.GRAPH.Facebook.COM', 'FBcdn.net'] };
    await accepts('https://graph.facebook.com/media', loose);
    await accepts('https://lookaside.GRAPH.facebook.com/media', loose);
    await rejects('https://notgraph.facebook.com/media', loose);
  });

  it('resolves the target hostname and requires every A/AAAA result to be global', async () => {
    const seen: string[] = [];
    const mixed: MetaDnsResolver = (hostname) => {
      seen.push(hostname);
      return Promise.resolve([addr('8.8.8.8'), addr('::ffff:10.0.0.5', 6)]);
    };
    await rejects(`https://${HOST}/media`, config, mixed);
    expect(seen).toEqual([HOST]);
    await rejects(`https://${HOST}/media`, config, () => Promise.resolve([]));
  });

  it('rejects resolver records with conflicting declared family', async () => {
    await rejects(`https://${HOST}/media`, config, () =>
      Promise.resolve([addr('8.8.8.8', 6), addr('2606:4700::1111', 4)]),
    );
    await rejects(`https://${HOST}/media`, config, () =>
      Promise.resolve([addr('::ffff:8.8.8.8', 4)]),
    );
    await expect(
      validateMetaMediaOrigin(`https://${HOST}/media`, config, () =>
        Promise.resolve([addr('::ffff:8.8.8.8', 6)]),
      ),
    ).resolves.toEqual([addr('::ffff:8.8.8.8', 6)]);
  });

  it('maps resolver failures to the fixed safe transport error', async () => {
    await rejects(`https://${HOST}/media`, config, () =>
      Promise.reject(new Error(`lookup failed for ${HOST}`)),
    );
  });
});

describe('isPublicAddress', () => {
  it.each([
    ['8.8.8.8', undefined, true],
    ['2606:4700::1111', undefined, true],
    ['::ffff:8.8.8.8', undefined, true],
    ['127.0.0.1', undefined, false],
    ['::1', undefined, false],
    ['10.0.0.5', undefined, false],
    ['fe80::1', undefined, false],
    ['fc00::1', undefined, false],
    ['100.64.0.1', undefined, false],
    ['224.0.0.1', undefined, false],
    ['169.254.1.1', undefined, false],
    ['2001:db8::1', undefined, false],
    ['::ffff:10.0.0.5', undefined, false],
    ['not-an-ip', undefined, false],
    ['', undefined, false],
    ['8.8.8.8', 6, false],
    ['2606:4700::1111', 4, false],
    ['::ffff:8.8.8.8', 4, false],
    ['::ffff:8.8.8.8', 6, true],
  ])('classifies %s (family %s) public=%s', (address, family, expected) => {
    expect(isPublicAddress(address, family)).toBe(expected);
  });
});

describe('pinnedLookup', () => {
  it('serves only the pinned addresses in scalar and options.all callbacks', () => {
    const addresses = [addr('8.8.8.8'), addr('2606:4700::1111', 6)];
    const lookup = pinnedLookup(HOST, addresses);
    const scalar: Array<[string, number]> = [];
    for (let call = 0; call < 2; call += 1) {
      lookup(HOST, {}, (err, address, family) => {
        expect(err).toBeNull();
        scalar.push([address as string, family as number]);
      });
    }
    expect(scalar).toEqual([
      ['8.8.8.8', 4],
      ['2606:4700::1111', 6],
    ]);
    lookup(HOST, { all: true }, (err, list) => {
      expect(err).toBeNull();
      expect(list).toEqual(addresses);
    });
  });

  it('is bound to the validated hostname without touching TLS naming options', () => {
    const lookup = pinnedLookup(HOST, PINNED);
    const options = { all: false, servername: HOST } as LookupOptions;
    lookup(HOST, options, (err, address) => {
      expect(err).toBeNull();
      expect(address).toBe('8.8.8.8');
    });
    expect(options).toEqual({ all: false, servername: HOST });
    const mismatches: NodeJS.ErrnoException[] = [];
    lookup('rebind.attacker.example', {}, (err) => {
      if (err) mismatches.push(err);
    });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].message).toBe('pinned lookup hostname mismatch');
  });
});
