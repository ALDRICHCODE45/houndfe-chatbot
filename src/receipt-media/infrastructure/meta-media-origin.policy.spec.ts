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

/** S3: Meta's real download URLs carry a query string; only download hops on
 *  allowlisted hosts may opt in, everything else stays rejected. */
describe('validateMetaMediaOrigin download hops with a query (S3)', () => {
  const LOOKASIDE = 'lookaside.fbsbx.com';
  const download: MetaMediaOriginPolicyConfig = { allowedHosts: [LOOKASIDE] };
  const REAL = `https://${LOOKASIDE}/whatsapp_business/attachments/?mid=123&ext=456&hash=abc`;
  const OPT_IN = { allowQuery: true };

  const downloadAccepts = (url: string, cfg = download, resolve = publicDns) =>
    expect(validateMetaMediaOrigin(url, cfg, resolve, OPT_IN)).resolves.toEqual(
      PINNED,
    );

  const downloadRejects = async (
    url: string,
    cfg = download,
    resolve = publicDns,
  ) => {
    const err: unknown = await validateMetaMediaOrigin(
      url,
      cfg,
      resolve,
      OPT_IN,
    ).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(MetaMediaError);
    expect(err).toMatchObject({
      category: 'META_TRANSPORT',
      code: 'NETWORK_FAILURE',
      message: 'receipt-media:META_TRANSPORT/NETWORK_FAILURE',
    });
  };

  it('accepts the real lookaside shape and an empty-path query on an allowlisted host', async () => {
    await downloadAccepts(REAL);
    await downloadAccepts(`https://${LOOKASIDE}/x?a=1`);
    await downloadAccepts(`https://sub.${LOOKASIDE}/x?a=1&b=%2F`);
  });

  it('keeps the query rejected unless the hop explicitly opts in', async () => {
    await rejects(REAL, download);
    await expect(
      validateMetaMediaOrigin(REAL, download, publicDns, { allowQuery: false }),
    ).rejects.toBeInstanceOf(MetaMediaError);
  });

  it.each([
    ['non-HTTPS', `http://${LOOKASIDE}/x?mid=1`],
    ['userinfo', `https://user:pass@${LOOKASIDE}/x?mid=1`],
    ['password-less userinfo', `https://user@${LOOKASIDE}/x?mid=1`],
    ['fragment after query', `https://${LOOKASIDE}/x?mid=1#frag`],
    ['bare fragment', `https://${LOOKASIDE}/x#frag`],
    ['non-443 port', `https://${LOOKASIDE}:8443/x?mid=1`],
    ['host not allowlisted', 'https://evil.example.com/x?mid=1'],
    ['label-boundary suffix lookalike', `https://not${LOOKASIDE}/x?mid=1`],
    ['allowlisted host as a prefix', `https://${LOOKASIDE}.evil.example/x?a=1`],
    [
      'allowlisted host smuggled in the query',
      `https://evil.example/?h=${LOOKASIDE}`,
    ],
    [
      'allowlisted host smuggled as userinfo',
      `https://${LOOKASIDE}@evil.example/x?a=1`,
    ],
    ['backslash host confusion', `https://evil.example\\@${LOOKASIDE}/x?a=1`],
    ['unparseable', 'not-a-url?mid=1'],
  ])('still rejects %s', async (_label, url) => {
    await downloadRejects(url);
  });

  it('still requires every resolved address to be public, incl. IPv4-mapped IPv6', async () => {
    await downloadRejects(REAL, download, () =>
      Promise.resolve([addr('10.0.0.5')]),
    );
    await downloadRejects(REAL, download, () =>
      Promise.resolve([addr('::ffff:10.0.0.5', 6)]),
    );
    await downloadRejects(REAL, download, () =>
      Promise.resolve([addr('8.8.8.8'), addr('::1', 6)]),
    );
    await downloadRejects(REAL, download, () => Promise.resolve([]));
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
    const addresses = [addr('8.8.8.8'), addr('1.1.1.1')];
    const lookup = pinnedLookup(HOST, addresses);
    const scalar: Array<[string, number]> = [];
    for (let call = 0; call < 3; call += 1) {
      lookup(HOST, {}, (err, address, family) => {
        expect(err).toBeNull();
        scalar.push([address as string, family as number]);
      });
    }
    expect(scalar).toEqual([
      ['8.8.8.8', 4],
      ['1.1.1.1', 4],
      ['8.8.8.8', 4],
    ]);
    lookup(HOST, { all: true }, (err, list) => {
      expect(err).toBeNull();
      expect(list).toEqual(addresses);
    });
  });

  describe('IPv4 preference (S4)', () => {
    const V6 = addr('2606:4700::1111', 6);
    const V4 = addr('8.8.8.8');

    const scalarOf = (
      lookup: ReturnType<typeof pinnedLookup>,
      calls = 3,
    ): Array<[string, number]> => {
      const out: Array<[string, number]> = [];
      for (let call = 0; call < calls; call += 1)
        lookup(HOST, {}, (err, address, family) => {
          expect(err).toBeNull();
          out.push([address as string, family as number]);
        });
      return out;
    };

    it.each([
      ['AAAA first (verbatim resolver order)', [V6, V4]],
      ['A first', [V4, V6]],
    ])('never hands IPv6 while a validated IPv4 exists: %s', (_l, set) => {
      const lookup = pinnedLookup(HOST, set);
      expect(scalarOf(lookup)).toEqual([
        ['8.8.8.8', 4],
        ['8.8.8.8', 4],
        ['8.8.8.8', 4],
      ]);
      lookup(HOST, { all: true }, (err, list) => {
        expect(err).toBeNull();
        expect(list).toEqual([V4]);
      });
    });

    it('still serves a validated public IPv6 when it is the only family', () => {
      const lookup = pinnedLookup(HOST, [V6]);
      expect(scalarOf(lookup, 2)).toEqual([
        ['2606:4700::1111', 6],
        ['2606:4700::1111', 6],
      ]);
      lookup(HOST, { all: true }, (err, list) => {
        expect(err).toBeNull();
        expect(list).toEqual([V6]);
      });
    });

    it('does not weaken validation: a non-public AAAA beside a public A is still rejected', async () => {
      await rejects(`https://${HOST}/media`, config, () =>
        Promise.resolve([V4, addr('fc00::1', 6)]),
      );
      await rejects(`https://${HOST}/media`, config, () =>
        Promise.resolve([addr('10.0.0.5'), V6]),
      );
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
