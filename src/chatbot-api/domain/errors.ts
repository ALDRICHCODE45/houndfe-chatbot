export class ChatbotApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number | null,
    public readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class AuthError extends ChatbotApiError {}

export class ForbiddenError extends ChatbotApiError {}

export class NotFoundError extends ChatbotApiError {}

export class UpstreamError extends ChatbotApiError {}

export class RateLimitError extends ChatbotApiError {
  constructor(retryAfterSeconds: number | null, responseBody?: unknown) {
    super('Chatbot API rate limit exceeded', 429, responseBody);
    this.retryAfterSeconds = retryAfterSeconds;
  }

  readonly retryAfterSeconds: number | null;
}

export class BranchMismatchError extends Error {
  constructor(
    public readonly configuredBranchId: string,
    public readonly attemptedBranchId: string,
  ) {
    super(
      `ChatbotApiClient is single-branch only. Configured branch ${configuredBranchId} does not match requested branch ${attemptedBranchId}.`,
    );
    this.name = 'BranchMismatchError';
  }
}
