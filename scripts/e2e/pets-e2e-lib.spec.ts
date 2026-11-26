import { NotFoundError } from '../../src/chatbot-api/domain/errors';
import {
  REDACTED,
  StepFailure,
  StepRunner,
  checkBaseUrl,
  checkTestPhone,
  describeError,
  exitCodeFor,
  isTestCustomerName,
  redact,
} from './pets-e2e-lib';

describe('pets-e2e-lib', () => {
  describe('checkBaseUrl', () => {
    it.each([
      ['http://localhost:3003', 'http://localhost:3003'],
      ['http://localhost:3003/', 'http://localhost:3003'],
      ['http://127.0.0.1:3003', 'http://127.0.0.1:3003'],
    ])('accepts the allow-listed dev host %s', (raw, expected) => {
      expect(checkBaseUrl(raw)).toBe(expected);
    });

    it.each([
      'https://api.houndfe.com',
      'http://api.houndfe.com:3003',
      'https://localhost:3003',
      'http://localhost:3000',
      'http://localhost',
      'http://localhost.evil.com:3003',
      'http://user:pw@localhost:3003',
      'http://localhost:3003/chatbot-api',
      'http://localhost:3003/?x=1',
      'not a url',
      '',
    ])('refuses %s', (raw) => {
      expect(checkBaseUrl(raw)).toBeNull();
    });

    it('uses only the given allow-list', () => {
      expect(
        checkBaseUrl('http://dev.internal:8080', ['dev.internal:8080']),
      ).toBe('http://dev.internal:8080');
      expect(checkBaseUrl('http://localhost:3003', [])).toBeNull();
    });
  });

  describe('test identity guards', () => {
    it('accepts only fake 555 ten-digit phones', () => {
      expect(checkTestPhone('5550002222')).toBe('5550002222');
      expect(checkTestPhone(' 5551234567 ')).toBe('5551234567');
      expect(checkTestPhone('5512349901')).toBeNull();
      expect(checkTestPhone('555000222')).toBeNull();
      expect(checkTestPhone('55500022223')).toBeNull();
      expect(checkTestPhone('555-000-2222')).toBeNull();
    });

    it('treats only "E2E " first names as test customers', () => {
      expect(isTestCustomerName('E2E Pets')).toBe(true);
      expect(isTestCustomerName('E2E Backorder')).toBe(true);
      expect(isTestCustomerName('Ana')).toBe(false);
      expect(isTestCustomerName('e2e pets')).toBe(false);
      expect(isTestCustomerName('E2EPets')).toBe(false);
      expect(isTestCustomerName(null)).toBe(false);
    });
  });

  describe('redact', () => {
    it('removes the given secrets, svc_ keys and bearer tokens', () => {
      const key = 'svc_abcDEF123-_.xyz';
      const out = redact(
        `key=${key} other=svc_zzz header="Bearer eyJhbGc.iOi.J9" pw=Manager123!`,
        [key, 'Manager123!'],
      );
      expect(out).not.toContain('abcDEF123');
      expect(out).not.toContain('svc_zzz');
      expect(out).not.toContain('eyJhbGc');
      expect(out).not.toContain('Manager123!');
      expect(out).toContain(REDACTED);
    });

    it('ignores empty secrets and leaves clean text alone', () => {
      expect(redact('[1a.lookup] PASS http=200', ['', ''])).toBe(
        '[1a.lookup] PASS http=200',
      );
    });
  });

  describe('describeError', () => {
    it('keeps only status, code and class name', () => {
      const error = new NotFoundError(
        'secret message svc_abc',
        404,
        { error: 'PET_NOT_FOUND', phone: '5550002222' },
        'PET_NOT_FOUND',
      );
      expect(describeError(error)).toEqual({
        http: 404,
        code: 'PET_NOT_FOUND',
        error: 'NotFoundError',
      });
      expect(describeError(new TypeError('x'))).toEqual({
        http: null,
        code: null,
        error: 'TypeError',
      });
    });
  });

  describe('StepRunner', () => {
    const make = (secrets: string[] = []) => {
      const lines: string[] = [];
      return {
        lines,
        runner: new StepRunner((text) => lines.push(text), secrets),
      };
    };

    it('records PASS, expected-code PASS and SKIP lines', () => {
      const { lines, runner } = make();
      runner.pass('1a.lookup', 200, { found: true });
      runner.passCode('6b.staleMax', 409, 'PET_VERSION_CONFLICT', {
        currentVersion: 2,
      });
      runner.skip('7a.checkout', 'no products');
      expect(lines).toEqual([
        '[1a.lookup] PASS http=200 found=true\n',
        '[6b.staleMax] PASS http=409 code="PET_VERSION_CONFLICT" currentVersion=2\n',
        '[7a.checkout] SKIP reason="no products"\n',
      ]);
      expect(runner.counts()).toEqual({ PASS: 2, FAIL: 0, SKIP: 1 });
      expect(runner.summaryEntries()).toEqual([
        '1a.lookup:PASS:200',
        '6b.staleMax:PASS:409:PET_VERSION_CONFLICT',
        '7a.checkout:SKIP',
      ]);
    });

    it('fail records the step and throws StepFailure', () => {
      const { lines, runner } = make();
      expect(() =>
        runner.fail('3a.createMax', 'create refused', {}, null, 'FORBIDDEN'),
      ).toThrow(StepFailure);
      expect(lines).toEqual([
        '[3a.createMax] FAIL code="FORBIDDEN" reason="create refused"\n',
      ]);
      expect(runner.counts().FAIL).toBe(1);
    });

    it('call turns an unexpected throw into a FAIL with status and code only', async () => {
      const { lines, runner } = make();
      await expect(
        runner.call('8c.historyUnknownPet', () =>
          Promise.reject(
            new NotFoundError('boom 5550002222', 404, {}, 'PET_NOT_FOUND'),
          ),
        ),
      ).rejects.toBeInstanceOf(StepFailure);
      expect(lines[0]).toBe(
        '[8c.historyUnknownPet] FAIL http=404 code="PET_NOT_FOUND" reason="client call failed" error="NotFoundError"\n',
      );
      expect(lines[0]).not.toContain('5550002222');
      await expect(runner.call('x', () => Promise.resolve(7))).resolves.toBe(7);
    });

    it('redacts every line it writes', () => {
      const { lines, runner } = make(['svc_secretkey']);
      runner.line('config', 'ok', {
        echo: 'svc_secretkey',
        token: 'Bearer abc',
      });
      expect(lines[0]).not.toContain('secretkey');
      expect(lines[0]).not.toContain('abc');
    });
  });

  describe('exitCodeFor', () => {
    const pass = {
      step: 'a',
      outcome: 'PASS' as const,
      http: '200',
      code: null,
    };
    const skip = {
      step: 'b',
      outcome: 'SKIP' as const,
      http: null,
      code: null,
    };
    const fail = {
      step: 'c',
      outcome: 'FAIL' as const,
      http: null,
      code: null,
    };

    it('is 0 only when every non-SKIP step passed and all is clean', () => {
      expect(exitCodeFor([pass, skip], false, [])).toBe(0);
      expect(exitCodeFor([pass, fail], false, [])).toBe(1);
      expect(exitCodeFor([pass], true, [])).toBe(1);
      expect(exitCodeFor([pass], false, ['pet x not deleted'])).toBe(1);
      expect(exitCodeFor([skip], false, [])).toBe(1);
      expect(exitCodeFor([], false, [])).toBe(1);
    });
  });
});
