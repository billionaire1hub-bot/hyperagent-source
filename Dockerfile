# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY lib/package.json ./lib/
COPY artifacts/api-server/package.json ./artifacts/api-server/
RUN npm ci
COPY . .
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY lib/package.json ./lib/
COPY artifacts/api-server/package.json ./artifacts/api-server/
# --ignore-scripts: the build already ran in the build stage; postinstall would
# otherwise try to recompile without devDependencies present.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/lib/dist ./lib/dist
COPY --from=build /app/artifacts/api-server/dist ./artifacts/api-server/dist
RUN mkdir -p data logs
EXPOSE 12000
# The server starts its autonomous workers on boot; no extra command needed.
CMD ["node", "artifacts/api-server/dist/index.js"]
