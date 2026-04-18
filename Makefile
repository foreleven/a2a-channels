install:
	pnpm install

dev:
	(pnpm run gateway & pnpm run echo-agent & pnpm run web & wait)

gateway:
	node --env-file-if-exists $(CURDIR)/.env --import tsx/esm apps/gateway/src/index.ts

echo-agent:
	node --import tsx/esm apps/echo-agent/src/index.ts

web:
	pnpm --filter @a2a-channels/web dev

start-all:
	(pnpm run gateway & pnpm run echo-agent & pnpm run web & wait)
