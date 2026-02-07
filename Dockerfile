# Stage 1: Builder
FROM node:20-slim AS builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/runs-client/package.json ./packages/runs-client/

# Install dependencies
RUN pnpm install --frozen-lockfile || pnpm install

# Copy source code
COPY . .

# Build runs-client package
RUN pnpm --filter @mcpfactory/runs-client build

# Build the service
RUN pnpm build

# Stage 2: Production
FROM node:20-slim

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/runs-client/package.json ./packages/runs-client/

# Install production dependencies only
RUN pnpm install --prod --frozen-lockfile || pnpm install --prod

# Copy built files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/packages/runs-client/dist ./packages/runs-client/dist
COPY --from=builder /app/openapi.json ./openapi.json

# Force IPv4 first to avoid IPv6 connection issues with Neon
ENV NODE_OPTIONS="--dns-result-order=ipv4first"

CMD ["node", "dist/index.js"]
