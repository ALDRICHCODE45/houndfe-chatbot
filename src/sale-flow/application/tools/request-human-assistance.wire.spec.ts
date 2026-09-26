import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { makeRequestHumanAssistanceTool } from './request-human-assistance.tool';

describe('requestHumanAssistance OpenAI Responses wire contract', () => {
  it('sends an object-root non-strict schema through the installed SDK', async () => {
    const stopped = new Error('offline capture complete');
    let body = '';
    // This is the only provider transport: it never delegates to real fetch.
    const fetch = jest.fn((_url: unknown, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('Expected JSON body');
      body = init.body;
      return Promise.reject(stopped);
    });
    const openai = createOpenAI({ apiKey: 'dummy-offline-key', fetch });
    const requestHumanAssistance = makeRequestHumanAssistanceTool({
      cashierUserId: '00000000-0000-4000-8000-000000000001',
      chatbotApi: {} as never,
      store: {} as never,
      humanHandoffService: {} as never,
    });
    await expect(
      generateText({
        model: openai.responses('gpt-4o-mini'),
        prompt: 'Offline schema capture only',
        tools: { requestHumanAssistance },
        toolsContext: {
          requestHumanAssistance: { senderId: 'offline-sender' },
        },
        maxRetries: 0,
      }),
    ).rejects.toThrow('offline capture complete');
    expect(fetch).toHaveBeenCalledTimes(1);
    const wire = JSON.parse(body) as {
      tools: Array<{
        name: string;
        type: string;
        strict?: boolean;
        parameters: Record<string, unknown>;
      }>;
    };
    const sent = wire.tools[0];
    expect(sent.name).toBe('requestHumanAssistance');
    expect(sent.type).toBe('function');
    expect(sent.parameters.type).toBe('object');
    expect(sent.parameters).not.toHaveProperty('oneOf');
    expect(sent.parameters).not.toHaveProperty('anyOf');
    expect(sent.parameters).not.toHaveProperty('allOf');
    expect(sent.strict).toBe(false);
    expect(sent.parameters.required).toEqual(['kind', 'digest']);
    expect(sent.parameters.properties).toMatchObject({
      kind: { enum: ['out_of_stock', 'needs_human_review', 'expiration_date'] },
      digest: { anyOf: expect.any(Array) as unknown },
    });
  });
});
