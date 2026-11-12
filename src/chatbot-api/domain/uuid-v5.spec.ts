import {
  MEDIA_IDEMPOTENCY_NAMESPACE,
  UUID_NAMESPACE_DNS,
  UUID_NAMESPACE_URL,
  mediaIdempotencyKey,
  uuidV5,
} from './uuid-v5';

const LOWERCASE_UUID_V5 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidV5', () => {
  it('matches the reference vectors (python uuid.uuid5)', () => {
    expect(uuidV5('python.org', UUID_NAMESPACE_DNS)).toBe(
      '886313e1-3b8a-5372-9b90-0c9aee199e5d',
    );
    expect(uuidV5('https://example.com/a.jpg', UUID_NAMESPACE_URL)).toBe(
      '0af39f86-695f-5b4f-8503-15ef9f8ea23c',
    );
  });

  it('accepts an uppercase namespace and still answers lowercase', () => {
    expect(uuidV5('python.org', UUID_NAMESPACE_DNS.toUpperCase())).toBe(
      '886313e1-3b8a-5372-9b90-0c9aee199e5d',
    );
  });

  it('rejects a malformed namespace', () => {
    expect(() => uuidV5('x', 'not-a-uuid')).toThrow(TypeError);
  });
});

describe('mediaIdempotencyKey', () => {
  it('is a stable lowercase UUIDv5', () => {
    const key = mediaIdempotencyKey('meta-media-123');
    expect(key).toMatch(LOWERCASE_UUID_V5);
    expect(mediaIdempotencyKey('meta-media-123')).toBe(key);
    expect(key).toBe(uuidV5('meta-media-123', MEDIA_IDEMPOTENCY_NAMESPACE));
  });

  it('changes with the source and with the version, never with an empty one', () => {
    const base = mediaIdempotencyKey('https://cdn.example/p.jpg');
    expect(mediaIdempotencyKey('https://cdn.example/q.jpg')).not.toBe(base);
    expect(mediaIdempotencyKey('https://cdn.example/p.jpg', 'etag-1')).not.toBe(
      base,
    );
    expect(mediaIdempotencyKey('https://cdn.example/p.jpg', 'etag-1')).not.toBe(
      mediaIdempotencyKey('https://cdn.example/p.jpg', 'etag-2'),
    );
    expect(mediaIdempotencyKey('https://cdn.example/p.jpg', '')).toBe(base);
  });

  it('rejects an empty source', () => {
    expect(() => mediaIdempotencyKey('')).toThrow(TypeError);
  });
});
