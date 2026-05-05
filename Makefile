default_db_path := $(CURDIR)/db/a2a-channels.db
test_db_path := /tmp/test-a2a-store.db

.PHONY: install gateway-db-push gateway-test-db-push seed gateway-dev dev gateway echo-agent web start-all test

install:
	pnpm install

gateway-db-push:
	DB_PATH="$(or $(DB_PATH),$(default_db_path))" pnpm --dir apps/gateway db:push

gateway-db-gen:
	DB_PATH="$(or $(DB_PATH),$(default_db_path))" pnpm --dir apps/gateway db:generate

gateway-test-db-push:
	DB_PATH="$(test_db_path)" pnpm --dir apps/gateway db:push

seed: gateway-db-push
	DB_PATH="$(or $(DB_PATH),$(default_db_path))" node --env-file-if-exists $(CURDIR)/.env --import tsx/esm scripts/seed-defaults.ts

dev:
	node scripts/dev.mjs

gateway-dev:
	$(MAKE) gateway-db-push
	node --env-file-if-exists $(CURDIR)/.env --import tsx/esm apps/gateway/src/index.ts

gateway:
	$(MAKE) gateway-db-push
	node --env-file-if-exists $(CURDIR)/.env --import tsx/esm apps/gateway/src/index.ts

echo-agent:
	node --import tsx/esm apps/echo-agent/src/index.ts

web:
	pnpm --filter @a2a-channels/web dev

start-all:
	node scripts/dev.mjs

test:
	$(MAKE) gateway-test-db-push
	cd apps/gateway && XDG_CACHE_HOME=/tmp/a2a-cache DB_PATH="$(test_db_path)" NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test --test-force-exit $$(find src -name '*.test.ts' -print)
