# Build dari root repo:  docker build -f apps/api/Dockerfile -t ff-api .
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/deadline-alarm/package.json packages/deadline-alarm/
COPY apps/api/package.json apps/api/
RUN npm ci
COPY packages/deadline-alarm packages/deadline-alarm
COPY apps/api apps/api
RUN npm run build -w @ff/deadline-alarm && npm run build -w @ff/api && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/deadline-alarm/package.json packages/deadline-alarm/
COPY --from=build /app/packages/deadline-alarm/dist packages/deadline-alarm/dist
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/dist/src apps/api/dist/src
COPY --from=build /app/apps/api/migrations apps/api/migrations
WORKDIR /app/apps/api
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/src/main.js"]
