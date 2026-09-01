import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const approved = [
  ['@aws-sdk/client-s3', '3.1121.0'],
  ['ipaddr.js', '2.5.0'],
  ['prom-client', '15.1.3'],
] as const;

describe('Receipt media approved dependencies', () => {
  it.each(approved)('declares only approved %s', (name, version) => {
    expect(packageJson.dependencies[name]).toBe(version);
  });

  it('imports the required S3 command surface', async () => {
    const s3 = await import('@aws-sdk/client-s3');
    for (const name of [
      'S3Client',
      'PutObjectCommand',
      'GetObjectCommand',
      'HeadObjectCommand',
      'DeleteObjectCommand',
    ] as const) {
      expect(typeof s3[name]).toBe('function');
    }
  });

  it('imports the ipaddr.js parse, kind, and range surface', async () => {
    const imported = await import('ipaddr.js');
    const ip: typeof import('ipaddr.js') = imported.default ?? imported;
    expect(typeof ip.parse).toBe('function');
    expect(typeof ip.parseCIDR).toBe('function');
    expect(typeof ip.IPv4).toBe('function');
    expect(ip.IPv4.parse('192.168.1.1').range()).toBe('private');
  });

  it('imports the prom-client registry and counter surface', async () => {
    const { Registry, Counter } = await import('prom-client');
    expect(typeof Registry).toBe('function');
    expect(typeof Counter).toBe('function');
  });

  it('declares no extra AWS or ipaddr type package', () => {
    expect(
      Object.keys(packageJson.dependencies).filter((name) =>
        name.startsWith('@aws-sdk/'),
      ),
    ).toEqual(['@aws-sdk/client-s3']);
    expect(packageJson.devDependencies['@types/ipaddr.js']).toBeUndefined();
  });
});
