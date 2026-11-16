/** WU4B1A: reusable HTTPS origin and pinned public-DNS policy for Meta media hops. */
import * as dns from 'node:dns';
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { MetaMediaError } from '../domain/meta-media.port';
import {
  withMetaFailureReason,
  type MetaPolicyRejectionReason,
} from './meta-media-failure-reason';

export type MetaDnsResolver = (hostname: string) => Promise<LookupAddress[]>;

export interface MetaMediaOriginPolicyConfig {
  allowedHosts: string[];
  /** Explicit non-production test seam; never set in production configuration. */
  testPort?: number;
}

/** Per-hop policy switches; every one defaults to the strictest value. */
export interface MetaMediaHopOptions {
  /** Allow a query string. Only download hops on allowlisted hosts opt in
   *  (Meta's real media URLs carry mid/ext/hash); the Graph metadata URL is
   *  composed internally and stays query-free. Fragments are never allowed. */
  allowQuery?: boolean;
}

const rejection = (reason: MetaPolicyRejectionReason): MetaMediaError =>
  withMetaFailureReason(
    new MetaMediaError('META_TRANSPORT', 'NETWORK_FAILURE'),
    reason,
  );

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
 * userinfo/fragment (and no query unless the hop explicitly opts in), port 443
 * (or the explicit non-production test port), exact/label-boundary allowlist,
 * then every resolved A/AAAA address must be global. Fails closed to the
 * fixed safe transport error; the rejection kind is only recorded on the
 * safe side-channel, never in the error.
 */
export async function validateMetaMediaOrigin(
  url: string,
  config: MetaMediaOriginPolicyConfig,
  resolve: MetaDnsResolver = defaultResolver(),
  options: MetaMediaHopOptions = {},
): Promise<LookupAddress[]> {
  const allowQuery = options.allowQuery === true;
  // Check the raw string first: WHATWG normalization erases a trailing
  // delimiter-only query/fragment, hiding its presence from parsed fields.
  if (url.includes('#')) throw rejection('FRAGMENT_NOT_ALLOWED');
  if (!allowQuery && url.includes('?')) throw rejection('QUERY_NOT_ALLOWED');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw rejection('URL_INVALID');
  }
  const allowedPort = config.testPort ?? 443;
  // An implicit port is only 443; a non-443 test port must be written out.
  const portAllowed =
    parsed.port === ''
      ? allowedPort === 443
      : Number(parsed.port) === allowedPort;
  if (parsed.protocol !== 'https:') throw rejection('SCHEME_NOT_HTTPS');
  if (parsed.username !== '' || parsed.password !== '')
    throw rejection('USERINFO_NOT_ALLOWED');
  if (parsed.hash !== '') throw rejection('FRAGMENT_NOT_ALLOWED');
  if (!allowQuery && parsed.search !== '') throw rejection('QUERY_NOT_ALLOWED');
  if (!portAllowed) throw rejection('PORT_NOT_ALLOWED');
  if (!hostIsAllowed(parsed.hostname, config.allowedHosts))
    throw rejection('HOST_NOT_ALLOWED');
  let addresses: LookupAddress[];
  try {
    addresses = await resolve(parsed.hostname);
  } catch {
    throw rejection('DNS_FAILED');
  }
  if (addresses.length === 0) throw rejection('DNS_FAILED');
  if (!addresses.every((entry) => isPublicAddress(entry.address, entry.family)))
    throw rejection('NON_PUBLIC_ADDRESS');
  return addresses;
}

/** S4: validated IPv4 addresses are preferred — IPv6 is only ever handed when
 *  the validated set has no IPv4 at all (the production container has no IPv6
 *  route, so an AAAA record would fail with ENETUNREACH). Never adds, changes
 *  or skips validation: the input set was already fully validated. */
function preferIpv4(addresses: LookupAddress[]): LookupAddress[] {
  const v4 = addresses.filter((entry) => entry.family === 4);
  return v4.length > 0 ? v4 : addresses;
}

/**
 * Node lookup pinned to the validated address set (IPv4-first), bound to the
 * validated hostname: any other hostname fails closed, so connect-time
 * resolution can never rebind. TLS SNI/hostname verification stays the
 * caller's concern — this lookup never rewrites servername or
 * checkServerIdentity.
 */
export function pinnedLookup(
  boundHostname: string,
  addresses: LookupAddress[],
): LookupFunction {
  const preferred = preferIpv4(addresses);
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
      callback(null, preferred);
      return;
    }
    const chosen = preferred[cursor % preferred.length];
    cursor += 1;
    callback(null, chosen.address, chosen.family);
  };
}
