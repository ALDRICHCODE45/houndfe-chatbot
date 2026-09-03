/** WU4B1A: reusable HTTPS origin and pinned public-DNS policy for Meta media hops. */
import * as dns from 'node:dns';
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { MetaMediaError } from '../domain/meta-media.port';

export type MetaDnsResolver = (hostname: string) => Promise<LookupAddress[]>;

export interface MetaMediaOriginPolicyConfig {
  allowedHosts: string[];
  /** Explicit non-production test seam; never set in production configuration. */
  testPort?: number;
}

const transportFailure = (): MetaMediaError =>
  new MetaMediaError('META_TRANSPORT', 'NETWORK_FAILURE');

/** Only global unicast is public; IPv4-mapped IPv6 is decoded and re-checked;
 *  a declared resolver family must match the parsed address kind. */
export function isPublicAddress(address: string, family?: number): boolean {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.parse(address);
  if (family !== undefined && family !== (parsed.kind() === 'ipv4' ? 4 : 6))
    return false;
  const addr =
    parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()
      ? (parsed as ipaddr.IPv6).toIPv4Address()
      : parsed;
  return addr.range() === 'unicast';
}

/** Exact or suffix match at a whole label boundary only; entries are
 *  lowercased and a leading-dot suffix marker is stripped before matching. */
function hostIsAllowed(hostname: string, allowedHosts: string[]): boolean {
  return allowedHosts.some((raw) => {
    const entry = raw.trim().toLowerCase().replace(/^\./, '');
    return hostname === entry || hostname.endsWith(`.${entry}`);
  });
}

/** Node A/AAAA resolver seam returning every address for the hostname. */
export function defaultResolver(): MetaDnsResolver {
  return (hostname) =>
    dns.promises.lookup(hostname, { all: true, verbatim: true });
}

/**
 * Validates one hop target before any request construction: HTTPS only, no
 * userinfo/query/fragment, port 443 (or the explicit non-production test
 * port), exact/label-boundary allowlist, then every resolved A/AAAA address
 * must be global. Fails closed to the fixed safe transport error.
 */
export async function validateMetaMediaOrigin(
  url: string,
  config: MetaMediaOriginPolicyConfig,
  resolve: MetaDnsResolver = defaultResolver(),
): Promise<LookupAddress[]> {
  // Check the raw string first: WHATWG normalization erases a trailing
  // delimiter-only query/fragment, hiding its presence from parsed fields.
  if (/[?#]/.test(url)) throw transportFailure();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw transportFailure();
  }
  const allowedPort = config.testPort ?? 443;
  // An implicit port is only 443; a non-443 test port must be written out.
  const portAllowed =
    parsed.port === ''
      ? allowedPort === 443
      : Number(parsed.port) === allowedPort;
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !portAllowed ||
    !hostIsAllowed(parsed.hostname, config.allowedHosts)
  )
    throw transportFailure();
  let addresses: LookupAddress[];
  try {
    addresses = await resolve(parsed.hostname);
  } catch {
    throw transportFailure();
  }
  if (
    addresses.length === 0 ||
    !addresses.every((entry) => isPublicAddress(entry.address, entry.family))
  )
    throw transportFailure();
  return addresses;
}

/**
 * Node lookup pinned to the validated address set, bound to the validated
 * hostname: any other hostname fails closed, so connect-time resolution can
 * never rebind. TLS SNI/hostname verification stays the caller's concern —
 * this lookup never rewrites servername or checkServerIdentity.
 */
export function pinnedLookup(
  boundHostname: string,
  addresses: LookupAddress[],
): LookupFunction {
  let cursor = 0;
  return (hostname, options, callback) => {
    if (hostname !== boundHostname) {
      // Node's LookupFunction callback requires an address even on error; the
      // empty string is unreachable because the error aborts the connection.
      callback(
        Object.assign(new Error('pinned lookup hostname mismatch'), {
          code: 'EMETAPIN',
        }),
        '',
      );
      return;
    }
    if (options.all === true) {
      callback(null, addresses);
      return;
    }
    const chosen = addresses[cursor % addresses.length];
    cursor += 1;
    callback(null, chosen.address, chosen.family);
  };
}
