# ─── Stage 1: Build ───────────────────────────────────────────────────────
FROM node:24-alpine AS build

# pnpm requires these on Alpine; pin to the exact lockfile version
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate

WORKDIR /app

# Install dependencies (frozen lockfile for reproducibility)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm build

# ─── Stage 2: Production ──────────────────────────────────────────────────
FROM node:24-alpine AS production

RUN corepack enable && corepack prepare pnpm@11.18.0 --activate

ENV NODE_ENV=production

WORKDIR /app

# Install only production dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Copy compiled output and migrations
COPY --from=build /app/dist ./dist
COPY migrations ./migrations

EXPOSE 3000

CMD ["sh", "-c", "pnpm migrate && node dist/main"]
