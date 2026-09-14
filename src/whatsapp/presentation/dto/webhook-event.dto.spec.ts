import 'reflect-metadata';
import type { ValidationError } from 'class-validator';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { WebhookEventDto } from './webhook-event.dto';

/** Recursively search for a property name in the validation error tree. */
function hasErrorAt(errors: ValidationError[], property: string): boolean {
  return errors.some(
    (e) => e.property === property || hasErrorAt(e.children ?? [], property),
  );
}

describe('WebhookMessageDto — image and document fields', () => {
  const validMessage = (overrides: Record<string, unknown> = {}) =>
    plainToInstance(
      WebhookEventDto,
      {
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      id: 'msg1',
                      from: '521234567890',
                      timestamp: '1234567890',
                      type: 'image',
                      ...overrides,
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      { excludeExtraneousValues: false },
    );

  it('accepts image and document with required and optional fields', async () => {
    const imgDto = validMessage({
      type: 'image',
      image: { id: 'img1', mime_type: 'image/jpeg', caption: 'receipt' },
    });
    const docDto = validMessage({
      type: 'document',
      document: {
        id: 'doc1',
        mime_type: 'application/pdf',
        filename: 'pay.pdf',
      },
    });
    const [imgErrors, docErrors] = await Promise.all([
      validate(imgDto as object),
      validate(docDto as object),
    ]);
    expect(imgErrors).toHaveLength(0);
    expect(docErrors).toHaveLength(0);
  });

  it('accepts image with all optional media fields', async () => {
    const dto = validMessage({
      type: 'image',
      image: {
        id: 'img1',
        mime_type: 'image/png',
        caption: 'my receipt',
        filename: 'rcv.png',
        sha256: 'b'.repeat(64),
      },
    });
    const errors = await validate(dto as object);
    expect(errors).toHaveLength(0);
  });

  it('rejects missing id in nested image', async () => {
    const dto = validMessage({
      type: 'image',
      image: { mime_type: 'image/jpeg' },
    });
    const errors = await validate(dto as object);
    expect(hasErrorAt(errors, 'image')).toBe(true);
  });

  it('rejects empty id in nested image', async () => {
    const dto = validMessage({
      type: 'image',
      image: { id: '', mime_type: 'image/jpeg' },
    });
    const errors = await validate(dto as object);
    expect(hasErrorAt(errors, 'image')).toBe(true);
  });

  it('rejects missing mime_type in nested image', async () => {
    const dto = validMessage({
      type: 'image',
      image: { id: 'img1' },
    });
    const errors = await validate(dto as object);
    expect(hasErrorAt(errors, 'image')).toBe(true);
  });

  it('rejects empty mime_type in nested image', async () => {
    const dto = validMessage({
      type: 'image',
      image: { id: 'img1', mime_type: '' },
    });
    const errors = await validate(dto as object);
    expect(hasErrorAt(errors, 'image')).toBe(true);
  });

  it('rejects missing id in nested document', async () => {
    const dto = validMessage({
      type: 'document',
      document: { mime_type: 'application/pdf' },
    });
    const errors = await validate(dto as object);
    expect(hasErrorAt(errors, 'document')).toBe(true);
  });

  it('rejects empty mime_type in nested document', async () => {
    const dto = validMessage({
      type: 'document',
      document: { id: 'doc1', mime_type: '' },
    });
    const errors = await validate(dto as object);
    expect(hasErrorAt(errors, 'document')).toBe(true);
  });

  it('still accepts existing text message', async () => {
    const dto = validMessage({ type: 'text', text: { body: 'Hello' } });
    const errors = await validate(dto as object);
    expect(errors).toHaveLength(0);
  });
});
