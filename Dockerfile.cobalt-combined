FROM node:22-bookworm
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.6.0 --activate
ENV BUN_INSTALL=/opt/bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/opt/bun/bin:${PATH}"
WORKDIR /opt
RUN git clone --depth 1 https://github.com/imputnet/cobalt.git cobalt
RUN cd /opt/cobalt && pnpm install --frozen-lockfile
RUN git clone --depth 1 https://github.com/idMJA/youtube-trusted-session-generator.git yt-session
RUN cd /opt/yt-session && bun install
COPY cobalt-combined-start.sh /opt/cobalt-combined-start.sh
RUN chmod +x /opt/cobalt-combined-start.sh
ENV PORT=10000
ENV API_URL=https://autotube-cobalt-combined.onrender.com/
ENV YOUTUBE_SESSION_SERVER=http://127.0.0.1:3000/token
ENV YOUTUBE_SESSION_INNERTUBE_CLIENT=WEB_EMBEDDED
ENV YOUTUBE_ALLOW_BETTER_AUDIO=1
ENV FORCE_LOCAL_PROCESSING=always
CMD ["/opt/cobalt-combined-start.sh"]
