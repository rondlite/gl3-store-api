# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# migrate.ts resolves migrations relative to its own compiled location
# (dist/../migrations), so the SQL has to ship alongside dist.
COPY migrations ./migrations
COPY package.json ./

USER node
EXPOSE 8080

# Migrations are not run on boot: they are a separate `node dist/migrate.js`
# step so a rolling deploy cannot have N replicas racing to alter the schema.
CMD ["node", "dist/index.js"]
