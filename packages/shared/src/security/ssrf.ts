import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';

export interface TargetPolicy {
  allowPrivateTargets: boolean;
}

export class BlockedTargetError extends Error {
  readonly code = 'SSRF_BLOCKED';
}

// Ranges that are not reachable on the public internet: private networks,
// loopback, link-local (including cloud metadata at 169.254.169.254),
// carrier-grade NAT, documentation, benchmarking, multicast and reserved.
const BLOCKED_IPV4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

// Inside global unicast, these either embed an IPv4 address, which could be
// a private one, or are reserved for documentation and tunnels.
const BLOCKED_IPV6: [string, number][] = [
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
];

const blockedIpv4 = new BlockList();
for (const [network, prefix] of BLOCKED_IPV4) {
  blockedIpv4.addSubnet(network, prefix, 'ipv4');
}

const blockedIpv6 = new BlockList();
for (const [network, prefix] of BLOCKED_IPV6) {
  blockedIpv6.addSubnet(network, prefix, 'ipv6');
}

const globalUnicastIpv6 = new BlockList();
globalUnicastIpv6.addSubnet('2000::', 3, 'ipv6');

const IPV4_MAPPED = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

export function isPublicAddress(address: string): boolean {
  const mapped = IPV4_MAPPED.exec(address);
  if (mapped) {
    return isPublicAddress(mapped[1] as string);
  }
  switch (isIP(address)) {
    case 4:
      return !blockedIpv4.check(address, 'ipv4');
    // Only global unicast is public. This leaves out loopback, unique local,
    // link-local, multicast and the mapped and compatible IPv4 forms.
    case 6:
      return (
        globalUnicastIpv6.check(address, 'ipv6') &&
        !blockedIpv6.check(address, 'ipv6')
      );
    default:
      return false;
  }
}

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, '$1');
}

// Checks what can be decided from the URL alone. A hostname still has to be
// resolved, which happens at registration and again on every connection.
export function checkWebhookUrl(
  value: string,
  { allowPrivateTargets }: TargetPolicy,
): URL {
  const url = new URL(value);
  const allowedProtocols = allowPrivateTargets
    ? ['http:', 'https:']
    : ['https:'];
  if (!allowedProtocols.includes(url.protocol)) {
    throw new BlockedTargetError(
      allowPrivateTargets
        ? 'The URL must use http or https'
        : 'The URL must use https',
    );
  }
  if (url.username || url.password) {
    throw new BlockedTargetError('The URL must not contain credentials');
  }
  const host = hostOf(url);
  if (!allowPrivateTargets && isIP(host) && !isPublicAddress(host)) {
    throw new BlockedTargetError('The URL points to a non-public address');
  }
  return url;
}

export type ResolveHost = (hostname: string) => Promise<LookupAddress[]>;

const resolveWithDns: ResolveHost = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (error, addresses) =>
      error ? reject(error) : resolve(addresses),
    );
  });

export async function assertPublicTarget(
  value: string,
  policy: TargetPolicy,
  resolveHost: ResolveHost = resolveWithDns,
): Promise<void> {
  const url = checkWebhookUrl(value, policy);
  const host = hostOf(url);
  if (policy.allowPrivateTargets || isIP(host)) {
    return;
  }

  let addresses: LookupAddress[];
  try {
    addresses = await resolveHost(host);
  } catch {
    throw new BlockedTargetError('The URL hostname could not be resolved');
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicAddress(address))
  ) {
    throw new BlockedTargetError('The URL resolves to a non-public address');
  }
}

// Used for every outgoing connection. The socket connects to the address
// checked here, so a DNS answer that changes after registration, as in DNS
// rebinding, cannot reach an internal address.
export function createGuardedLookup(
  baseLookup: typeof dnsLookup = dnsLookup,
): LookupFunction {
  return (hostname, options, callback) => {
    baseLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      const list = addresses as LookupAddress[];
      if (
        list.length === 0 ||
        list.some(({ address }) => !isPublicAddress(address))
      ) {
        callback(
          new BlockedTargetError(
            `${hostname} resolves to a non-public address`,
          ) as NodeJS.ErrnoException,
          '',
          0,
        );
        return;
      }
      if (options.all) {
        (callback as unknown as (e: null, a: LookupAddress[]) => void)(
          null,
          list,
        );
      } else {
        const [first] = list as [LookupAddress];
        callback(null, first.address, first.family);
      }
    });
  };
}
