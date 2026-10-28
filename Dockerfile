# One container running the API and the web admin hub (see deploy/start.mjs).
FROM node:22-slim
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

COPY . .
# The mobile app isn't part of the server image.
RUN pnpm install --frozen-lockfile --filter "@pos/api..." --filter "@pos/web..."
RUN pnpm turbo run build --filter "@pos/api..." --filter "@pos/web..." \
 && cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static \
 && if [ -d apps/web/public ]; then cp -r apps/web/public apps/web/.next/standalone/apps/web/public; fi

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "deploy/start.mjs"]
