# Campaign Service

Campaign CRUD and orchestration service for MCP Factory.

## Setup

```bash
pnpm install
```

## Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Required variables:
- `DATABASE_URL` - PostgreSQL connection string
- `RUNS_SERVICE_URL` - URL of runs-service
- `RUNS_SERVICE_API_KEY` - API key for runs-service
- `BILLING_SERVICE_URL` - URL of billing-service (credit-affordability pre-flight in the gate)
- `BILLING_SERVICE_API_KEY` - API key for billing-service
- `SENTRY_DSN` - Sentry DSN for error tracking (optional)

If `BILLING_SERVICE_URL` / `BILLING_SERVICE_API_KEY` are unset, the gate's credit-affordability
check fails open (the run is allowed) so a missing config never freezes campaigns.

## Development

```bash
pnpm dev
```

## Build

```bash
pnpm build
```

## Database

```bash
# Generate migrations
pnpm db:generate

# Run migrations
pnpm db:migrate

# Push schema directly (dev only)
pnpm db:push

# Open Drizzle Studio
pnpm db:studio
```

## Testing

```bash
# Run all tests
pnpm test

# Run unit tests only
pnpm test:unit

# Run integration tests only
pnpm test:integration
```

## Project Structure

```
├── src/
│   ├── db/           # Database schema and connection
│   ├── lib/          # Utility functions
│   ├── middleware/   # Express middleware
│   ├── routes/       # API routes
│   └── index.ts      # Entry point
├── packages/
│   └── runs-client/  # HTTP client for runs-service
├── drizzle/          # Database migrations
└── tests/            # Test files
```
