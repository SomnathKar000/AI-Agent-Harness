FROM node:22-slim

ARG USER_UID=501
ARG USER_GID=501

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@latest

# Create agent group and user matching USER_UID and USER_GID
RUN if getent group "${USER_GID}" >/dev/null 2>&1; then \
      GROUP_NAME=$(getent group "${USER_GID}" | cut -d: -f1); \
    else \
      GROUP_NAME="agent"; \
      groupadd -g "${USER_GID}" agent; \
    fi && \
    if getent passwd "${USER_UID}" >/dev/null 2>&1; then \
      userdel -f $(getent passwd "${USER_UID}" | cut -d: -f1); \
    fi && \
    useradd -m -u "${USER_UID}" -g "${GROUP_NAME}" -s /bin/bash agent

# Setup workspace directory
RUN mkdir -p /workspace && chown -R ${USER_UID}:${USER_GID} /workspace

USER agent
WORKDIR /workspace
