# syntax=docker/dockerfile:1
FROM oven/bun:1-slim AS base
WORKDIR /app

# Install system deps: git, gh CLI, claude CLI
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN bun add -g @anthropic-ai/claude-code

# ---- Server deps ----
FROM base AS server-deps
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production

# ---- UI build ----
FROM base AS ui-build
WORKDIR /app/ui
COPY ui/package.json ui/bun.lockb ./
RUN bun install --frozen-lockfile
COPY ui/ ./
RUN bun run build

# ---- Final image ----
FROM base AS final
WORKDIR /app

# Copy server source
COPY --from=server-deps /app/node_modules ./node_modules
COPY package.json bun.lockb tsconfig.json ./
COPY src/ ./src/

# Copy built SPA
COPY --from=ui-build /app/ui/dist ./ui/dist

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
