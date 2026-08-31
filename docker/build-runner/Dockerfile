ARG DOCKER_CLI_IMAGE=docker:28.5.2-cli
ARG NODE_IMAGE=node:22.22.2-bookworm

FROM ${DOCKER_CLI_IMAGE} AS docker_cli

FROM ${NODE_IMAGE}

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git iproute2 openssl procps \
  && rm -rf /var/lib/apt/lists/*

COPY --from=docker_cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker_cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins

ENV COREPACK_HOME=/opt/corepack \
    PNPM_HOME=/opt/pnpm \
    PNPM_STORE_DIR=/pnpm-store \
    PATH=/opt/pnpm:/opt/corepack:${PATH}

RUN mkdir -p "$COREPACK_HOME" "$PNPM_HOME" "$PNPM_STORE_DIR" /workspace \
  && corepack enable \
  && corepack prepare pnpm@11.9.0 --activate

COPY docker/build-runner/entrypoint.sh /usr/local/bin/zhiying-build-runner
RUN chmod 0755 /usr/local/bin/zhiying-build-runner

ENTRYPOINT ["/usr/local/bin/zhiying-build-runner"]
