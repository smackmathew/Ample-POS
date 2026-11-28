# The Migration Assistant: a Windows app stores download from Import & export.
# Built on Linux (EnableWindowsTargeting), tested first.
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS assistant
WORKDIR /src
COPY apps/migration-assistant/ .
RUN dotnet test tests/AmpleMigration.Tests -c Release \
 && dotnet publish src/AmpleMigration.App -c Release -o /out

# One container running the API and the web admin hub (see deploy/start.mjs).
FROM node:22-slim
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

COPY . .
COPY --from=assistant /out/AmplePOS-Migration-Assistant.exe apps/web/public/downloads/AmplePOS-Migration-Assistant.exe
# The mobile app isn't part of the server image.
RUN pnpm install --frozen-lockfile --filter "@pos/api..." --filter "@pos/web..."
# Then merge public/ into the server bundle. Next may already have put public/downloads there (the import
# page checks for the Assistant's file), and "cp -r public dest" would then nest it as public/public.
RUN pnpm turbo run build --filter "@pos/api..." --filter "@pos/web..." \
 && cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static \
 && mkdir -p apps/web/.next/standalone/apps/web/public \
 && cp -r apps/web/public/. apps/web/.next/standalone/apps/web/public/

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "deploy/start.mjs"]
