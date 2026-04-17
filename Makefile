gateway:
	node --env-file-if-exists $(CURDIR)/.env --import tsx/esm apps/gateway/src/index.ts

echo-agent:
	node --import tsx/esm apps/echo-agent/src/index.ts

start-all:
	(npm run --prefix apps/gateway start & npm run --prefix apps/echo-agent start & wait)
