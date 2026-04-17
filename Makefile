gateway:
	tsx --env-file $(CURDIR)/.env apps/gateway/src/index.ts

echo-agent:
	tsx apps/echo-agent/src/index.ts

start-all:
	(npm run --prefix apps/gateway start & npm run --prefix apps/echo-agent start & wait)
