FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY package-lock.json ./
RUN npm ci --fetch-retries=4 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=10000
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["npm", "run", "start"]
