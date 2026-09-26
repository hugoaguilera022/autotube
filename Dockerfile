FROM node:24-alpine
WORKDIR /app
RUN apk add --no-cache python3 alpine-sdk git
RUN git clone --depth 1 https://github.com/imputnet/cobalt.git /tmp/cobalt
RUN cp -R /tmp/cobalt/api /app/api
WORKDIR /app/api
RUN corepack enable && pnpm install --frozen-lockfile
ENV API_LISTEN_ADDRESS=0.0.0.0
ENV API_PORT=10000
ENV API_URL=http://127.0.0.1:10000
ENV CORS_WILDCARD=0
CMD ["pnpm","start"]
